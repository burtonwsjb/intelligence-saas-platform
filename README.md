# Intelligence Platform

Independent commercial multi-tenant decision intelligence SaaS.

**Core kernel** is industry-independent.  
**First commercial vertical** is TCG / trading-card market intelligence.

TCG Card Central is only a future external integration (optional reference-data provider and/or API customer). This repo does not use TCC’s stack, database, auth, hosting, email, or Stripe catalog.

## Current phase

**Phase 01 complete.** Local monorepo/application shell only.

Do not begin Phase 02 until explicitly instructed.

## Local commands

See [docs/PHASE_01.md](docs/PHASE_01.md).

```bash
pnpm install
pnpm dev:web
pnpm dev:api
pnpm dev:worker
```

TypeScript, pnpm/Turborepo, Next.js, Hono, BullMQ, PostgreSQL/Neon, Drizzle, Better Auth, Redis, R2, Resend, Stripe, Vercel, Railway.

Neon vs Supabase is compared in docs and decided before Phase 02 cloud provisioning.

## Documentation

- [Phase 00 result](docs/PHASE_00_RESULT.md)
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
| Application shell | Phase 01 complete (local only) |
| Cloud / Stripe / TCC | Not created, not connected, not modified |
