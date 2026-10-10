/**
 * Reads an influencer website's RSS or Atom feed, so the posts on the site
 * can become creator calls the same way YouTube videos do.
 *
 * Everything here is bounded:
 * - every HTTP request (robots.txt, homepage, feed candidates, redirects and
 *   the rare article page) counts against a per-site request cap;
 * - every response body is read up to a byte cap and every request has a
 *   timeout;
 * - URLs must be public http(s) (the webhook SSRF guard, plus a DNS check),
 *   redirects are followed by hand, at most WEB_FEED_MAX_REDIRECTS, each one
 *   checked again;
 * - robots.txt is honored for every path fetched (user-agent `SentimentBot`,
 *   else `*`); a disallowed path is never requested.
 *
 * Article pages are fetched only when the feed carries titles but no text, at
 * most WEB_FEED_MAX_ARTICLE_FETCHES per site per run. Nothing here stores
 * text; the ingest step keeps only bounded excerpts around card names.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { assertResolvedAddressesPublic, parseWebhookUrl, WebhookUrlRejectedError, type DnsLookup } from "../webhooks/ssrf.js";
import type { HttpHeaders, HttpResponse, HttpTransport } from "./transport.js";

export const WEB_FEED_BOT_TOKEN = "SentimentBot";
export const WEB_FEED_TIMEOUT_MS = 10_000;
export const WEB_FEED_MAX_BODY_BYTES = 2_000_000;
export const WEB_FEED_MAX_ROBOTS_BYTES = 512_000;
export const WEB_FEED_MAX_REDIRECTS = 3;
export const WEB_FEED_MAX_REQUESTS_PER_SITE = 10;
export const WEB_FEED_MAX_ITEMS = 20;
export const WEB_FEED_MAX_ARTICLE_FETCHES = 3;
/** Text kept in memory per post for detection; never stored. */
export const WEB_FEED_MAX_POST_TEXT_CHARS = 60_000;
export const WEB_FEED_FALLBACK_PATHS = ["/feed", "/rss.xml", "/feed.xml", "/atom.xml", "/index.xml"] as const;

const FEED_TYPES = ["application/rss+xml", "application/atom+xml"];
const TRUNCATED_HEADER = "x-sentiment-truncated";

export function webFeedUserAgent(env: NodeJS.ProcessEnv = process.env): string {
  const app = env.APP_URL?.trim();
  let contact = "";
  if (app) {
    try {
      contact = ` (+${new URL(app).origin})`;
    } catch {
      contact = "";
    }
  }
  return `${WEB_FEED_BOT_TOKEN}/1.0${contact} card-market research; reads RSS/Atom feeds and honors robots.txt`;
}

// ---------------------------------------------------------------------------
// Text helpers

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  eacute: "é",
  egrave: "è",
  aacute: "á",
  iacute: "í",
  oacute: "ó",
  uacute: "ú",
  ntilde: "ñ",
  uuml: "ü",
  ouml: "ö",
  auml: "ä",
  times: "×",
  bull: "•",
  middot: "·",
  deg: "°",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
};

/** Decodes numeric and common named entities. Unknown entities are kept as written. */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,15});/gi, (match, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : " ";
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

const BLOCK_TAGS =
  "p|div|li|ul|ol|h[1-6]|tr|table|blockquote|section|article|header|footer|figure|figcaption|pre|dd|dt|hr|aside|main";

/**
 * Plain text of an HTML fragment. Scripts, styles and comments are dropped;
 * block elements become paragraph breaks (blank lines). Never executes or
 * renders anything.
 */
export function htmlToText(html: string, maxChars = WEB_FEED_MAX_POST_TEXT_CHARS): string {
  const text = html
    .slice(0, maxChars * 4)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|iframe|form|nav)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), "\n\n")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxChars);
}

/** Paragraphs of plain text from htmlToText: blank-line separated, single line breaks joined. */
export function textParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").trim())
    .filter((paragraph) => paragraph.length > 0);
}

