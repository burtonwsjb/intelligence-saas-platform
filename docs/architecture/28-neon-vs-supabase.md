# Neon + Better Auth vs Supabase

**Status:** comparison documented for an intentional choice **before Phase 02 cloud provisioning**.  
**This pass does not switch stacks.**

The proposed stack (Neon + Better Auth + Drizzle + RLS) remains **provisionally approved**.

## Why this comparison exists

Phase 02 will create a real database and auth. That is the last responsible moment to pick a vendor. The choice must be independent of TCG Card Central (which uses Supabase).

## Side-by-side

| Concern | Neon + Better Auth + Drizzle | Supabase (Postgres + Auth + RLS) |
|---|---|---|
| Postgres | Standard Postgres, branches, scale-to-zero staging | Standard Postgres, convenient dashboard |
| RLS | We own policies in migrations | First-class RLS + client tooling |
| Auth / B2B orgs | Better Auth organizations, invites, our schema | Email/OAuth strong; org model is thinner |
| API keys | First-party (required either way) | First-party (required either way) |
| Storage | R2 already planned | Bundled storage; still may want R2 |
| DX | More pieces to wire | Faster first login |
| Lock-in | Auth and DB can be replaced separately | Auth+DB+storage tend to couple |
| Intelligence jobs | Irrelevant; both are Postgres | Same |
| Cost | Neon + Auth self-host is often cheaper at seat scale | Predictable project pricing; Auth included |
| Multi-tenant B2B | Better fit for org/tenant as a product | Possible, more custom tables anyway |
| TCC similarity | None | Superficial overlap; not a reason to choose it |

## Provisional recommendation (not locked)

Keep **Neon + Better Auth** unless Phase 02 discovery shows:

- Better Auth org/invite gaps that would slip the foundation, or
- operational need for Supabase’s bundled Auth UI/storage that outweighs lock-in

If Supabase is chosen later, it is still a **new** project, never TCC’s project, and Drizzle + RLS + first-party API keys remain.

## Decision gate

Record the final choice in [12-decisions-log.md](./12-decisions-log.md) at the start of Phase 02. Do not provision either cloud in Phase 00 or Phase 01.
