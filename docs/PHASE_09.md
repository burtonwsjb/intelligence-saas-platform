# Phase 09 — Source intelligence ingestion

Status: **implemented**. Phase 10 is complete; see [PHASE_10.md](PHASE_10.md). Phase 11 has **not** started.

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
