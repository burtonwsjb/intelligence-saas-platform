# Multi-tenancy

## Model

**Shared database. Shared schema. Tenant column on every tenant-owned row. RLS as the last line of defense.**

This is the only tenancy model authorized for v1.

Not authorized in v1:

- Database-per-tenant
- Schema-per-tenant
- Cross-tenant query views
- Shared cache keys without a tenant prefix

## Tenant

A tenant is the billing and isolation root.

| Field | Meaning |
|---|---|
| `id` | UUID primary key |
| `slug` | Unique public identifier, immutable after create |
| `name` | Display name |
| `status` | `active` · `suspended` · `deleted` |
| `created_at` | Timestamp |

One signup creates one tenant and one owner membership. Additional tenants per user are allowed later; v1 may keep a user on one active tenant in the console.

## Membership roles

| Role | Capabilities |
|---|---|
| `owner` | Billing, delete tenant, transfer ownership, all admin powers |
| `admin` | Members, API keys, connectors, policies |
| `analyst` | Read data, manage policies they are allowed to edit, accept/reject decisions |
| `viewer` | Read decisions, entities, and usage |

A user may belong to multiple tenants. The console always has exactly one **active tenant** in session context.

## Isolation rules

1. Every tenant-owned table has `tenant_id uuid not null`.
2. Application queries always include `tenant_id`.
3. RLS policies require `tenant_id` to match `current_tenant_ids()` derived from memberships.
4. API keys are bound to exactly one tenant.
5. Jobs, logs, cache keys, storage paths, and Stripe metadata include `tenant_id`.
6. A request with no tenant context cannot read tenant data.

## Context binding

| Client | How tenant is bound |
|---|---|
| Browser | Session user → memberships → selected `tenant_id` |
| API key | Key row → `tenant_id` |
| Stripe webhook | `metadata.tenant_id` plus Stripe customer mapping |
| Worker job | BullMQ job payload → `tenant_id` |
| Platform admin | No tenant context unless impersonating through an audited break-glass path |

## Platform operator vs tenant

Platform operators are **not** a tenant role.

They use a separate `platform_admins` grant, server-only, and an `/admin` surface. They may view tenant status, billing state, and connector health. They may not silently read raw source payloads unless a support action is audited.

## Connector isolation

A connector instance belongs to one tenant. Credentials for that connector are stored as secrets referenced by the connector row, never in browser-readable config.

An external system such as TCG Card Central, when connected later, is either a normal API customer, a reference-data provider behind a connector, or both. Its users do not automatically become platform users.

## Data residency and pooling

v1 assumes a single Neon region.

Cross-tenant aggregation is forbidden unless a later phase defines a consented, anonymized product. Decision models in v1 are policy documents per tenant, not shared trained models.

## Soft delete

Tenants and members are soft-deleted. Source events and Decision Records are retained for the tenant retention window, then deleted or exported. v1 default retention: **90 days** of source events, **365 days** of Decision Records, overridable later per plan.

## Abuse and suspension

`tenants.status = suspended` blocks ingest and decision reads except for owner billing access. The worker must skip jobs for suspended tenants.
