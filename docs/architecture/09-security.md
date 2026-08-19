# Security

## Trust boundaries

| Zone | Trust |
|---|---|
| Browser | Untrusted |
| `apps/web` | Trusted for the authenticated user only |
| `apps/api` | Trusted for the authenticated API key or session only |
| `apps/worker` | Trusted, must still carry `tenant_id` |
| Postgres `app_user` / `app_worker` | Constrained by RLS |
| Postgres `app_admin` | Break-glass, audited |
| Redis | Trusted cache/queue; tenant-prefix all keys |
| R2 | Tenant-prefix all object keys |
| Stripe | Trusted after signature check |
| Resend | Trusted for outbound mail only |
| TCG Card Central | Untrusted foreign system; later API token or HMAC only |

## Tenant isolation

Postgres RLS is mandatory on every tenant-owned table. Application filters are not enough. The runtime role is `app_user` (no `BYPASSRLS`). Context is transaction-local (`app.current_organization_id` + `app.current_user_id`) and bound to the active tenant only.

API keys cannot select a different tenant. Machine requests set transaction-local `app.current_principal_type=machine` and `app.current_api_key_id`. Prefix and Stripe-customer lookups use constrained `SECURITY DEFINER` functions plus `app_migrate`-only SELECT policies; they do not grant `app_user` a tenant bypass. `source_event`, `outbox_job`, and Phase 06 kernel tables (`entity`, `entity_identifier`, `observation`, `observation_metric`, `evidence_reference`, `feature_snapshot`, `signal`, `signal_evidence`, `decision_record`, `decision_evidence`) are tenant-owned with FORCE RLS. Composite foreign keys `(organization_id, id)` block cross-tenant evidence and entity links. Worker jobs carry `organization_id` in a versioned envelope and must match the durable source event or fail permanently. Redis queue names are environment-prefixed (`isp-{env}-ingest`); they do not include secrets. BullMQ 5 forbids `:` in queue names. Caller `x-request-id` is correlation only. Platform admin access is audited. Analytical history is append-only for application roles; see [PHASE_06.md](../PHASE_06.md).

## Secrets

- Hash API keys with `API_KEY_PEPPER`
- Never log Authorization headers, Stripe secrets, or raw API keys
- Never commit `.env`
- Rotate keys by issuing a new key and revoking the old one
- Store foreign API tokens (including a future TCC token) as `secret_ref`, not browser-readable config

## Input and payload safety

- Zod-validate every external payload
- Cap payload size on ingest (Phase 05 default: 65536 bytes)
- Store source payloads, but do not render them as HTML
- Do not evaluate policy documents as code; rules are data interpreted by a fixed engine
- Outbound HTTP only to allowlisted connector bases, never to tenant-supplied arbitrary URLs in v1
- Source intelligence text is untrusted; excerpts are bounded and never executed as HTML or prompts
- Entity resolution history is platform-global and append-only; tenants cannot insert or rewrite attempts
- Creator calls are platform-global and immutable; tenants cannot insert or rewrite calls
- Creator authority slices and trust events are append-only platform facts

## Decision integrity

A Decision Record stores the policy version, the feature snapshot, and rationale citations. Policies are versioned and immutable once published.

## Webhooks

Stripe webhooks verify the signing secret. Replay is handled by Stripe event id idempotency.

Foreign connector webhooks, if added, require HMAC and timestamp skew limits.

## Data minimization

Connectors should send identifiers, measures, and decision-relevant attributes. They should not send passwords, payment instruments, or unrelated customer messages.

If this platform later calls a TCG Card Central reference API, it requests only the fields needed for features, and it does not persist a full shadow catalog unless a later phase explicitly allows a bounded cache.

## Retention

See [03-multi-tenancy.md](./03-multi-tenancy.md).

## Vulnerability classes

| Class | v1 control |
|---|---|
| IDOR / tenant hop | membership + RLS |
| API key leak | hash, prefix, rotate, last-used |
| Mass assignment | Zod allowlists |
| Queue poison | isolated BullMQ jobs, bounded retries |
| SSRF | tenant webhook URLs validated (no loopback/RFC1918/link-local/metadata/non-http); delivery tests use fixtures |
| Prompt injection | no free-form model execution in v1 policy engine |

## v1 policy engine constraint

The first decision engine is **deterministic rules**, not an LLM.
