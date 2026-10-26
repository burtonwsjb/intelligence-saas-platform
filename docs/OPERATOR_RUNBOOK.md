# Operator runbook

Never paste secret values into tickets, chat, or this file. Use environment *names* only.

Related: [environments.md](environments.md), [staging-runbook.md](staging-runbook.md), [neon-provisioning.md](neon-provisioning.md), [production-security-checklist.md](production-security-checklist.md), [secret-rotation.md](secret-rotation.md), [CI.md](CI.md), [architecture/00-overview.md](architecture/00-overview.md).

## Architecture

- `apps/web` — Next.js customer + admin UI (Vercel)
- `apps/api` — Hono public API + Stripe webhook receiver (Railway)
- `apps/worker` — BullMQ worker (Railway)
- Neon Postgres with RLS roles
- Redis for queues
- Resend for transactional email
- Stripe **test** only until production is authorized

## Local setup

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm test:isolation
pnpm test:integration
pnpm build
pnpm dev:web
pnpm dev:api
pnpm dev:worker
```

Required local names only: see `.env.example`. Do not copy hosted secret values into local files that can be committed.

## Staging setup

- Vercel web, Railway API + worker, Neon, Redis, Resend.
- Do not enable live providers.
- Do not apply a migration unless it is listed as unapplied and you have a backup window.
- Worker heartbeat identity: run `pnpm --filter @isp/db staging-db-identity` after return. Do not keep debugging hosted heartbeat in this sprint.

## Production setup

Not authorized. See [PHASE_23_READINESS.md](PHASE_23_READINESS.md) and [production-security-checklist.md](production-security-checklist.md).

## Environment variables

Use names from `.env.example`. Critical classes:

- Database: `DATABASE_URL`, `APP_DATABASE_URL`, `DATABASE_ADMIN_URL`
- Auth: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `APP_URL`
- Queue: `REDIS_URL`, `QUEUE_PREFIX`
- Email: `AUTH_EMAIL_MODE`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`
- Billing: Stripe test keys / webhook secret only
- Providers: `PROVIDER_DEFAULT_MODE` plus per-provider credentials
- API keys: `API_KEY_PEPPER`

Never commit values. Never put secrets in query strings or docs.

## Database roles

`app_migrate`, `app_user`, `app_worker`, `app_admin`. `app_user` / `app_worker` must not `BYPASSRLS`. Platform operators are `platform_admins` grants, not a tenant role.

## Neon

Provision a branch per environment. Apply committed migrations in order with the migrator role. After `0023`, no additional hosted migration from this sprint is waiting.

## Redis

Required for the worker. A Redis outage must not drop outbox rows. Worker health should report 503 while shutting down or if Redis is gone.

## Vercel / Railway

Web on Vercel. API and worker on Railway. Do not click hosted controls from this repository automation. Confirm `APP_DATABASE_URL` is loaded on the worker before chasing heartbeat mismatches.

## Provider activation

Modes are `disabled` | `fixture` | `live`. Live never infers from credential presence. Keep providers disabled until an operator explicitly sets live mode and has budget approval.

