# Verified repair release, not a product-completion declaration

Follow PROJECT_SOURCE_OF_TRUTH.md. Do not redefine its scope to pass a release.

## Changes

Migrations use DATABASE_MIGRATE_URL for maintenance, a checksum ledger, atomic
DDL/history commits, and verified explicit adoption of a legacy database. Runtime
roles are refused. Existing hosted owners, passwords and data are untouched.
`--plan` never writes. An untracked database is refused rather than replaying SQL.

Legacy adoption requires both `--baseline-through <version>` and
`--confirm-existing-schema`. The verifier executes old SQL only in an isolated
PGlite reference and compares target schema catalogs. Do not guess the version.
PostgreSQL 16 and 18 nullability catalog differences are normalized without dropping NOT NULL, validation, or enforcement checks. Partial schemas still fail closed.
Pending ALTER operations also require their existing owner; CREATE grants alone
do not confer ownership of existing tables. No automatic ownership transfer is
performed by migration adoption. The target must first have a provider backup.

Discovery UI now submits audited jobs to the durable outbox. Railway worker
credentials are used for execution, not Vercel credentials. Missing live credentials
never substitute fixture results. Disabled/paused providers are respected.

Discovery request limits persist across runs, reserve before HTTP in their own
transaction, and count failed HTTP attempts. Defaults are 20 search and 200 data
requests per provider per Pacific calendar day. Configure the optional
YOUTUBE_DISCOVERY_SEARCH_REQUESTS_PER_DAY / YOUTUBE_DISCOVERY_DATA_REQUESTS_PER_DAY
or matching REDDIT variables to tighten them. These are application request
budgets, not a claim about Google's current vendor quota allocation. The legacy
`quota_units` field on discovery.v2 reports records HTTP requests, not vendor units.
Other applications sharing the same vendor API project are not included.

Repeated discovery of the same creator/topic does not increase topic evidence.
Canonical creator exclusions survive rediscovery. Audience counters support
bigint values. Query/result bounds and secret-safe failure classes are enforced.

Source/market normalization commits its downstream job in the same transaction,
including repair on duplicate retries. Delimiter-containing canonical outbox IDs
map to deterministic BullMQ-safe transport IDs; envelope/database IDs are retained.

Source smoke rolls back its outbox probe, does not reset provider state from a local
shell, and never calls live providers. It is not a hosted load or full security test.
Worker shutdown shares one drain and cannot emit a success after a forced exit.

## Deployment boundary

Forward migrations 0024, 0025 and 0026 must be verified and applied to staging through
the repaired maintenance runner before deploying this branch's discovery code.
Do not change credentials or grants blindly. Do not run the pre-repair migrator.
Deploy web/API/worker together only after migration preflight passes.

No hosted SQL, live provider requests, credential changes, Stripe activation, or
production deployment were performed by this repair. A passing CI run is not proof
of a successful hosted migration or a real YouTube creator-discovery run.

## Still required for the source-of-truth finish line

Verify legacy schema adoption against the actual hosted database, test the queued
YouTube flow on real bounded data, verify quota/failed-run/operator feedback,
validate discovered creator monitoring over time, and validate a real market source.
Complete source-to-call/score/index/shadow-prediction and customer/beta acceptance.
Production infrastructure, billing, legal review and live acceptance remain gates.
Do not state that every source-of-truth item is complete based on repository tests.


## Read-only staging handoff

From a checkout of this reviewed repair branch, run in PowerShell:

```powershell
.\scripts\staging-repair-preflight.ps1
```

The script prompts for the existing staging schema-owner connection URL without
showing it, sets DATABASE_MIGRATE_URL only for this command, and restores the
previous environment afterward. It does not reset passwords or reuse the admin
runtime URL. It calls `pnpm db:migrate -- --plan --detect-baseline`.

Baseline detection compares each historical schema in an isolated reference and
returns `baselineCandidate`, pending filenames, and maintenance role. It NEVER
writes a migration ledger or schema, and cannot be used without `--plan`.
Existing migration history still has its checksums checked. There is no forced
adoption option. Apply only the verified candidate, after a staging backup and
explicit maintenance authorization, with the same owner connection in
DATABASE_MIGRATE_URL:

```text
pnpm db:migrate -- --baseline-through <verified-version> --confirm-existing-schema
```

After a ledger exists, ordinary `pnpm db:migrate` applies only pending changes.
Runtime DATABASE_ADMIN_URL, APP_DATABASE_URL, and WORKER_DATABASE_URL stay separate.

## Automatic monitoring and operator feedback

A scheduled social sync now polls one due, automatically discovered monitored
creator and performs one bounded topic discovery. YouTube uses the channel's
uploads playlist through the official API; Reddit polls the discovered author's
submitted posts. Neither requires manual account IDs. Admin/staging one-off
searches remain capped at 10 and do not launch additional monitoring work.

Each creator poll fetches at most the latest 10 entries, with a one-hour per-creator
due time and a committed row claim. This is recent-content monitoring, not a claim
of exhaustive historical backfill. Polls share persistent HTTP budgets, honor
pauses and exclusions including changes made during HTTP, and record success or
safe failure. New observation IDs retain separate engagement snapshots while
canonical content identities and original calls are not overwritten.

The discovery page shows recent runs, accepted counts, HTTP requests, safe error
classes and each creator's last/next monitoring timestamps. Explicit operator
relevance states and first-discovery provenance survive subsequent searches.
Changing query capitalization cannot bypass a paused topic.

Initial topics also derive from at most three active catalog sets and three recent
score candidates per bootstrap, with at most 20 active derived topics per provider.
This creates search candidates, not unsupported trading recommendations.
YouTube keys are sent in the supported API-key header rather than URL parameters.
