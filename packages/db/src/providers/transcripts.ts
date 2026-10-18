/**
 * Transcript fetchers for YouTube videos.
 *
 * Validation state: fixture-tested only. Neither adapter has been
 * hosted-validated against the live services, and both are disabled unless
 * TRANSCRIPT_PROVIDER selects one.
 *
 * - `YoutubeCaptionFetcher` (TRANSCRIPT_PROVIDER=youtube_captions) reads the
 *   captions YouTube already publishes for a video (manual or auto-generated).
 *   It uses YouTube's unofficial web endpoints (the watch page and the
 *   timedtext track it links to), NOT the YouTube Data API, which cannot
 *   download captions for other people's videos. The owner accepted this.
 *   YouTube may block these requests from cloud IP ranges (consent or "confirm
 *   you're not a bot" pages); that is reported as `rate_limited` with reason
 *   `blocked` so the worker stops for the day instead of hammering. At most two
 *   requests are made per video.
 * - `SupadataTranscriptFetcher` (TRANSCRIPT_PROVIDER=supadata, with
 *   SUPADATA_API_KEY) is an optional paid backup behind the same interface. Its
 *   request and response shape (GET /v1/youtube/transcript, `x-api-key`
 *   header, `{content:[{text, offset, duration, lang}], lang, availableLangs}`
 *   with millisecond offsets) is written from memory and could not be checked
 *   against the vendor from the build sandbox, so it is parsed defensively.
 *
 * Callers only ever keep bounded excerpts of the cues (see
 * source/transcript-ingest.ts); full transcripts are never stored. No URL,
 * header or API key is ever logged or returned in a reason.
 */
import { ProviderHttpError, createFetchTransport, type HttpResponse, type HttpTransport } from "./transport.js";

export type TranscriptCue = { text: string; offsetMs: number; durationMs: number };

export type TranscriptResult =
  | { status: "ok"; lang: string; cues: TranscriptCue[]; trackKind: "manual" | "asr" | "unknown" }
  | { status: "unavailable"; reason?: string }
  | { status: "rate_limited"; reason: string }
  | { status: "error"; reason: string };

export const TRANSCRIPT_PROVIDERS = ["youtube_captions", "supadata"] as const;
export type TranscriptProviderKey = (typeof TRANSCRIPT_PROVIDERS)[number];

export type TranscriptFetcher = {
  readonly provider: TranscriptProviderKey;
  /** Upper bound on HTTP requests one `fetch` call makes; the daily budget reserves this much. */
  readonly maxRequestsPerVideo: number;
  fetch(videoId: string, options?: { lang?: string }): Promise<TranscriptResult>;
};

export const TRANSCRIPT_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_TRANSCRIPT_REQUESTS_PER_DAY = 50;
const MAX_CUES = 20_000;
const MAX_CUE_CHARS = 2_000;

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** YOUTUBE_TRANSCRIPT_REQUESTS_PER_DAY: HTTP requests per America/Los_Angeles day (default 50). */
export function transcriptRequestBudget(env: NodeJS.ProcessEnv): number {
  const value = env.YOUTUBE_TRANSCRIPT_REQUESTS_PER_DAY;
  if (value == null || value.trim() === "") return DEFAULT_TRANSCRIPT_REQUESTS_PER_DAY;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 10_000) {
    throw new Error("Invalid transcript request budget configuration.");
  }
  return parsed;
}

export type TranscriptProviderConfig =
  | { enabled: true; provider: TranscriptProviderKey }
  | { enabled: false; reason: "disabled" | "missing_key" | "invalid_provider" };

/** Which transcript provider the env selects. Nothing is enabled by default. */
export function transcriptProviderConfig(env: NodeJS.ProcessEnv): TranscriptProviderConfig {
  const raw = env.TRANSCRIPT_PROVIDER?.trim().toLowerCase() ?? "";
  if (raw === "" || raw === "none") return { enabled: false, reason: "disabled" };
  if (raw === "youtube_captions") return { enabled: true, provider: "youtube_captions" };
  if (raw === "supadata") {
    return env.SUPADATA_API_KEY?.trim()
      ? { enabled: true, provider: "supadata" }
      : { enabled: false, reason: "missing_key" };
  }
  return { enabled: false, reason: "invalid_provider" };
}

