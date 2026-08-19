# Intelligence Platform

Independent commercial multi-tenant decision intelligence SaaS.

**Core kernel** is industry-independent.  
**First commercial vertical** is TCG / trading-card market intelligence.

TCG Card Central is only a future external integration (optional reference-data provider and/or API customer). This repo does not use TCC’s stack, database, auth, hosting, email, or Stripe catalog.

## Current phase

**Phase 05 complete locally.** Redis/BullMQ via `@isp/queue`, generic `POST /v1/events`, durable `source_event` + outbox, and a real worker normalize stub. Cloud Redis and Neon are not provisioned. Stripe live mode is forbidden. See [docs/PHASE_05.md](docs/PHASE_05.md).

Do not begin Phase 06 until explicitly instructed.

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
- [CI](docs/CI.md)
- [Overview](docs/architecture/00-overview.md)
- [Roadmap (phases 00–23)](docs/architecture/11-phase-roadmap.md)
- [TCG identity](docs/architecture/17-tcg-canonical-identity.md)
- [TCG market intelligence](docs/architecture/18-tcg-market-intelligence.md)
- [Creator intelligence](docs/architecture/21-creator-intelligence.md)
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
| Cloud / Stripe live / TCC | Not created, not connected, not modified |
| Phase 06 observations / signals | Not started |
