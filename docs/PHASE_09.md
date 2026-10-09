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
