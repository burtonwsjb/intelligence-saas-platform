# Intelligence Platform

Independent commercial multi-tenant decision intelligence SaaS.

This repository is a greenfield product. It does not use TCG Card Central’s stack, database, auth, hosting, email, or Stripe catalog.

TCG Card Central is only a future external integration: a potential TCG reference-data API provider, and one possible customer of this platform’s intelligence APIs.

## Current phase

**Phase 00 in progress — documentation only.**

Do not begin Phase 01 until explicitly instructed.

## Planned stack (not provisioned)

- Next.js console on Vercel
- Hono commercial API + BullMQ worker on Railway
- Neon Postgres, Drizzle, Better Auth, Redis, Cloudflare R2, Resend, Stripe

## Documentation

- [Phase 00 result](docs/PHASE_00_RESULT.md)
- [Architecture overview](docs/architecture/00-overview.md)
- [Stack selection](docs/architecture/13-stack-selection.md)
- [Product scope](docs/architecture/01-product-scope.md)
- [System architecture](docs/architecture/02-system-architecture.md)
- [Integrations](docs/architecture/07-integrations.md)
- [Phase roadmap](docs/architecture/11-phase-roadmap.md)
- [Decisions log](docs/architecture/12-decisions-log.md)

## Status

| Work | Status |
|---|---|
| Architecture docs | In progress (Phase 00) |
| Application scaffold | Not started |
| Neon / Vercel / Railway / Redis / R2 | Not created |
| Stripe | Not connected |
| Resend | Not connected |
| TCG Card Central | Not connected, not modified |
| Production APIs | Not created |