export function createTranscriptFetcherFromEnv(
  env: NodeJS.ProcessEnv,
  transport?: HttpTransport,
): TranscriptFetcher | null {
  const config = transcriptProviderConfig(env);
  if (!config.enabled) return null;
  if (config.provider === "supadata") {
    return new SupadataTranscriptFetcher({ apiKey: env.SUPADATA_API_KEY!.trim(), transport });
  }
  return new YoutubeCaptionFetcher({ transport });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function finiteNumber(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Decodes the few HTML entities caption text carries and collapses whitespace. */
export function cleanCueText(value: string): string {
  return value
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
      if (code[0] === "#") {
        const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
      }
      return ENTITIES[code.toLowerCase()] ?? match;
    })
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CUE_CHARS);
}

function errorReason(error: unknown): string {
  return error instanceof ProviderHttpError ? error.errorClass : "transport_failed";
}

/**
 * Finds `marker` (e.g. "ytInitialPlayerResponse") in a page and returns the
 * JSON object assigned to it, by matching braces outside strings.
 */
export function extractAssignedJson(html: string, marker: string): unknown {
  let from = 0;
  while (from < html.length) {
    const at = html.indexOf(marker, from);
    if (at < 0) return null;
    const start = html.indexOf("{", at + marker.length);
    const between = start < 0 ? "" : html.slice(at + marker.length, start);
    from = at + marker.length;
    if (start < 0 || !/^["']?\s*\]?\s*=\s*$/.test(between)) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < html.length; i += 1) {
      const ch = html[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(html.slice(start, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }
  return null;
}

const BOT_PATTERNS = [
  /sign in to confirm you(?:'|’|&#39;)?re not a bot/i,
  /confirm you(?:'|’|&#39;)?re not a bot/i,
  /unusual traffic from your computer network/i,
  /consent\.youtube\.com/i,
  /www\.google\.com\/sorry\//i,
];

type CaptionTrack = { baseUrl: string; languageCode: string; kind: string | null };

export function pickEnglishCaptionTrack(tracks: CaptionTrack[], lang = "en"): CaptionTrack | null {
  const wanted = lang.toLowerCase();
  const matches = (track: CaptionTrack) => {
    const code = track.languageCode.toLowerCase();
    return code === wanted || code.startsWith(`${wanted}-`);
  };
  return (
    tracks.find((track) => matches(track) && track.kind !== "asr") ??
    tracks.find((track) => matches(track) && track.kind === "asr") ??
    null
  );
}

/** Parses YouTube's json3 timedtext format: `events[].segs[].utf8` with `tStartMs` / `dDurationMs`. */
export function parseJson3Captions(body: unknown): TranscriptCue[] | null {
  const events = asRecord(body).events;
  if (!Array.isArray(events)) return null;
  const cues: TranscriptCue[] = [];
  for (const raw of events) {
    if (cues.length >= MAX_CUES) break;
    const event = asRecord(raw);
    if (!Array.isArray(event.segs)) continue;
    const offsetMs = finiteNumber(event.tStartMs);
    if (offsetMs == null) continue;
    const text = cleanCueText(
      event.segs.map((seg) => (typeof asRecord(seg).utf8 === "string" ? (asRecord(seg).utf8 as string) : "")).join(""),
    );
    if (!text) continue;
    cues.push({ text, offsetMs, durationMs: finiteNumber(event.dDurationMs) ?? 0 });
  }
  return cues;
}

function captionTrackUrl(baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(baseUrl, "https://www.youtube.com");
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !/^(www\.|m\.)?youtube\.com$/.test(url.hostname) || url.pathname !== "/api/timedtext") {
    return null;
  }
  url.searchParams.set("fmt", "json3");
  return url.toString();
}

/**
 * Free fetcher of the captions YouTube already shows for a video. Unofficial
 * web endpoints; may be blocked from cloud IPs; fixture-tested only.
 */
export class YoutubeCaptionFetcher implements TranscriptFetcher {
  readonly provider = "youtube_captions" as const;
  readonly maxRequestsPerVideo = 2;
  private readonly transport: HttpTransport;

  constructor(input: { transport?: HttpTransport } = {}) {
    this.transport = input.transport ?? createFetchTransport({ timeoutMs: TRANSCRIPT_REQUEST_TIMEOUT_MS });
  }

  async fetch(videoId: string, options?: { lang?: string }): Promise<TranscriptResult> {
    if (!VIDEO_ID.test(videoId)) return { status: "error", reason: "invalid_video_id" };
    const lang = options?.lang ?? "en";
    const headers = {
      "accept-language": `${lang},en;q=0.8`,
      "user-agent": "Mozilla/5.0 (compatible; SentimentTranscriptBot/1.0)",
    };
    let page: HttpResponse;
    try {
      page = await this.transport.fetch(
        `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=${encodeURIComponent(lang)}`,
        { headers },
      );
    } catch (error) {
      return { status: "error", reason: errorReason(error) };
    }
    if (page.status === 429) return { status: "rate_limited", reason: "blocked" };
    if (page.status === 404) return { status: "unavailable", reason: "video_not_found" };
    if (page.status !== 200) return { status: "error", reason: `http_${page.status}` };

    const player = asRecord(extractAssignedJson(page.bodyText, "ytInitialPlayerResponse"));
    const playability = asRecord(player.playabilityStatus);
    const playabilityText = `${String(playability.reason ?? "")} ${JSON.stringify(playability.errorScreen ?? "")}`;
    if (BOT_PATTERNS.some((pattern) => pattern.test(playabilityText))) {
      return { status: "rate_limited", reason: "blocked" };
    }
    if (Object.keys(player).length === 0) {
      return BOT_PATTERNS.some((pattern) => pattern.test(page.bodyText))
        ? { status: "rate_limited", reason: "blocked" }
        : { status: "error", reason: "player_response_missing" };
    }
    const status = typeof playability.status === "string" ? playability.status : "OK";
    if (status !== "OK") return { status: "unavailable", reason: `playability_${status.toLowerCase()}` };

    const rawTracks = asRecord(asRecord(player.captions).playerCaptionsTracklistRenderer).captionTracks;
    const tracks: CaptionTrack[] = (Array.isArray(rawTracks) ? rawTracks : [])
      .map((raw) => asRecord(raw))
      .filter((row) => typeof row.baseUrl === "string" && typeof row.languageCode === "string")
      .map((row) => ({
        baseUrl: row.baseUrl as string,
        languageCode: row.languageCode as string,
        kind: typeof row.kind === "string" ? row.kind : null,
      }));
    const track = pickEnglishCaptionTrack(tracks, lang);
    if (!track) return { status: "unavailable", reason: tracks.length ? "no_english_track" : "no_captions" };
    const trackUrl = captionTrackUrl(track.baseUrl);
    if (!trackUrl) return { status: "error", reason: "invalid_track_url" };

    let body: HttpResponse;
    try {
      body = await this.transport.fetch(trackUrl, { headers });
    } catch (error) {
      return { status: "error", reason: errorReason(error) };
    }
    if (body.status === 429) return { status: "rate_limited", reason: "blocked" };
    if (body.status === 404) return { status: "unavailable", reason: "track_not_found" };
    if (body.status !== 200) return { status: "error", reason: `http_${body.status}` };
    // YouTube can answer 200 with an empty body when it wants a proof-of-origin token.
    if (!body.bodyText.trim()) return { status: "error", reason: "empty_caption_body" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.bodyText);
    } catch {
      return BOT_PATTERNS.some((pattern) => pattern.test(body.bodyText))
        ? { status: "rate_limited", reason: "blocked" }
        : { status: "error", reason: "invalid_payload" };
    }
    const cues = parseJson3Captions(parsed);
    if (!cues) return { status: "error", reason: "invalid_payload" };
    if (cues.length === 0) return { status: "unavailable", reason: "empty_track" };
    return {
      status: "ok",
      lang: track.languageCode,
      cues,
      trackKind: track.kind === "asr" ? "asr" : "manual",
    };
  }
}

export const SUPADATA_DEFAULT_BASE_URL = "https://api.supadata.ai/v1";

/** Parses a Supadata transcript body defensively. Shape from memory; not hosted-validated. */
export function parseSupadataTranscript(body: unknown): { lang: string | null; cues: TranscriptCue[] } | null {
  const record = asRecord(body);
  if (!Array.isArray(record.content)) return null;
  const cues: TranscriptCue[] = [];
  let lang: string | null = typeof record.lang === "string" ? record.lang : null;
  for (const raw of record.content) {
    if (cues.length >= MAX_CUES) break;
    const row = asRecord(raw);
    if (typeof row.text !== "string") continue;
    const offsetMs = finiteNumber(row.offset);
    if (offsetMs == null) continue;
    const text = cleanCueText(row.text);
    if (!text) continue;
    if (!lang && typeof row.lang === "string") lang = row.lang;
    cues.push({ text, offsetMs, durationMs: finiteNumber(row.duration) ?? 0 });
  }
  return { lang, cues };
}

/**
 * Optional paid backup (TRANSCRIPT_PROVIDER=supadata). One request per video.
 * Fixture-tested only; the vendor contract was not verifiable from the sandbox.
 */
export class SupadataTranscriptFetcher implements TranscriptFetcher {
  readonly provider = "supadata" as const;
  readonly maxRequestsPerVideo = 1;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly transport: HttpTransport;

  constructor(input: { apiKey: string; baseUrl?: string; transport?: HttpTransport }) {
    this.apiKey = input.apiKey;
    this.baseUrl = (input.baseUrl ?? SUPADATA_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.transport = input.transport ?? createFetchTransport({ timeoutMs: TRANSCRIPT_REQUEST_TIMEOUT_MS });
  }

  async fetch(videoId: string, options?: { lang?: string }): Promise<TranscriptResult> {
    if (!VIDEO_ID.test(videoId)) return { status: "error", reason: "invalid_video_id" };
    const lang = options?.lang ?? "en";
    const url = `${this.baseUrl}/youtube/transcript?videoId=${encodeURIComponent(videoId)}&lang=${encodeURIComponent(lang)}`;
    let response: HttpResponse;
    try {
      response = await this.transport.fetch(url, { headers: { "x-api-key": this.apiKey, accept: "application/json" } });
    } catch (error) {
      return { status: "error", reason: errorReason(error) };
    }
    if (response.status === 429) return { status: "rate_limited", reason: "rate_limited" };
    if (response.status === 404 || response.status === 206) return { status: "unavailable", reason: "no_transcript" };
    if (response.status === 401 || response.status === 403) return { status: "error", reason: "auth" };
    // 202 would be an asynchronous job for long videos; not supported, retried on a later day.
    if (response.status === 202) return { status: "error", reason: "async_job_unsupported" };
    if (response.status !== 200) return { status: "error", reason: `http_${response.status}` };
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.bodyText);
    } catch {
      return { status: "error", reason: "invalid_payload" };
    }
    const transcript = parseSupadataTranscript(parsed);
    if (!transcript) return { status: "error", reason: "invalid_payload" };
    if (transcript.cues.length === 0) return { status: "unavailable", reason: "empty_transcript" };
    return { status: "ok", lang: transcript.lang ?? lang, cues: transcript.cues, trackKind: "unknown" };
  }
}

export type TranscriptWindow = {
  startMs: number;
  endMs: number;
  text: string;
  /** Offset of each cue's text inside `text`, for timestamping a match. */
  cueStarts: Array<{ charStart: number; offsetMs: number }>;
};

/** Groups cues into windows of about `windowMs` (default 60s), in time order. */
export function chunkTranscriptCues(cues: TranscriptCue[], windowMs = 60_000): TranscriptWindow[] {
  const sorted = [...cues].sort((a, b) => a.offsetMs - b.offsetMs);
  const windows: TranscriptWindow[] = [];
  let current: TranscriptWindow | null = null;
  for (const cue of sorted) {
    if (!cue.text) continue;
    if (!current || cue.offsetMs - current.startMs >= windowMs) {
      current = { startMs: cue.offsetMs, endMs: cue.offsetMs + cue.durationMs, text: "", cueStarts: [] };
      windows.push(current);
    }
    if (current.text) current.text += " ";
    current.cueStarts.push({ charStart: current.text.length, offsetMs: cue.offsetMs });
    current.text += cue.text;
    current.endMs = Math.max(current.endMs, cue.offsetMs + cue.durationMs);
  }
  return windows;
}
