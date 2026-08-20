# Data retention (provisional)

Do not arbitrarily delete accountability history.

| Category | Direction |
|---|---|
| Auth sessions | short-lived; expired rows may be purged |
| CRM / tenant profile | life of tenant + legal hold |
| Tenant audit | retain; append-only |
| Platform break-glass | retain; append-only |
| Market history | global reference; not deleted with a tenant |
| Source intelligence | retain with creator history even if creator is excluded |
| Predictions / outcomes | immutable; no silent delete |
| Usage | monthly aggregates retained for billing disputes |
| Email logs | metadata only; no bodies with secrets |
| Webhook logs | excerpts only |
| Support / feedback | retain for ops; not public |

Tenant deletion must not destroy global public market/reference data. See [privacy-export-deletion.md](./privacy-export-deletion.md).
