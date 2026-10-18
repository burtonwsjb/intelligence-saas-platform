// Generates packages/db/src/creator/seed/pokemon-influencers.ts from the
// researched influencer CSV (columns rank,name,youtube_url,youtube_handle,
// subscribers,website_url,feed_url,newsletter_url,...,makes_specific_calls).
// Keeps only what registration needs. Handles marked "unverified", prose
// ("Patreon (URL unverified)") and legacy /c/ URLs are kept as URLs or
// dropped, never turned into a guessed handle. No network access.
//
//   node scripts/generate-influencer-seed.mjs top-pokemon-influencers.csv [version-date] \
//     > packages/db/src/creator/seed/pokemon-influencers.ts
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** RFC 4180 CSV (quoted fields, doubled quotes, newlines inside quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [header, ...body] = rows.filter((r) => r.some((cell) => cell.trim()));
  return body.map((r) => Object.fromEntries(header.map((key, index) => [key.trim(), (r[index] ?? '').trim()])));
}

/** The first http(s) URL in a cell, or null (prose such as "URL unverified" is dropped). */
function firstUrl(value) {
  const match = String(value ?? '').match(/https?:\/\/[^\s,;()]+/);
  return match ? match[0] : null;
}

export function seedEntry(row) {
  const youtubeUrl = firstUrl(row.youtube_url);
  const idFromUrl = youtubeUrl?.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/)?.[1] ?? null;
  const handleCell = String(row.youtube_handle ?? '');
  const handle = /unverified/i.test(handleCell) ? null : handleCell.match(/^@[A-Za-z0-9._-]{3,30}$/)?.[0] ?? null;
  const handleFromUrl = youtubeUrl?.match(/youtube\.com\/(@[A-Za-z0-9._-]{3,30})(?:[/?#]|$)/)?.[1] ?? null;
  return {
    rank: Number(row.rank),
    name: row.name,
    youtubeChannelId: idFromUrl,
    youtubeHandle: idFromUrl ? null : handle ?? handleFromUrl,
    youtubeUrl,
    websiteUrl: firstUrl(row.website_url),
    feedUrl: firstUrl(row.feed_url),
    newsletterUrl: firstUrl(row.newsletter_url),
    makesSpecificCalls: row.makes_specific_calls || 'unknown',
  };
}

export function renderSeedModule(entries, versionDate) {
  const lines = entries.map((entry) => `  ${JSON.stringify(entry).replace(/","/g, '", "').replace(/,"/g, ', "').replace(/":/g, '": ')},`);
  return `/**
 * Candidate Pokemon TCG market influencers, generated from
 * top-pokemon-influencers.csv (${entries.length} rows, researched ${versionDate} from web-search
 * snippets only). Only the fields registration needs are kept. Handles and
 * URLs are unverified: the worker confirms YouTube channels through the
 * YouTube Data API and never guesses one from a name. Being on this list is
 * not authority; every creator is ranked only on how their calls turned out.
 *
 * Regenerate with the script described in docs/OPERATOR_RUNBOOK.md rather
 * than editing by hand.
 */
import type { InfluencerSeedEntry } from "../seed.js";

export const POKEMON_INFLUENCER_SEED_VERSION = "pokemon_influencers.${versionDate}";

export const POKEMON_INFLUENCER_SEEDS: readonly InfluencerSeedEntry[] = [
${lines.join('\n')}
];
`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [csvPath, versionDate = new Date().toISOString().slice(0, 10)] = process.argv.slice(2);
  if (!csvPath) {
    console.error('usage: node scripts/generate-influencer-seed.mjs <csv> [YYYY-MM-DD]');
    process.exit(2);
  }
  const entries = parseCsv(readFileSync(csvPath, 'utf8')).map(seedEntry).sort((a, b) => a.rank - b.rank);
  process.stdout.write(renderSeedModule(entries, versionDate));
}
