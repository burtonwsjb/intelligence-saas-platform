# Architecture decisions

Change only with an explicit new decision.

| ID | Decision | Choice | Why |
|---|---|---|---|
| D01 | Product type | Independent commercial multi-tenant decision intelligence SaaS | Greenfield, not a module of another app |
| D02 | TCG Card Central | External provider API and/or API customer only | Not a stack or database |
| D03 | Tenancy | Shared schema + `tenant_id` + Postgres RLS | Isolation without DB-per-tenant |
| D04 | First commercial vertical | TCG market intelligence | Proves the kernel; not optional |
| D05 | Kernel | Industry-independent observations/signals/scores/predictions/content | Later industries must not require a rewrite |
| D06 | Generic HTTP ingest | Supporting capability, not the v1 product | Reusable, not the commercial wedge |
| D07 | Language / repo | TypeScript, pnpm, Turborepo, web/api/worker | **Provisionally approved** |
| D08 | Console | Next.js App Router | **Provisional** |
| D09 | Public API | Hono + OpenAPI + commercial domains | Intelligence products, not only /events |
| D10 | Worker | BullMQ + Redis | Intelligence jobs |
| D11 | Database / auth | Neon + Drizzle + Better Auth | **Provisional**; compare Supabase before Phase 02 cloud |
| D12 | Objects / email / billing | R2, Resend, Stripe | Independent GTM |
| D13 | Hosting | Vercel + Railway | **Provisional** |
| D14 | TCG identity | Concept / printing / variant / inventory / grade; language in the key | Name+number is forbidden |
| D15 | Cross-language books | Separate unless an explicit cross-language job | EN/JA/ZH are different markets |
| D16 | Resolution | Persisted statuses; never silent ambiguous binds | Safety |
| D17 | Creator authority | Contextual slices + shrinkage; trust states | Not one number; not 4/4 > 730/1000 |
| D18 | Sample-size method | Hierarchical Bayesian shrinkage + Wilson/credible intervals | Defensible ranking |
| D19 | Alpha | Vs language/era/set/tier benchmark | Do not reward beta as skill |
| D20 | Opportunity | Separate opportunity/risk/confidence/liquidity/recommendation | Explainable |
| D21 | Predictions | Horizons + ranges + immutable accountability | No silent deletes |
| D22 | Content | Evidence package before generation | No AI spam |
| D23 | Webhooks | Signed, retried, logged, disable-on-fail | API product |
| D24 | Cross-tenant learning | Forbidden unless later consented | Isolation |
| D25 | Stack lock | Provisional until Phase 02 vendor gate | Review instruction |

## Void

- TanStack Start / TCC-similar stack as foundation
- “TCG is an optional later pack”
- “v1 success does not require TCG”
- Generic `/events`+`/decisions` as the only customer API
- Irrevocable Neon lock without the Phase 02 comparison

## Open questions

- Public brand and domains
- Exact prices (not to be finalized in Phase 00)
- Final commercial URL paths
- Whether TCC ships a versioned reference API, and when
- Redis vendor
- Neon vs Supabase at Phase 02 gate
- Licensed market-data sources besides TCC
- YouTube/Reddit ToS and transcript licensing details (reviewed before Phase 09)
- CRM sync target (Attio vs HubSpot) later
