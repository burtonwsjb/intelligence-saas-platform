# Auth and identity

## Providers

v1 uses **Better Auth** with the organization model, talking to this product’s own Postgres.

| Method | Phase |
|---|---|
| Email magic link | first implemented auth |
| Email + password | optional follow-on |
| Member invitations | with tenants |
| SSO (SAML/OIDC via WorkOS or equivalent) | later, when an enterprise tenant needs it |
| API keys | machine clients, required for the commercial API |

Do not use TCG Card Central auth, Facebook login, Lovable auth, or any other product’s sessions.

## Browser identity

1. User authenticates with Better Auth
2. A `profiles` row is created on first login
3. If the user has no membership, the app creates a tenant, owner membership, and CRM account
4. Session carries `user_id` and selected `tenant_id`
5. Web and API session routes refuse to run without both, except signup/join routes

Invites: an admin adds an email via Resend; the invited user signs in; membership becomes `active`.

## Machine identity

API keys are the only machine principal in v1. They are verified by `apps/api`, not by the browser session stack.

Format (planned): `isp_<env>_<random>`

- `isp_test_...` for local/staging
- `isp_live_...` for production

Storage:

- prefix stored for display
- SHA-256 hash plus `API_KEY_PEPPER`
- plaintext shown once

Scopes:

- `ingest:write`
- `decisions:read`
- `receipts:write`

A key with only `decisions:read` cannot ingest. A key cannot escape its tenant.

## Database roles

| Role | Used by | Privilege |
|---|---|---|
| `app_user` | web and API after tenant context is set | RLS-constrained |
| `app_worker` | worker after tenant context is set | RLS-constrained writes for jobs |
| `app_migrate` | migration runner | DDL |
| `app_admin` | break-glass platform admin | audited, not used by tenants |

There is no Supabase service role. Server processes set `SET LOCAL app.tenant_id = ...` (or equivalent) before queries so RLS can enforce isolation.

## TCG Card Central identities later

When TCC is a **customer**, it uses a normal tenant API key issued by this platform.

When TCC is a **provider**, this platform stores connector credentials and calls TCC’s future versioned API. This platform will not accept TCC user JWTs and will not use TCC database keys.

## Session threats

| Threat | Control |
|---|---|
| Stolen browser session | HTTP-only cookies, HTTPS, short session lifetime |
| Stolen API key | Hash at rest, prefix-only display, rotation, last-used tracking |
| Tenant hopping | Membership check + Postgres RLS |
| Webhook forgery | Stripe signing secret; later HMAC for foreign connectors |
| Privilege escalation | Role checks on every mutating route |

## Platform admin

Platform admins are a server-checked `platform_admins` grant, not a tenant role. Break-glass tenant inspection writes an audit row.
