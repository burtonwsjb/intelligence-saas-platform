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
Catalog-format differences or partial migrations fail closed and need review.
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

Forward migrations 0024 and 0025 must be verified and applied to staging through
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
