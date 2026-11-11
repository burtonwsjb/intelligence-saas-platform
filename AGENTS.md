# Project execution rules

Read PROJECT_SOURCE_OF_TRUTH.md in full before planning or changing code. It is
owner-controlled. Do not modify it to make incomplete behavior appear finished.

For the unified product-completion work, also read
`docs/MASTER_COMPLETION_PHASE.md` and `docs/MASTER_ACCEPTANCE_CHECKLIST.md`.
They record the owner's cache-first market integration and clean, visual,
bounded-page UI direction. They do not replace the source of truth. Keep the
requirement-level evidence register current and distinguish engineering staging
readiness, owner acceptance, and full production/source-of-truth completion.

Automatic topic discovery must create canonical creator identities and feed real
recurring monitoring and the existing ingestion pipeline. Manual account IDs are
optional seeds, never a prerequisite. Popularity is not historical authority.

Before reporting completion, verify the actual commit, changed files and exact
CI results. Separate implemented, fixture-tested, hosted-validated and production
states. A green CI run is not evidence of successful hosted provider ingestion.

Use DATABASE_MIGRATE_URL only for authorized maintenance. Never replay historical
SQL on an untracked database, guess a baseline, transfer table ownership, reset
credentials, or weaken runtime RLS to get a deployment through. Read-only repair
preflight is documented in docs/REPAIR_RELEASE.md.

Keep external requests bounded and auditable, preserve operator exclusions and
source provenance, and retain prediction shadow gates. Do not deploy, activate
additional live providers, enable Stripe live, or run hosted migrations without
owner authorization. Finish tests before handing a release to the operator.