// ---------------------------------------------------------------------------
// Minimal XML reader (RSS 2.0, RSS 1.0 and Atom need only elements, attributes,
// text and CDATA). DOCTYPE internal subsets and entity declarations are
// skipped, never expanded; only the predefined and numeric entities decode.

export type XmlElement = { name: string; attrs: Record<string, string>; children: Array<XmlElement | string> };

const MAX_XML_NODES = 50_000;
const MAX_XML_DEPTH = 64;

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of source.matchAll(/([^\s=/"'<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[match[1]!.toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? "");
  }
  return attrs;
}

/** Index just past the `>` that closes the tag starting at `from`, skipping quoted attribute values. */
function tagEnd(xml: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < xml.length; i += 1) {
    const ch = xml[i]!;
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i + 1;
    }
  }
  return -1;
}

/** Lenient XML parse into a small element tree. Unclosed elements are closed at the end. Null when nothing parses. */
export function parseXml(xml: string): XmlElement | null {
  const root: XmlElement = { name: "#document", attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  let nodes = 0;
  let i = 0;
  const append = (text: string) => {
    if (!text) return;
    const top = stack[stack.length - 1]!;
    const last = top.children[top.children.length - 1];
    if (typeof last === "string") top.children[top.children.length - 1] = last + text;
    else top.children.push(text);
  };
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      append(decodeEntities(xml.slice(i)));
      break;
    }
    if (lt > i) append(decodeEntities(xml.slice(i, lt)));
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end === -1 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      append(xml.slice(lt + 9, end === -1 ? xml.length : end));
      i = end === -1 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      i = end === -1 ? xml.length : end + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      // DOCTYPE, possibly with an internal subset: skipped, never expanded.
      const bracket = xml.indexOf("[", lt);
      const close = xml.indexOf(">", lt);
      if (bracket !== -1 && close !== -1 && bracket < close) {
        const end = xml.indexOf("]>", bracket);
        i = end === -1 ? xml.length : end + 2;
      } else {
        i = close === -1 ? xml.length : close + 1;
      }
      continue;
    }
    const end = tagEnd(xml, lt + 1);
    if (end === -1) break;
    const inner = xml.slice(lt + 1, end - 1);
    i = end;
    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim().toLowerCase();
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth]!.name === name) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }
    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameMatch = body.match(/^\s*([^\s/>]+)/);
    if (!nameMatch) continue;
    nodes += 1;
    if (nodes > MAX_XML_NODES) break;
    const element: XmlElement = {
      name: nameMatch[1]!.toLowerCase(),
      attrs: parseAttributes(body.slice(nameMatch[0].length)),
      children: [],
    };
    stack[stack.length - 1]!.children.push(element);
    if (!selfClosing && stack.length < MAX_XML_DEPTH) stack.push(element);
  }
  const first = root.children.find((child): child is XmlElement => typeof child !== "string");
  return first ?? null;
}

function elements(node: XmlElement): XmlElement[] {
  return node.children.filter((child): child is XmlElement => typeof child !== "string");
}

function child(node: XmlElement, ...names: string[]): XmlElement | undefined {
  for (const name of names) {
    const found = elements(node).find((element) => element.name === name);
    if (found) return found;
  }
  return undefined;
}

/** Text content of an element, its descendants included, in document order. */
export function xmlText(node: XmlElement | undefined): string {
  if (!node) return "";
  return node.children.map((part) => (typeof part === "string" ? part : xmlText(part))).join("");
}

