# Phase 37 — Test, CI, migration, and release hardening

Status: **complete in-repo**.

CI already runs typecheck, lint, unit, isolation, integration, and build. `git diff --check` is now a required step and is asserted by `ci-workflow.test.ts`.

PGlite tests that apply the full migration chain now allow 30s so parallel package test runs do not flake as the SQL journal grows.

Migrations remain uniquely numbered, forward-only Drizzle files. The latest committed file is `0023_phase24_provider_runtime_grants.sql`. This sprint created **no** new hosted migrations.

See [CI.md](CI.md) and [OPERATOR_RUNBOOK.md](OPERATOR_RUNBOOK.md).
