# Read-only migration drift diagnostics

PROJECT_SOURCE_OF_TRUTH.md remains controlling. This change does not authorize a
migration, baseline adoption, schema rewrite, ownership transfer, or deployment.

## Why the former preflight output was insufficient

The old detector discarded each prefix's schema mismatch and printed only
"No historical migration prefix matches". That identifies neither the objects
that differ nor the kind of difference. It cannot justify changing credentials,
adding grants, guessing a baseline, or manually applying a pending migration.

A reproduced verifier defect also allowed session search_path to change
pg_get_constraintdef and related catalog output for an identical schema. Catalog
snapshots now use the same transaction-local path, restored before returning.
No SQL text is stripped and no missing constraints or unexpected objects are
ignored to obtain a match. This is a verified code defect, not evidence that this
particular setting caused the owner's staging mismatch.

## Run the updated preflight

On fix/scope-truth-release-repair, fetch the reviewed code with `git pull --ff-only`
and run `./scripts/staging-repair-preflight.ps1`. Use the existing authorized
schema-owner URL at the hidden prompt. Do not send the URL or password in chat.
The script still runs only `db:migrate -- --plan --detect-baseline`.

Planning uses a PostgreSQL READ ONLY, REPEATABLE READ transaction. The detector
reads target catalogs once and constructs historical prefixes incrementally in
one isolated in-memory reference database. Historical SQL is never executed on
the target during detection.

## Interpreting a mismatch

An unmatched schema emits a `db.migration_drift` JSON diagnostic before exiting
nonzero. It contains:

- `exactMatch: false`, always, for a mismatch.
- At most three nearest historical comparisons with difference counts.
- The closest comparison's catalog groups: relations, columns, constraints,
  indexes, policies, triggers, and functions.
- Missing, unexpected, and changed counts; up to five examples per group.
- The names of changed fields, not their contents.

A nearest comparison is NOT a valid baseline and must never be adopted merely
because it has the fewest differences. The reported objects must be investigated
and any actual schema repair reviewed separately.

Only identifiers present in the repository-built comparison are printed as
names. Unrecognized target identifiers are replaced with opaque fingerprints.
Function bodies, defaults, expressions, row contents, hostnames, URLs, passwords,
and provider keys are not included. Totals remain available when examples are
truncated. Return this safe diagnostic output, not a raw schema dump.

An exact match still produces a plan only. It does not create migration history,
apply pending migrations, change ownership or permissions, enable a provider,
or deploy code. Hosted acceptance remains unverified until the actual staging
preflight and separately authorized release sequence succeed.
