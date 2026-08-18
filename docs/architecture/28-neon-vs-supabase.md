# Neon + Better Auth vs Supabase

**Status:** Phase 02 decision is **Neon + Drizzle + Better Auth + PostgreSQL RLS**.

Do **not** use Supabase for this product.

Do **not** use TCG Card Central’s database, auth, or project.

## Why this comparison existed

Phase 02 creates the first real database and auth. That was the last responsible moment to pick a vendor independently of TCG Card Central (which uses Supabase).

## Side-by-side

| Concern | Neon + Better Auth + Drizzle | Supabase (Postgres + Auth + RLS) |
|---|---|---|
| Postgres | Standard Postgres, branches, scale-to-zero staging | Standard Postgres, convenient dashboard |
| RLS | We own policies in migrations | First-class RLS + client tooling |
| Auth / B2B orgs | Better Auth organizations, invites, roles, access control | Email/OAuth strong; org model is thinner |
| API keys | First-party (required either way) | First-party (required either way) |
| Storage | R2 already planned | Bundled storage; still may want R2 |
| DX | More pieces to wire | Faster first login |
| Lock-in | Auth and DB can be replaced separately | Auth+DB+storage tend to couple |
| Intelligence jobs | Irrelevant; both are Postgres | Same |
| Cost | Neon + Auth self-host is often cheaper at seat scale | Predictable project pricing; Auth included |
| Multi-tenant B2B | Better fit for org/tenant as a product | Possible, more custom tables anyway |
| TCC similarity | None | Superficial overlap; not a reason to choose it |

## Phase 02 decision

**Choose Neon + Better Auth.**

Reasons:

- The tenant model is a B2B organization with memberships, invitations, and roles. Better Auth’s organization plugin matches that without inventing a parallel membership system.
- RLS remains a PostgreSQL control. Neon is Postgres. Supabase is not required to get RLS.
- Auth and database stay separable.
- Using Supabase because TCG Card Central uses it would couple this SaaS to another product’s ecosystem.

Local Phase 02 development may use disposable Docker Postgres or PGlite for tests. That does not change the cloud vendor. Production/staging Postgres, when provisioned, is Neon.

If a later explicit decision reopens this, it still must be a **new** project, never TCC’s project, and Drizzle + RLS + first-party API keys remain.