YouTube and TikTok transcripts are off unless `TRANSCRIPT_PROVIDER` is `youtube_captions` (unofficial YouTube web endpoints; may be blocked from cloud IPs; YouTube only) or `supadata` (with `SUPADATA_API_KEY`; Supadata's universal `GET /v1/transcript?url=…&mode=auto`, polling async jobs at `/v1/transcript/{jobId}` for up to a minute; it fetches the video, Sentiment never downloads it). `YOUTUBE_TRANSCRIPT_REQUESTS_PER_DAY` (default 50) caps transcript requests per Pacific day across both; each video reserves its worst case (13 for Supadata) and gives back what it did not use. TikTok creators are followed by profile link on /admin/sources → TikTok creators, or added as single video links (both need migration `0039_tiktok_source`); TikTok videos are transcribed before YouTube ones. Only bounded excerpts of windows that name a card are kept. Fixture-tested only; see [PHASE_09.md](PHASE_09.md#transcript-backfill-youtube).

Followed TikTok creators cost nothing to list: no paid service is used. Follow a creator by profile link on /admin/sources → TikTok creators. The owner's computer lists each followed creator's newest videos during the nightly local Whisper run (`tools/local-whisper`, using the free yt-dlp tool with `--skip-download`: captions, ids and dates only, never the videos) through `POST /internal/local-transcripts/tiktok/claim` and `POST /internal/local-transcripts/tiktok/:sourceAccountId` (same `LOCAL_TRANSCRIBER_TOKEN`). Each creator is listed at most every 12 hours; the first listing reads back `TIKTOK_BACKFILL_DAYS` (default 365, up to 300 videos), later ones stop at the newest video already seen (up to 60). Each caption decides whether the video is kept: a catalog card name, or trading-card words (pokemon, tcg, booster, PSA, pulls, …); other videos are counted and skipped, with up to five sample captions in the run's checkpoint, so the transcript service is only paid for card videos. Card names in a kept caption become calls at once. Runs are `provider_sync_run` rows (provider `tiktok`, trigger `tiktok_profile`, id `ptk_…`; `started` = claimed, a claim lapses after 12 hours). Pause a creator on the admin page, or pause the `tiktok` provider to stop all listing. TikTok's own API only lists videos of users who sign in to the app, so listing reads the public profile the way a browser does; that carries the same platform-terms caveat as the transcript service. Fixture-tested on the server; yt-dlp listing was checked on the owner's computer 2026-10-25.

Influencer websites (RSS/Atom feeds) are off unless `PROVIDER_WEB_FEED_MODE=live`. Register sites on /admin/sources → Influencer websites; pause a site there, or pause/disable the `web_feed` provider to stop all reads. robots.txt is honored; at most 10 sites per hourly run, 10 requests per site, `WEB_FEED_REQUESTS_PER_DAY` (default 200) per Pacific day. Only excerpts (≤ 480 chars) around card names are kept. Fixture-tested only; see [PHASE_09.md](PHASE_09.md#website-feeds-influencer-sites).

Podcasts and the local Whisper helper: register podcast RSS feeds on /admin/sources → Podcasts (runs with `PROVIDER_WEB_FEED_MODE=live`, shares the `web_feed` pause/enable controls; at most 10 feeds per hourly run, each read every 6 hours, `PODCAST_FEED_REQUESTS_PER_DAY` default 100). Episodes from the last `PODCAST_BACKFILL_DAYS` (default 365) are stored with their audio link; card names in show notes become calls at once. The audio is never fetched by Sentiment: the owner's computer runs `tools/local-whisper` nightly (03:00–07:00 Arizona time), which claims episodes through `POST /internal/local-transcripts/claim`, downloads the podcast's own enclosure file, transcribes it with faster-whisper and posts the cues to `POST /internal/local-transcripts/:contentId`. Those routes are off (404) unless `LOCAL_TRANSCRIBER_TOKEN` (32+ characters) is set on the API service; they use that Bearer token, not a tenant API key. Transcripts are kept like YouTube ones (only ~60 s windows naming a card). Jobs are `provider_sync_run` rows with trigger `local_transcript` (id `plt_<content id>`; a claim expires after 12 hours, 3 attempts max). YouTube audio is never downloaded. Fixture-tested only; see [tools/local-whisper/README.md](../tools/local-whisper/README.md).

Influencer seed list and 12-month backfills: register the committed Pokemon list on /admin/sources → Influencer seed list (type `seed`; idempotent, audited). Websites are registered at once; YouTube channels are resolved by the worker through the Data API (≤ 5 per YouTube sync tick; unresolvable rows are reported, never guessed). Set `YOUTUBE_BACKFILL_DAYS=365` (with YouTube live) and `WEB_FEED_BACKFILL_DAYS=365` (with `PROVIDER_WEB_FEED_MODE=live`) to backfill a year of uploads (titles and descriptions only) and sitemap posts; caps are `YOUTUBE_BACKFILL_REQUESTS_PER_DAY` (default 60, inside the shared YouTube data budget) and `WEB_FEED_BACKFILL_REQUESTS_PER_SITE_PER_DAY` (default 30, inside `WEB_FEED_REQUESTS_PER_DAY`). Both resume where they stopped; progress is on the same admin page. TCC price history runs whenever TCC is live: first for unscored calls (`TCC_PRICE_HISTORY_ITEMS_PER_RUN`, default 100; 0 turns the whole step off), then for the chart universe of English Pokemon / One Piece printings, called and mentioned cards first (`TCC_PRICE_HISTORY_CHART_ITEMS_PER_RUN`, default 500; 0 = off; printings without history before refreshes), a year per printing and then a refresh every 3 days, at most 100,000 points per hourly run. `pending` answers are asked again after ~30 minutes, `not_found` after a day, games TCC has no history source for after 7 days. Each hourly run logs `worker.chart_coverage`: English Pokemon / One Piece printings with and without a Chart Sentiment reading, and why the ones without have none. Progress: `SELECT checkpoint->>'status' AS status, checkpoint->>'reason' AS reason, count(*) FROM provider_sync_run WHERE "trigger" = 'price_history' GROUP BY 1, 2` and `SELECT count(*) FROM tcg_market_snapshot WHERE source_key = 'tcg_card_central' AND price_type = 'reference'`. Hand-added creators (PokeInsider's blog, and the 22 YouTube creators mint-take.com lists publicly, names and @handles only) live in `packages/db/src/creator/seed/added-influencers.ts` at ranks 101+, so regenerating the CSV file keeps them; press the same register button again to queue them (settled rows are untouched). To regenerate the seed file from a new CSV: `node scripts/generate-influencer-seed.mjs path/to/top-pokemon-influencers.csv YYYY-MM-DD > packages/db/src/creator/seed/pokemon-influencers.ts`. Fixture-tested only; see [PHASE_09.md](PHASE_09.md#influencer-seed-list-12-month-backfills-and-the-accuracy-leaderboard).

Chart Sentiment: after the owner applies migration `0033_chart_sentiment` (not applied on any hosted database yet; until then the worker logs `worker.chart_sentiment` `reason: tables_missing` and the API returns `chart_sentiment.status: not_computed`), the worker scores up to `CHART_SENTIMENT_BATCH_SIZE` printings per hourly run (default 600; 0 = off) from stored market rows only, each printing at most once per 20 hours unless new rows (e.g. imported price history) arrived since its last score, and refreshes the pattern hit rates in `chart_pattern`. To check progress: `SELECT label, count(*) FROM chart_sentiment GROUP BY label` and `SELECT key, samples, hits, measured_hit_rate FROM chart_pattern ORDER BY key`. Fixture-tested only; see [PHASE_09.md](PHASE_09.md#chart-sentiment).

Set calls and the flat band: after the owner applies migration `0034_set_calls` (not applied on any hosted database yet; until then the worker logs `worker.set_catalog` `reason: migration_0034_missing` and creates no set assets), the worker adds one `set` market asset per active non-promo set (alias: the set name, and the name without a code prefix such as `SV:`; a name two sets share is nobody's alias), and reads set calls ("Ascended Heroes is going up") out of new posts and, 500 per hourly run behind a cursor (`provider_sync_run` trigger `asset_call_rescan`), out of posts stored earlier. A post that names a sealed product is a call on the product, not the set. A set call is scored on the median move of the set's raw USD card market prices (at least 3 cards priced at both ends; start within 2 days of the post, close within 7 days before the deadline; no prices after the deadline are read), so it has no starting or ending price. A move of less than 1% either way is `flat` (was 0.5%); 1% or more counts as up or down, and a flat up/down call now counts as a miss in creator accuracy (`outcome.v2`, `authority.v2`); 0034 regrades already scored calls, and `0035_flat_band_one_percent` moves calls between 1% and 2% back to up or down. Fixture-tested only.

## Provider credentials

Stay in Railway/Vercel env, never in git. Rotating a provider token does not change mode.

## Migrations

Forward-only Drizzle files in `packages/db/drizzle`. Latest committed file: `0023_phase24_provider_runtime_grants.sql`. New-environment bootstrap applies all files then `bootstrapRoles`. Existing staging upgrades apply only the next unapplied file.

## Backups and restore

Use Neon PITR / branch restore. After restore, re-check role flags and `platform_admins`. Do not roll back a migration file in git without a restore plan.

## Worker and queue

Startup writes heartbeat. SIGTERM/SIGINT drain in-flight jobs (~20s) then exit. Job timeout 90s, lock 120s, stalled recovery max 2. Outbox dead-letters after 20 publish failures.

## Admin bootstrap

Grant `platform_admins` by email with the documented grant script. Do not use a tenant role. Break-glass actions must write audit evidence.

Password reset (no reset email yet): an operator issues a one-time link by inserting a `verification` row with `identifier = 'reset-password:<random token>'`, `value = <user id>` and an `expires_at` about an hour out, then sends the user `<APP_URL>/reset-password?token=<random token>`. The page sets the new password through Better Auth's `/reset-password` endpoint, which consumes the row, so the link works once.

## Security incident response

1. Revoke sessions / API keys / webhook secrets involved
2. Rotate the leaked name from [secret-rotation.md](secret-rotation.md)
3. Keep RLS and platform-admin checks enabled
4. Do not disable authentication to “unblock” users

## Outages

| Failure | First check | Safe action |
|---|---|---|
| Database | Neon compute / `APP_DATABASE_URL` | Do not fail-open RLS |
| Redis | `REDIS_URL`, worker 503 health | Jobs stay in outbox |
| Worker | Admin Health overall status | Redeploy worker; do not enable live providers |
| Email | Resend logs, `AUTH_EMAIL_MODE` | Verification resend is rate-limited |
| Webhooks | consecutive failures, SSRF rejects | Retry from admin; do not disable signing |
| Billing | Stripe test webhook claims | Local simulation if Stripe is unset |
| Provider | Admin Sources + Health | Leave live mode off |

## Rollback

Revert the git SHA on Vercel/Railway. Do not roll back a forward-only migration without a restore plan.

## Release checklist

1. CI `validate` green including `git diff --check`
2. No new unapplied migration unless scheduled
3. Predictions still shadow
4. Providers still disabled unless explicitly activated
5. Secrets unchanged unless rotating with a dual-write plan
6. Money fixtures still show Greninja $41 and preserve the $4,000 outlier
