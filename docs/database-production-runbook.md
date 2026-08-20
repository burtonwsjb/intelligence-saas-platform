# Database production runbook

Not to be executed without production authorization.

1. Provision a **separate** Neon project from staging.
2. Unpooled owner URL → `pnpm db:migrate` then `pnpm db:bootstrap`.
3. Validate: isolation-style RLS smoke (`pnpm test:isolation` against a disposable clone, not prod).
4. Point API `DATABASE_URL` at pooled `app_user`; worker `WORKER_DATABASE_URL` at `app_worker`.
5. Post-deploy: `/ready`, login, API key call, admin grant check.
6. Rollback: restore from Neon PITR/backup to a new branch; do not DROP production. Prefer forward-fix migrations.
7. Backups: enable Neon PITR/backup per plan **before** traffic. Until provisioned, backups do not exist.