function clean(value: string | undefined, max: number): string | null {
  const text = value?.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

export type FeedItem = {
  /** guid (RSS) or id (Atom). */
  id: string | null;
  link: string | null;
  title: string | null;
  publishedAt: Date | null;
  author: string | null;
  /** HTML (or text) of content:encoded / content, else description / summary. Never stored. */
  html: string | null;
};

export type ParsedFeed = { format: "rss" | "atom"; title: string | null; items: FeedItem[] };

function parseDate(value: string | undefined): Date | null {
  const raw = value?.trim();
  if (!raw) return null;
  const time = Date.parse(raw);
  return Number.isFinite(time) ? new Date(time) : null;
}

function resolveLink(value: string | null | undefined, base: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = base ? new URL(raw, base) : new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function rssItem(item: XmlElement, base: string | undefined): FeedItem {
  const encoded = xmlText(child(item, "content:encoded"));
  const description = xmlText(child(item, "description"));
  const guid = clean(xmlText(child(item, "guid")), 500);
  const link =
    resolveLink(xmlText(child(item, "link")), base) ??
    (child(item, "guid")?.attrs.ispermalink !== "false" ? resolveLink(guid, base) : null);
  return {
    id: guid,
    link,
    title: clean(htmlToText(xmlText(child(item, "title")), 1_000), 500),
    publishedAt: parseDate(xmlText(child(item, "pubdate", "dc:date", "published", "updated"))),
    author: clean(xmlText(child(item, "dc:creator", "author")), 200),
    html: encoded.trim() ? encoded : description.trim() ? description : null,
  };
}

function atomLink(entry: XmlElement, base: string | undefined): string | null {
  const links = elements(entry).filter((element) => element.name === "link");
  const alternate =
    links.find((link) => (link.attrs.rel ?? "alternate") === "alternate" && (!link.attrs.type || link.attrs.type.includes("html"))) ??
    links.find((link) => (link.attrs.rel ?? "alternate") === "alternate");
  return resolveLink(alternate?.attrs.href, base);
}

function atomBody(element: XmlElement | undefined): string | null {
  if (!element) return null;
  const type = (element.attrs.type ?? "text").toLowerCase();
  if (type === "xhtml") {
    // Inline XHTML: keep paragraph breaks between block children.
    const blocks = (node: XmlElement): string =>
      node.children
        .map((part) =>
          typeof part === "string"
            ? part
            : new RegExp(`^(?:[a-z]+:)?(?:${BLOCK_TAGS}|br)$`).test(part.name)
              ? `<p>${blocks(part)}</p>`
              : blocks(part),
        )
        .join("");
    const html = blocks(element);
    return html.trim() ? html : null;
  }
  const text = xmlText(element);
  if (!text.trim()) return null;
  // Plain text is escaped so htmlToText leaves it as written.
  return type === "html" || type.includes("html") ? text : text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/** RSS 2.0, RSS 1.0 (RDF) or Atom. Null when the document is none of these. */
export function parseFeed(xml: string, baseUrl?: string): ParsedFeed | null {
  const root = parseXml(xml);
  if (!root) return null;
  if (root.name === "rss" || root.name === "rdf:rdf") {
    const channel = child(root, "channel");
    const items = [
      ...(channel ? elements(channel).filter((element) => element.name === "item") : []),
      ...elements(root).filter((element) => element.name === "item"),
    ];
    return {
      format: "rss",
      title: clean(xmlText(channel ? child(channel, "title") : undefined), 300),
      items: items.map((item) => rssItem(item, baseUrl)),
    };
  }
  if (root.name === "feed") {
    const entries = elements(root).filter((element) => element.name === "entry");
    return {
      format: "atom",
      title: clean(htmlToText(xmlText(child(root, "title")), 600), 300),
      items: entries.map((entry) => ({
        id: clean(xmlText(child(entry, "id")), 500),
        link: atomLink(entry, baseUrl),
        title: clean(htmlToText(xmlText(child(entry, "title")), 1_000), 500),
        publishedAt: parseDate(xmlText(child(entry, "published", "updated", "issued"))),
        author: clean(xmlText(child(child(entry, "author") ?? entry, "name")), 200),
        html: atomBody(child(entry, "content")) ?? atomBody(child(entry, "summary")),
      })),
    };
  }
  return null;
}

/** Feed URLs a page advertises with `<link rel="alternate" type="application/rss+xml|atom+xml" href>`, in page order. */
export function discoverFeedLinks(html: string, baseUrl: string): string[] {
  const found: string[] = [];
  const head = html.slice(0, 500_000);
  for (const match of head.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0].slice(5).replace(/\/?>$/, ""));
    const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
    const type = (attrs.type ?? "").toLowerCase().split(";")[0]!.trim();
    if (!rel.includes("alternate") || !FEED_TYPES.includes(type)) continue;
    const href = resolveLink(attrs.href, baseUrl);
    if (href && !found.includes(href) && !/\/comments\/feed\/?$/i.test(new URL(href).pathname)) found.push(href);
  }
  return found;
}

/** Visible text of an article page: the `<article>` or `<main>` element when there is one, else the body. */
export function articleText(html: string): string {
  const pick =
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ??
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ??
    html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ??
    html;
  return htmlToText(pick);
}

// ---------------------------------------------------------------------------
// robots.txt (RFC 9309)

export type RobotsRule = { allow: boolean; pattern: string };
export type RobotsGroup = { agents: string[]; rules: RobotsRule[] };

export function parseRobotsTxt(text: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.slice(0, WEB_FEED_MAX_ROBOTS_BYTES).split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const match = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!match) continue;
    const field = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === "allow" || field === "disallow") {
      if (value === "") continue; // An empty Disallow allows everything.
      current.rules.push({ allow: field === "allow", pattern: value });
    }
  }
  return groups;
}

function ruleMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const regex = body
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${regex}${anchored ? "$" : ""}`).test(path);
}

function percentDecodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Whether `agent` may fetch `path` (path plus query). The group naming the
 * agent wins over `*`; within it the longest matching rule wins and Allow wins
 * a tie. No matching group or rule means allowed.
 */
export function robotsAllows(groups: RobotsGroup[], agent: string, path: string): boolean {
  const token = agent.toLowerCase();
  const specific = groups.filter((group) => group.agents.some((name) => name !== "*" && name.split("/")[0]!.trim() === token));
  const chosen = specific.length > 0 ? specific : groups.filter((group) => group.agents.includes("*"));
  const rules = chosen.flatMap((group) => group.rules);
  const target = percentDecodeSafe(path || "/");
  let best: RobotsRule | null = null;
  for (const rule of rules) {
    if (!ruleMatches(percentDecodeSafe(rule.pattern), target)) continue;
    if (
      !best ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

/** `Sitemap:` URLs listed in robots.txt (they apply to every user agent), in file order. */
export function robotsSitemaps(text: string): string[] {
  const found: string[] = [];
  for (const rawLine of text.slice(0, WEB_FEED_MAX_ROBOTS_BYTES).split(/\r\n|\r|\n/)) {
    const match = rawLine.replace(/#.*$/, "").trim().match(/^sitemap\s*:\s*(\S+)$/i);
    if (!match) continue;
    try {
      const url = new URL(match[1]!);
      if ((url.protocol === "https:" || url.protocol === "http:") && !found.includes(url.toString())) found.push(url.toString());
    } catch {
      // ignored
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Sitemaps and article pages (sitemap backfill)

export type SitemapEntry = { loc: string; lastmod: Date | null };
export type ParsedSitemap = { kind: "index" | "urlset"; entries: SitemapEntry[] };

function localName(name: string) {
  const colon = name.lastIndexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/** A sitemap index or URL set (sitemaps.org). Null when the document is neither. */
export function parseSitemap(xml: string, baseUrl?: string): ParsedSitemap | null {
  const root = parseXml(xml);
  if (!root) return null;
  const rootName = localName(root.name);
  if (rootName !== "sitemapindex" && rootName !== "urlset") return null;
  const childName = rootName === "sitemapindex" ? "sitemap" : "url";
  const entries: SitemapEntry[] = [];
  for (const element of elements(root)) {
    if (localName(element.name) !== childName) continue;
    const field = (name: string) => elements(element).find((part) => localName(part.name) === name);
    const loc = resolveLink(xmlText(field("loc")).trim(), baseUrl);
    if (!loc) continue;
    entries.push({ loc, lastmod: parseDate(xmlText(field("lastmod"))) });
  }
  return { kind: rootName === "sitemapindex" ? "index" : "urlset", entries };
}

const PUBLISHED_META_NAMES = [
  "article:published_time",
  "og:article:published_time",
  "datepublished",
  "publishdate",
  "pubdate",
  "dc.date.issued",
  "dc.date",
  "date",
  "parsely-pub-date",
  "sailthru.date",
];

/**
 * Title and publication time of an article page: the publication meta tags,
 * then JSON-LD `datePublished`, then the first `<time datetime>` inside
 * `<article>`. Modification dates are never used, so a post edited later is
 * not dated later. Null when the page states no publication time.
 */
export function articleMetadata(html: string): { title: string | null; publishedAt: Date | null } {
  const head = html.slice(0, 1_000_000);
  const metas = new Map<string, string>();
  for (const match of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseAttributes(match[0].slice(5).replace(/\/?>$/, ""));
    const key = (attrs.property ?? attrs.name ?? attrs.itemprop ?? "").toLowerCase();
    if (key && attrs.content && !metas.has(key)) metas.set(key, attrs.content);
  }
  let publishedAt: Date | null = null;
  for (const key of PUBLISHED_META_NAMES) {
    publishedAt = parseDate(metas.get(key));
    if (publishedAt) break;
  }
  if (!publishedAt) {
    for (const match of head.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      const found = match[1]!.match(/"datePublished"\s*:\s*"([^"]{8,40})"/);
      publishedAt = parseDate(found?.[1]);
      if (publishedAt) break;
    }
  }
  if (!publishedAt) {
    const article = head.match(/<article\b[\s\S]*?<\/article>/i)?.[0] ?? "";
    const time = article.match(/<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i);
    publishedAt = parseDate(time?.[1]);
  }
  const rawTitle =
    metas.get("og:title") ?? head.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? head.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const title = rawTitle ? clean(htmlToText(rawTitle, 1_000), 300) : null;
  if (publishedAt && (publishedAt.getTime() < Date.parse("2000-01-01T00:00:00Z") || !Number.isFinite(publishedAt.getTime()))) {
    publishedAt = null;
  }
  return { title, publishedAt };
}

// ---------------------------------------------------------------------------
// HTTP

export class WebFeedRequestError extends Error {
  constructor(readonly errorClass: string) {
    super(errorClass);
    this.name = "WebFeedRequestError";
  }
}

/**
 * A transport for website requests: no automatic redirects (the client checks
 * each hop), a timeout, and a body read up to `maxBytes` (a longer body is cut
 * and marked with the `x-sentiment-truncated` header).
 */
export function createWebFeedTransport(input?: {
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}): HttpTransport {
  const timeoutMs = input?.timeoutMs ?? WEB_FEED_TIMEOUT_MS;
  const maxBytes = input?.maxBytes ?? WEB_FEED_MAX_BODY_BYTES;
  const fetchImpl = input?.fetchImpl ?? fetch;
  return {
    async fetch(url, init) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url, {
          method: init?.method ?? "GET",
          headers: init?.headers,
          redirect: "manual",
          signal: controller.signal,
        });
        const headers: HttpHeaders = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        const declared = Number(headers["content-length"] ?? "");
        if (Number.isFinite(declared) && declared > maxBytes * 4) {
          controller.abort();
          return { status: response.status, headers: { ...headers, [TRUNCATED_HEADER]: "1" }, bodyText: "" };
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        let truncated = false;
        const reader = response.body?.getReader();
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (size + value.byteLength > maxBytes) {
              chunks.push(value.subarray(0, maxBytes - size));
              size = maxBytes;
              truncated = true;
              await reader.cancel().catch(() => undefined);
              break;
            }
            chunks.push(value);
            size += value.byteLength;
          }
        }
        const body = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        if (truncated) headers[TRUNCATED_HEADER] = "1";
        return { status: response.status, headers, bodyText: new TextDecoder("utf-8").decode(body) };
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        throw new WebFeedRequestError(name === "AbortError" ? "timeout" : "network");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

const defaultLookup: DnsLookup = async (hostname) => {
  const rows = await dnsLookup(hostname, { all: true, verbatim: true });
  return rows.map((row) => row.address);
};

type FetchOutcome =
  | { kind: "ok"; url: string; response: HttpResponse }
  | { kind: "blocked"; reason: "robots" | "url_rejected" | "request_cap" | "redirect_limit" };

/**
 * One site's HTTP budget: counts requests, caches robots.txt per origin for
 * the run, checks every URL (and redirect hop) is public and allowed.
 */
export class WebFeedClient {
  requests = 0;
  private readonly robots = new Map<string, RobotsGroup[] | "unreachable">();
  private readonly sitemaps = new Map<string, string[]>();

  constructor(
    private readonly options: {
      transport?: HttpTransport;
      lookup?: DnsLookup | null;
      env?: NodeJS.ProcessEnv;
      maxRequests?: number;
      userAgent?: string;
    } = {},
  ) {}

  get maxRequests() {
    return this.options.maxRequests ?? WEB_FEED_MAX_REQUESTS_PER_SITE;
  }

  get remaining() {
    return Math.max(0, this.maxRequests - this.requests);
  }

  private get transport() {
    return this.options.transport ?? (this.options.transport = createWebFeedTransport());
  }

  private get userAgent() {
    return this.options.userAgent ?? webFeedUserAgent(this.options.env);
  }

  /** Throws WebhookUrlRejectedError when the URL is not a public http(s) address. */
  async assertPublic(url: string): Promise<URL> {
    const parsed = parseWebhookUrl(url, this.options.env ?? process.env);
    const lookup = this.options.lookup === undefined ? defaultLookup : this.options.lookup;
    if (lookup) {
      let addresses: string[];
      try {
        addresses = await lookup(parsed.hostname);
      } catch {
        throw new WebhookUrlRejectedError("Host could not be resolved.");
      }
      assertResolvedAddressesPublic(addresses);
    }
    return parsed;
  }

  private async send(url: string, headers: HttpHeaders): Promise<HttpResponse | null> {
    if (this.requests >= this.maxRequests) return null;
    this.requests += 1;
    return this.transport.fetch(url, { headers: { "user-agent": this.userAgent, ...headers } });
  }

  /** robots.txt rules for an origin, fetched once per run. 4xx means no rules; 5xx or network failure means unreachable. */
  async robotsFor(origin: string): Promise<RobotsGroup[] | "unreachable" | "request_cap"> {
    const cached = this.robots.get(origin);
    if (cached) return cached;
    let response: HttpResponse | null;
    try {
      response = await this.send(`${origin}/robots.txt`, { accept: "text/plain, */*;q=0.1" });
    } catch {
      this.robots.set(origin, "unreachable");
      return "unreachable";
    }
    if (!response) return "request_cap";
    let rules: RobotsGroup[] | "unreachable";
    if (response.status >= 200 && response.status < 300) {
      rules = parseRobotsTxt(response.bodyText);
      this.sitemaps.set(origin, robotsSitemaps(response.bodyText));
    } else if (response.status >= 300 && response.status < 500) rules = [];
    else rules = "unreachable";
    this.robots.set(origin, rules);
    return rules;
  }

  /** `Sitemap:` URLs from the origin's robots.txt (fetched when not cached). */
  async sitemapsFor(origin: string): Promise<string[] | "request_cap" | "unreachable"> {
    if (!this.robots.has(origin)) {
      // Same SSRF check as get(): robots.txt is never requested from a non-public host.
      try {
        await this.assertPublic(`${origin}/robots.txt`);
      } catch (error) {
        if (error instanceof WebhookUrlRejectedError) return "unreachable";
        throw error;
      }
    }
    const rules = await this.robotsFor(origin);
    if (rules === "request_cap" || rules === "unreachable") return rules;
    return this.sitemaps.get(origin) ?? [];
  }

  /** Whether robots.txt lets SentimentBot fetch this URL (fetches robots.txt when not cached). */
  async allowed(url: string): Promise<boolean | "request_cap"> {
    const parsed = new URL(url);
    const rules = await this.robotsFor(parsed.origin);
    if (rules === "request_cap") return "request_cap";
    if (rules === "unreachable") return false;
    return robotsAllows(rules, WEB_FEED_BOT_TOKEN, `${parsed.pathname}${parsed.search}`);
  }

  /** GET with manual, re-checked redirects. Each hop is a request against the cap. */
  async get(url: string, headers: HttpHeaders = {}): Promise<FetchOutcome> {
    let current = url;
    for (let hop = 0; hop <= WEB_FEED_MAX_REDIRECTS; hop += 1) {
      try {
        await this.assertPublic(current);
      } catch (error) {
        if (error instanceof WebhookUrlRejectedError) return { kind: "blocked", reason: "url_rejected" };
        throw error;
      }
      const allowed = await this.allowed(current);
      if (allowed === "request_cap") return { kind: "blocked", reason: "request_cap" };
      if (!allowed) return { kind: "blocked", reason: "robots" };
      const response = await this.send(current, headers);
      if (!response) return { kind: "blocked", reason: "request_cap" };
      const location = response.headers.location ?? response.headers.Location;
      if (response.status >= 300 && response.status < 400 && response.status !== 304 && location) {
        try {
          current = new URL(location, current).toString();
        } catch {
          return { kind: "blocked", reason: "url_rejected" };
        }
        continue;
      }
      return { kind: "ok", url: current, response };
    }
    return { kind: "blocked", reason: "redirect_limit" };
  }
}

// ---------------------------------------------------------------------------
// Reading one site

export type WebFeedSiteInput = {
  siteUrl: string;
  feedUrl: string | null;
  /** Validators from the last successful read of `feedUrl`. */
  etag?: string | null;
  lastModified?: string | null;
};

export type WebFeedPost = FeedItem & { text: string; textSource: "feed" | "article" | "none" };

export type WebFeedReadResult =
  | {
      status: "ok";
      feedUrl: string;
      format: "rss" | "atom";
      etag: string | null;
      lastModified: string | null;
      truncated: boolean;
      posts: WebFeedPost[];
    }
  | { status: "not_modified"; feedUrl: string; etag: string | null; lastModified: string | null }
  | {
      status: "skipped";
      reason: "robots" | "no_feed" | "url_rejected";
      feedUrl: string | null;
    }
  | {
      status: "failed";
      reason: "request_cap" | "redirect_limit" | "rate_limited" | "http_error" | "invalid_feed" | "timeout" | "network";
      feedUrl: string | null;
    };

function looksLikeFeed(response: HttpResponse): boolean {
  const type = (response.headers["content-type"] ?? "").toLowerCase();
  const head = response.bodyText.slice(0, 2_000).toLowerCase();
  return /xml|rss|atom/.test(type) || /<rss\b|<feed\b|<rdf:rdf\b/.test(head);
}

/**
 * Finds and reads a site's feed. Uses the known feed URL when there is one;
 * otherwise reads the homepage for `<link rel="alternate">` feeds, then tries
 * the common feed paths. Sends If-None-Match / If-Modified-Since when it has
 * validators for the feed URL. Posts without text get their article page
 * read, at most WEB_FEED_MAX_ARTICLE_FETCHES of them.
 */
export async function readWebFeed(client: WebFeedClient, site: WebFeedSiteInput): Promise<WebFeedReadResult> {
  try {
    return await readWebFeedUnsafe(client, site);
  } catch (error) {
    if (error instanceof WebFeedRequestError) {
      return { status: "failed", reason: error.errorClass === "timeout" ? "timeout" : "network", feedUrl: site.feedUrl };
    }
    throw error;
  }
}

function blockedResult(reason: "robots" | "url_rejected" | "request_cap" | "redirect_limit", feedUrl: string | null): WebFeedReadResult {
  return reason === "robots" || reason === "url_rejected"
    ? { status: "skipped", reason, feedUrl }
    : { status: "failed", reason, feedUrl };
}

async function readWebFeedUnsafe(client: WebFeedClient, site: WebFeedSiteInput): Promise<WebFeedReadResult> {
  const accept = "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.1";
  let feed: { url: string; response: HttpResponse } | null = null;

  if (site.feedUrl) {
    const conditional: HttpHeaders = { accept };
    if (site.etag) conditional["if-none-match"] = site.etag;
    if (site.lastModified) conditional["if-modified-since"] = site.lastModified;
    const got = await client.get(site.feedUrl, conditional);
    if (got.kind === "blocked") return blockedResult(got.reason, site.feedUrl);
    if (got.response.status === 304) {
      return { status: "not_modified", feedUrl: site.feedUrl, etag: site.etag ?? null, lastModified: site.lastModified ?? null };
    }
    if (got.response.status === 429) return { status: "failed", reason: "rate_limited", feedUrl: site.feedUrl };
    if (got.response.status >= 200 && got.response.status < 300 && looksLikeFeed(got.response)) {
      feed = { url: got.url, response: got.response };
    }
    // A stored feed URL that stopped working falls through to discovery.
  }

  if (!feed) {
    const candidates: string[] = [];
    const home = await client.get(site.siteUrl, { accept: "text/html, application/xhtml+xml, */*;q=0.1" });
    if (home.kind === "blocked") {
      if (home.reason === "request_cap" || home.reason === "url_rejected") return blockedResult(home.reason, null);
      // A disallowed homepage still allows trying the common feed paths below.
    } else if (home.response.status === 429) {
      return { status: "failed", reason: "rate_limited", feedUrl: null };
    } else if (home.response.status >= 200 && home.response.status < 300) {
      if (looksLikeFeed(home.response) && parseFeed(home.response.bodyText, home.url)) {
        feed = { url: home.url, response: home.response };
      } else {
        candidates.push(...discoverFeedLinks(home.response.bodyText, home.url));
      }
    }
    const origin = new URL(site.siteUrl).origin;
    for (const path of WEB_FEED_FALLBACK_PATHS) {
      const url = `${origin}${path}`;
      if (!candidates.includes(url)) candidates.push(url);
    }
    let sawRobots = false;
    for (const candidate of candidates) {
      if (feed) break;
      if (client.remaining === 0) return { status: "failed", reason: "request_cap", feedUrl: null };
      const got = await client.get(candidate, { accept });
      if (got.kind === "blocked") {
        if (got.reason === "robots") {
          sawRobots = true;
          continue;
        }
        if (got.reason === "url_rejected") continue;
        return blockedResult(got.reason, null);
      }
      if (got.response.status === 429) return { status: "failed", reason: "rate_limited", feedUrl: candidate };
      if (got.response.status >= 200 && got.response.status < 300 && looksLikeFeed(got.response)) {
        feed = { url: got.url, response: got.response };
      }
    }
    if (!feed) return sawRobots ? { status: "skipped", reason: "robots", feedUrl: null } : { status: "skipped", reason: "no_feed", feedUrl: null };
  }

  const parsed = parseFeed(feed.response.bodyText, feed.url);
  if (!parsed) return { status: "failed", reason: "invalid_feed", feedUrl: feed.url };
  const now = Date.now();
  const items = parsed.items
    .filter((item) => item.link || item.id)
    .map((item) => ({ ...item, publishedAt: item.publishedAt && item.publishedAt.getTime() <= now ? item.publishedAt : null }))
    .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0))
    .slice(0, WEB_FEED_MAX_ITEMS);

  const posts: WebFeedPost[] = [];
  let articleFetches = 0;
  for (const item of items) {
    const text = item.html ? htmlToText(item.html) : "";
    if (text) {
      posts.push({ ...item, text, textSource: "feed" });
      continue;
    }
    // Title-only feed: read the article page itself, within the same bounds.
    if (item.link && articleFetches < WEB_FEED_MAX_ARTICLE_FETCHES && client.remaining > 0) {
      articleFetches += 1;
      const got = await client.get(item.link, { accept: "text/html, application/xhtml+xml, */*;q=0.1" });
      if (got.kind === "ok" && got.response.status >= 200 && got.response.status < 300) {
        const body = articleText(got.response.bodyText);
        if (body) {
          posts.push({ ...item, text: body, textSource: "article" });
          continue;
        }
      }
    }
    posts.push({ ...item, text: "", textSource: "none" });
  }
  return {
    status: "ok",
    feedUrl: feed.url,
    format: parsed.format,
    etag: feed.response.headers.etag ?? null,
    lastModified: feed.response.headers["last-modified"] ?? null,
    truncated: feed.response.headers[TRUNCATED_HEADER] === "1",
    posts,
  };
}
