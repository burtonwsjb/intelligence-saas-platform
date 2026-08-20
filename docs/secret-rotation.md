# Secret rotation

| Secret | Procedure (conceptual) | Invalidates |
|---|---|---|
| `BETTER_AUTH_SECRET` | Generate ≥32 bytes; deploy web; users re-authenticate | Sessions |
| `API_KEY_PEPPER` | Dual-pepper window is not implemented; rotating **breaks existing keys**. Issue new keys first, then rotate only during a planned cutover | All API keys |
| Database role passwords | `ALTER ROLE` via Neon SQL as owner; update Railway/Vercel; bounce connections | DB sessions |
| Redis | Vendor rotate + update `REDIS_URL`; worker/API restart | In-flight jobs retry |
| Stripe webhook secret | Dashboard rotate; update `STRIPE_WEBHOOK_SECRET` | Webhook verify until updated |
| Resend | Dashboard rotate `RESEND_API_KEY` | Outbound mail until updated |
| TCC / providers | Provider console; update worker/API | Ingest until updated |
| Invite tokens | Hash-only store; plaintext cannot be recovered | n/a |

Never paste rotated values into chat or git.
