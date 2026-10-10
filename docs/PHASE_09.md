# Phase 09 — Source intelligence ingestion

Status: **implemented**. Later phases through Phase 20 are complete; see [PHASE_20.md](PHASE_20.md).

YouTube, Reddit, and generic social/web sources ingest as platform-global documents, accounts, segments, mentions, and engagement snapshots. Fixture providers only. No HTML scraping. No real YouTube/Reddit network calls. Mentions remain unresolved. Creator authority and advanced entity resolution are not in this phase.

## Domain boundary

Source intelligence is **not** hard-coded into the generic kernel. Pack tables live in `@isp/db`:

| Location | Role |
|---|---|
| `packages/db/src/schema/source.ts` | Drizzle tables |
| `packages/db/drizzle/0009_phase09_source.sql` | Migration |
| `packages/db/src/source/` | Ingest, fixtures, providers |
| `packages/contracts/src/source.ts` | Catalogs and parsers (no Zod) |
| `apps/api/src/source-contracts.ts` | Internal Zod only |

`POST /v1/events` still rejects `source.content.ingested`. The job type is `source.intelligence.normalize.v1` on `source_ingest`, not tenant `outbox_job`.

## Source types

`youtube`, `reddit`, `web`, `rss`, `manual`. Kernel tables are not YouTube- or Reddit-specific.

## Accounts / creators (this phase)

`source_account` is a **source personality**, not later creator authority.

Public accounts are **platform-global** (no tenant RLS). Tenant annotations are deferred. Unique `(source_type, external_account_id)`. `first_seen_at` is sticky; `last_seen_at` may update.

## Content

Immutable `source_content`: source, external id, account, `published_at`, title, bounded summary, canonical URL, content type, optional language, license/retention, transcript availability, bounded excerpt + hash, fingerprint, metadata, `ingested_at`.

Uniqueness: `(source_type, external_content_id)`.

## Copyright / transcripts

Prefer URL, ids, timestamps, structured extracts. Max excerpt **500** characters. `retention_policy`: `reference_only` (no excerpt), `bounded_excerpt`, `derived_only`. Full transcripts are not stored. `transcript_available` is a boolean plus timestamped segment references.

Source text is untrusted: not executed as HTML, prompts, or code.

## Transcript backfill (YouTube)

Video titles rarely name a card, so creator calls from YouTube could not bind to a printing. The worker step `runTranscriptBackfill` (hourly, with the catalog import and call scoring) fetches the transcript of the newest unchecked YouTube videos, finds catalog card names in it (`source/card-detect.ts`: longest match over canonical names and English aliases; names under four characters and a stoplist of generic card names such as "energy", "rare candy" or "ultra ball" are ignored; a collector number said right after the name and the nearest set name of the same game are attached), and stores them as mentions. New mentions are resolved (the resolver now also reads the excerpt of the mention's segment, with prices and years blanked, and the transcript's set key and collector number) and the content's creator calls are extracted again.

Retention: full transcripts are **not** stored. Only ~60 s windows that contain a detected card name are kept, as one `timestamp_range` segment each with `t=<seconds>` start/end refs and a bounded excerpt (≤ 480 characters around the mentions, under the 500 limit). All other windows are discarded after detection. `source_content` is immutable, so `transcript_available` is not updated on existing rows; each check is recorded as a `provider_sync_run` row (provider `youtube`, trigger `transcript`, id `ptx_<content id>`) whose checkpoint carries the outcome and `transcript_available`. Completed and unavailable videos are never fetched again; failures are retried after 24 h, at most three attempts. Videos of creators an operator excluded are skipped. No migration was needed.

| Env | Default | Meaning |
| --- | --- | --- |
| `TRANSCRIPT_PROVIDER` | `none` | `youtube_captions`, `supadata` or `none`. Nothing runs unless set. |
| `SUPADATA_API_KEY` | — | Required for `supadata`; sent only as the `x-api-key` header, never logged. |
| `YOUTUBE_TRANSCRIPT_REQUESTS_PER_DAY` | 50 | HTTP requests per America/Los_Angeles day (0–10000). Each video reserves its worst case: 2 for captions, 1 for Supadata. Failed requests still count. |

