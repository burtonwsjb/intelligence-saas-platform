# Backup and recovery expectations

No cloud backups exist until Neon (and optional object storage) are provisioned.

Provisional architecture targets (not contractual):

| | Staging | Production (future) |
|---|---|---|
| RPO | 24h | 1h (Neon PITR if plan allows) |
| RTO | 8h | 4h |

Restore validation: restore to a throwaway Neon branch, run `pnpm db:migrate` no-op, run a subset of isolation tests, then destroy the branch.

Migration rollback: forward-fix. Destructive resets are forbidden.
