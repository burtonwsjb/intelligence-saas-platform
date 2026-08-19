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
| D11 | Database / auth | Neon + Drizzle + Better Auth | **Phase 02 decision.** Standard Postgres + RLS; Better Auth organizations for B2B tenants. Not Supabase. Independent of TCG Card Central. |
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
| D25 | Stack lock | Phase 02 locked Neon + Drizzle + Better Auth + RLS | Other hosting/email/billing vendors remain for later phases |
| D26 | Database roles | `app_migrate` / `app_user` / `app_worker` / `app_admin` | Least privilege; runtime is not superuser and cannot bypass RLS |
| D27 | Active-tenant RLS | Policies bind to the active organization + membership in that org | Multi-membership must not widen a request scoped to A |
| D28 | Billing source of truth | Application DB entitlements; Stripe is the processor | Do not call Stripe on every request |
| D29 | API keys | `isp_test_` prefix, HMAC-SHA256 + pepper, tenant-bound scopes | Shown once; never stored plaintext |
| D30 | Machine RLS | `principal_type=machine` + validated key row | Does not weaken browser membership isolation |
| D31 | Quota | Database monthly aggregates; 402 entitlement / 429 quota | Stripe meters deferred |
| D32 | Local billing simulation | Default non-production billing mode; no Stripe network or IDs | Hosted Checkout/Portal deferred; entitlements use normalized `tenant_billing` |
| D33 | Queue package | `@isp/queue` owns Redis factory, names, envelopes, retries | Do not scatter raw BullMQ names across apps |
| D34 | Ingest durability | `source_event` + `outbox_job` in one transaction before Redis | Lost-work is forbidden; Redis down still returns 202 |
| D35 | Job identity | BullMQ `jobId` = outbox id; envelope is Zod-validated | Publisher retry is safe; unknown types fail closed |
| D36 | Ingest usage | Meter `ingest.events` once per tenant idempotency key | Duplicate replay and publish retry must not double-charge |
| D37 | Kernel module | `@isp/db` `normalizeSourceEvent` plus `@isp/contracts` types own deterministic `source_event` → observation/entity mapping | Keep TCG identity and scoring out of generic tables; no extra lockfile package |
| D38 | Entity matching (Phase 06) | Exact identifier lookup or create; no fuzzy merge | Phase 10 owns multi-source / mention resolution |
| D39 | Observation identity | `observation.id` = `source_event.id`; unique per tenant event | Idempotent normalize; one fact set per accepted event |
| D40 | Source catalog | Platform `source_definition` with reliability prior; no credentials | Connector instances and secret_ref stay later |
| D41 | Confidence | Normalized 0..1 numeric; observations nullable; signals required | Do not invent confidence or conflate with quality flags |
| D42 | Analytical immutability | Triggers + revoked UPDATE/DELETE on fact tables | History is append-only; corrections are new rows |
| D43 | TCG pack location | TCG schema/modules in `@isp/db` + contracts in `@isp/contracts`; Zod in `apps/api` | Avoid a new lockfile workspace package; keep kernel tables generic |
| D44 | TCG reference data | Platform-global games/sets/concepts/printings/identifiers; no tenant RLS | Canonical identity is shared reference data, not tenant-duplicated |
| D45 | TCG identity key | `tcg:{game}:{concept}:{set}:{normalized_collector}:{language}:{variant}` | Name+number is forbidden; language and variant are mandatory |
| D46 | Printing identifiers | Immutable alias map; rebind writes `tcg_identifier_conflict` and throws | No silent remap when TCC/external ids change |
| D47 | Kernel link | Per-tenant `entity_type=tcg_printing` keyed from the printing canonical key | Domain identity stays global; analytical subject stays tenant-scoped |
| D48 | TCC in Phase 07 | `SandboxTcgCardCentralProvider` fixtures only | No network, no production URL, no real token |
| D49 | TCG market facts | Platform-global `tcg_market_snapshot` keyed by exact printing; no tenant RLS | Do not duplicate licensed/shared provider observations per tenant |
| D50 | Market vs kernel | TCG market metadata stays in pack tables; optional tenant observation projection | Kernel tables remain industry-neutral |
| D51 | Market ingest jobs | `tcg.market.normalize.v1` on `tcg_market_ingest`, not tenant `outbox_job` | Market ingest is platform operational data |
| D52 | Spread formula | `spread.v1` = `lowest_ask_minus_latest_sold` | Explicit units; do not treat listing as sold |
| D53 | Outlier handling | Flag with `outlier.v1`; never delete raw history | Later analytics may filter |
| D54 | Phase 08 providers | In-memory fixture TCC/TCGplayer/eBay only | No network, no credentials |
| D55 | Source intelligence data | Platform-global accounts/content/mentions; no tenant RLS | Public source personalities are shared reference data |
| D56 | Source ingest jobs | `source.intelligence.normalize.v1` on `source_ingest` | Not tenant `outbox_job`; not generic `/v1/events` |
| D57 | Copyright retention | Bounded excerpts (500 chars) + hashes + URL references | No full transcript archive in Phase 09 |
| D58 | Phase 09 providers | In-memory YouTube/Reddit fixtures only | No scrape, no live API |

## Void

- TanStack Start / TCC-similar stack as foundation
- “TCG is an optional later pack”
- “v1 success does not require TCG”
- Generic `/events`+`/decisions` as the only customer API
- Supabase as the Phase 02 database/auth platform

## Open questions

- Public brand and domains
- Exact prices (not to be finalized in Phase 00)
- Final commercial URL paths
- Whether TCC ships a versioned reference API, and when
- Redis vendor
- Licensed market-data sources besides TCC
- YouTube/Reddit ToS and transcript licensing details (reviewed before Phase 09)
- CRM sync target (Attio vs HubSpot) later