- `youtube_captions` (primary, free) reads the captions YouTube already publishes (manual English first, then auto-generated) from the watch page's `ytInitialPlayerResponse` and the `json3` timedtext track: at most two requests per video, 15 s timeout each. It uses YouTube's **unofficial web endpoints, not the Data API** (which cannot download captions of other people's videos); the owner accepted this. YouTube **may block these requests from cloud IPs**: a consent page, a "confirm you're not a bot" page or a 429 is recorded as `blocked`, and the step stops until the next Pacific day. YouTube may also answer an empty body when it wants a proof-of-origin token; that is recorded as a retryable failure.
- `supadata` (optional paid backup) calls `GET https://api.supadata.ai/v1/youtube/transcript?videoId=…&lang=en`. Its request/response shape was written from memory and could not be checked from the build sandbox; the parser is defensive.

Validation state: implemented and **fixture-tested only** (recorded watch-page HTML and a `json3` track under `packages/db/src/providers/fixtures/transcripts/`, fake Supadata responses, PGlite ingest tests). Neither adapter has been hosted-validated, and no provider is enabled anywhere by this change.

## Website feeds (influencer sites)

Influencer websites are a creator source without downloading any video. An operator registers a site on **/admin/sources → Influencer websites** (website URL, optional feed URL and display name; platform operators only, audited as `discovery.monitor` with `change: web_feed.register`). The site becomes a `web` `source_account` keyed by domain (the same account and creator a Google web search finds for that domain, so calls from both count toward one creator) and its registration lives in that account's `metadata.web_feed` (`site_url`, `feed_url`, `state` active/paused, `registered_at`, `registered_by`). URLs must be public http(s) addresses (the webhook SSRF guard plus a DNS check); YouTube, Reddit, social sites and stores are refused. Sites can be paused and resumed from the same page.

The worker step `runWebFeedSync` (hourly, after the transcript backfill) reads due sites (not checked in the last 6 h, oldest first, at most 10 per run; paused sites and sites of creators an operator excluded are skipped):

1. robots.txt of every origin it touches is read once per run and honored for every path (group `SentimentBot`, else `*`; longest match wins, Allow wins ties). A 4xx robots.txt means no rules; a 5xx or network failure means the site is skipped for that run. A disallowed feed is never requested.
2. The feed is the stored feed URL, else `<link rel="alternate" type="application/rss+xml|application/atom+xml">` on the homepage, else `/feed`, `/rss.xml`, `/feed.xml`, `/atom.xml`, `/index.xml`. `If-None-Match` / `If-Modified-Since` are sent when the last read stored validators.
3. RSS 2.0, RSS 1.0 and Atom are parsed by a small dependency-free reader (`providers/web-feed.ts`; DOCTYPE entities are skipped, never expanded). Post text is `content:encoded` / Atom `content`, else `description` / `summary`, as plain text (scripts and styles dropped). Only when an item has a title and no text is its article page read (at most 3 per site per run), and only where robots.txt allows.
4. Each post (newest 20) is stored once as `web` `article` content (id = hash of the post URL without fragment and `utm_*`; posts already ingested from the feed are skipped). Card names are found with the same detector as transcripts over ~700-character paragraph windows (body first, then the title); each card (name + collector number) is kept once per post. Only windows naming a card are stored, as `paragraph` segments (`p=<n>` refs) with an excerpt of at most 480 characters; the post text itself is never stored (content `summary` and `excerpt` stay empty). Mentions carry the detector's hints under `metadata.card_detect` (card name, collector number, set key), which the resolver reads like transcript hints. Calls are then extracted for the content, so they count toward the site's accuracy.

Bounds: every request (robots.txt, homepage, feed candidates, redirects, article pages) counts against 10 per site per run; 10 s timeout and 2 MB body cap per response (512 KB for robots.txt); redirects are followed by hand, at most 3, each re-checked for SSRF and robots. User-Agent: `SentimentBot/1.0 (+<APP_URL origin>) …`. Each site check is one `provider_sync_run` row (provider `web_feed`, trigger `web_feed`, id `pwf_…`) that reserves 10 requests in `limit_count` before any request and is corrected to the requests used; the checkpoint carries the account id, feed URL, validators and counts. Logs carry counts only.

| Env | Default | Meaning |
| --- | --- | --- |
| `PROVIDER_WEB_FEED_MODE` | `disabled` (staging/production) | Must be `live` for anything to run. `fixture` does nothing. No credentials. The admin Enable/Disable/Pause controls on the `web_feed` provider apply. |
| `WEB_FEED_REQUESTS_PER_DAY` | 200 | HTTP requests per America/Los_Angeles day across all sites (0–10000). |

The provider key `web_feed` is new in `PROVIDER_KEYS`; its `provider_runtime` row is created by the worker at startup like the others (`applyProviderModeFromEnv`). The provider sync queue never schedules it; an admin "Trigger staging sync" for `web_feed` runs at most 3 due sites. No migration was needed: the registry uses `source_account.metadata`, checks use `provider_sync_run`, and the audit uses an existing action.

Validation state: implemented and **fixture-tested only** (RSS, Atom, homepage and robots.txt fixtures under `packages/db/src/providers/fixtures/web-feed/`, fake HTTP transports, PGlite ingest tests). No real site (for example pokeinsider.com) was reachable from the build sandbox; nothing is hosted-validated and `PROVIDER_WEB_FEED_MODE` is not set anywhere by this change. Workspace users cannot add sites yet: the workspace creator list (`tenant_creator_list`) only accepts `youtube` / `reddit` by check constraint, so a user-facing path needs a migration.

## Segments

`source_content_segment`: `timestamp_range`, `paragraph`, or `comment`, with start/end refs and optional bounded excerpt. Future creator-call evidence can point here.

## Mentions

Structured extracts: raw/normalized text, context (`identity`/`price`/`recommendation`/`pull`/`other`), optional direction/timeframe/price/percent, sentiment foundation, extractor version. **No exact printing bind in Phase 09.** Metadata records `resolution_status=unresolved`. Unresolved mentions are valid.

## Sentiment foundation

Labels: `positive`, `negative`, `neutral`, `mixed`, `unknown`, optional 0..1 confidence. Not a price prediction.

## Engagement

Append-only snapshots: views, likes, comments, upvotes, score, reply_count, published age. Source semantics preserved. Engagement is **not** authority.

## Mention velocity foundation

Helpers: mention count, unique content, unique accounts, rate per day. No opportunity score.

## Providers

`YoutubeSourceProvider` / `RedditSourceProvider` with fixture implementations. No `fetch`, no HTML scrape. Later official APIs must be allowlisted.

## Pipeline

Fixture record → `source_ingest` → `source.intelligence.normalize.v1` → account upsert → immutable content/segments/mentions/engagement. Same fingerprint replay: `duplicate`. Material fingerprint change: fail closed.

## Security

SELECT for runtime roles. INSERT is worker + `principal_type=system`. Tenants cannot mutate global source facts. No tenant-supplied URL fetching.

## Phase 10 boundary

Do not start mention-to-printing resolution, fuzzy matching, or creator authority.
