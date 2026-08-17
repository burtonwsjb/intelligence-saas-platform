# Phase 01 — local monorepo shell

Status: **implemented**. Do not begin Phase 02 until instructed.

## Layout

```text
apps/web          Next.js App Router chrome (port 3000)
apps/api          Hono GET /health (port 3001)
apps/worker       Node no-op process
packages/config   shared TypeScript + ESLint configs
packages/contracts  HealthResponse / healthOk()
packages/shared   isNonEmptyString()
```

## Commands (from repo root)

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm dev:web
pnpm dev:api
pnpm dev:worker
```

After `pnpm build`:

```bash
pnpm start:web
pnpm start:api
pnpm start:worker
```

## Phase 01 verification (done)

- Workspaces: `@isp/web`, `@isp/api`, `@isp/worker`, `@isp/config`, `@isp/contracts`, `@isp/shared`
- `GET http://127.0.0.1:3001/health` → `{ "status": "ok" }`
- Web `/`, `/login`, `/signup`, `/app`, `/admin` return 200
- Worker logs `worker: idle (phase 01 no-op)` and stays up without Redis/BullMQ/DB
- No Neon, Supabase, Stripe, Railway, Vercel, TCC, or secrets

## Not in this phase

Auth, CRM, billing, TCG intelligence, `/v1` APIs, database, Neon vs Supabase decision.
