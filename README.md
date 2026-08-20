# Intelligence Platform

Independent commercial multi-tenant decision intelligence SaaS.

**Core kernel** is industry-independent.  
**First commercial vertical** is TCG / trading-card market intelligence.

TCG Card Central is only a future external integration (optional reference-data provider and/or API customer). This repo does not use TCC’s stack, database, auth, hosting, email, or Stripe catalog.

## Current phase

**Phase 20 complete locally.** Platform admin console, `platform_admins` grants, break-glass audit, and creator exclusion without deleting history. Cloud Redis and Neon are not provisioned. Stripe live mode is forbidden. See [docs/PHASE_20.md](docs/PHASE_20.md).

Do not begin Phase 21 until explicitly instructed.

## Local commands

See [docs/PHASE_01.md](docs/PHASE_01.md), [docs/PHASE_02.md](docs/PHASE_02.md), and [docs/PHASE_03.md](docs/PHASE_03.md).

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm test:isolation
pnpm test:integration
pnpm build
pnpm dev:web
pnpm dev:api
pnpm dev:worker
```

TypeScript, pnpm/Turborepo, Next.js, Hono, PostgreSQL/Neon, Drizzle, Better Auth, BullMQ, local Docker Redis. Later: R2, Resend, Stripe, Vercel, Railway.

## Documentation

- [Phase 00 result](docs/PHASE_00_RESULT.md)
- [Phase 01](docs/PHASE_01.md)
- [Phase 02](docs/PHASE_02.md)
- [Phase 03](docs/PHASE_03.md)
- [Phase 04](docs/PHASE_04.md)
- [Phase 05](docs/PHASE_05.md)
- [Phase 06](docs/PHASE_06.md)
- [Phase 07](docs/PHASE_07.md)
- [Phase 08](docs/PHASE_08.md)
- [Phase 09](docs/PHASE_09.md)
- [Phase 10](docs/PHASE_10.md)
- [Phase 11](docs/PHASE_11.md)
- [Phase 12](docs/PHASE_12.md)
- [Phase 13](docs/PHASE_13.md)
- [Phase 14](docs/PHASE_14.md)
- [Phase 15](docs/PHASE_15.md)
- [Phase 16](docs/PHASE_16.md)
- [Phase 17](docs/PHASE_17.md)
- [Phase 18](docs/PHASE_18.md)
- [Phase 19](docs/PHASE_19.md)
- [Phase 20](docs/PHASE_20.md)
- [CI](docs/CI.md)
- [Overview](docs/architecture/00-overview.md)
- [Roadmap (phases 00–23)](docs/architecture/11-phase-roadmap.md)
- [TCG identity](docs/architecture/17-tcg-canonical-identity.md)
- [TCG market intelligence](docs/architecture/18-tcg-market-intelligence.md)
- [Creator intelligence](docs/architecture/21-creator-intelligence.md)
- [Prediction engine](docs/architecture/24-prediction-engine.md)
- [Commercial API and webhooks](docs/architecture/27-commercial-api-and-webhooks.md)

## Status

| Work | Status |
|---|---|
| Architecture docs | Phase 00 complete |
| Application shell | Phase 01 complete |
| Database / auth / tenant | Phase 02 complete locally; Neon cloud not provisioned |
| RLS / RBAC / isolation | Phase 03 complete locally; proven in CI Postgres |
| Billing / API keys | Phase 04 complete locally; local simulation default; Stripe Checkout deferred |
| Queue / ingest | Phase 05 complete locally; Docker Redis + Postgres; no cloud Redis |
| Intelligence kernel | Phase 06 complete locally; generic entities/observations/signals; no TCG columns on kernel tables |
| TCG identity / TCC sandbox | Phase 07 complete locally; fixture provider only; no real TCC calls |
| TCG market history | Phase 08 complete locally; fixture providers only; no real TCC/TCGplayer/eBay calls |
| Source intelligence ingest | Phase 09 complete locally; YouTube/Reddit fixtures only; no scrape |
| Entity resolution | Phase 10 complete locally; language/variant-safe; no silent binds |
| Creator call extraction | Phase 11 complete locally; fixture extractor only; no authority score |
| Creator authority | Phase 12 complete locally; Wilson/Bayes shrinkage; no buy/sell |
| Market analytics / indices | Phase 13 complete locally; language-separated; no recommendations |
| Opportunity scoring | Phase 14 complete locally; four scores + explained recommendation; uncalibrated v1 |
| Prediction engine | Phase 15 complete locally; shadow statistical baseline; immutable outcomes |
| Commercial API / webhooks | Phase 16 complete locally; scoped `/v1` contracts; SSRF-safe webhooks; no deploy |
| CRM / email / billing lifecycle | Phase 17 complete locally; local/fixture email; TBD prices; no Resend/Stripe live |
| Customer intelligence dashboard | Phase 18 complete locally; shadow predictions remain hidden |
| Content / SEO intelligence | Phase 19 complete locally; evidence packages + local generators; no live LLM |
| Platform admin | Phase 20 complete locally; `platform_admins` grant; creator exclude keeps history |
| Cloud / Stripe live / TCC production | Not created, not connected, not modified |
