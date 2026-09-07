# Social Signal IQ — Project Source of Truth

**Status: AUTHORITATIVE**

This file is the single source of truth for Social Signal IQ. If any roadmap, phase document, fixture, prompt, UI behavior, or current implementation conflicts with this file, **this file wins**. Do not weaken requirements to match incomplete code. Fix the code to match this document.

## Product mission

Social Signal IQ is a standalone, commercial, multi-tenant decision-intelligence SaaS. Its job is to continuously discover, collect, connect, score, and explain market, social, creator, and trend signals so users can understand what is moving, why, who is influencing it, whether signals are credible, whether the market confirms them, and what to watch next.

The core intelligence kernel must remain reusable across industries. The first complete commercial vertical is TCG, starting with Pokemon.

## Non-negotiable requirement: automatic discovery

This is not a manually curated monitoring dashboard. The platform must discover the important sources itself.

Required flow:

`topic/entity/trend/market event -> search platforms -> discover relevant content -> discover creators/accounts -> canonicalize identities -> score relevance -> monitor qualifying creators -> ingest future content -> extract claims/calls -> compare with later market outcomes -> update creator authority/trust -> feed explainable intelligence into market/opportunity scoring`

Manual YouTube channel IDs, Reddit accounts, influencer lists, or similar source lists must **not** be required for normal operation. They may exist only as optional seeds, priorities, or operator overrides.

Examples of valid discovery inputs include Pokemon TCG, Pokemon investing, Pokemon market, Pokemon card prices, set names, card names, grading, reprint, restock, buyout, price spike, buy/sell/hold, and market update.

## TCG requirements

Exact printing identity must preserve game, card/concept, set, collector number as text, language, exact printing/variant, condition/grade dimensions where applicable, and provider identifiers. English, Japanese, and Simplified Chinese are first-class and the model must remain extensible.

The system must never silently collapse languages, variants, sets, grades, or ambiguous name-only mentions. Ambiguous/conflicting data must fail closed into resolution/quarantine.

## Market intelligence

Support sold prices, listings/asks, reference prices, volume/velocity, listing supply, seller counts, spread, volatility, momentum, liquidity, supply absorption, relative strength, grading population where available, source disagreement, freshness, outlier flags, and provenance.

Money rules: canonical major units, explicit currency, no silent currency mixing, outliers retained as evidence but excluded from headline values when flagged.

Target market sources include authorized integrations such as TCG Card Central, TCGplayer, eBay, and future providers. No scraping workaround should replace a proper provider/API integration.

### TCG Card Central cache-first gateway (owner clarification)

For normal market-price operation, Social Signal IQ must request data through an authenticated TCG Card Central API. TCG Card Central checks its existing shared daily cache first. If the exact requested quote is absent or stale, TCG Card Central, not Social Signal IQ, uses its existing provider resolver to fetch and centrally cache it. Concurrent requests reuse TCG Card Central's existing per-identity refresh lease. Social Signal IQ must not bypass that cache, duplicate the upstream provider fetch, or require a separate direct vendor subscription merely to consume this integration.

The products keep separate databases, authentication and billing. The API exposes only public catalog/market data, never tenant collections, provider keys or database credentials. A dedicated server-to-server credential is separate from all user passwords and upstream keys. Requests preserve game, set, collector number as text, language, variant, condition and grade. Unsupported or ambiguous dimensions must return an explicit non-price result, not a fabricated match. Responses preserve original observation time, freshness and provenance. A reference quote is not a completed sale, volume measurement or historical series. Social Signal IQ may persist the received observations in its existing intelligence pipeline without creating another upstream-fetch/cache authority.

Credentials alone do not enable this provider. Activate and validate the TCG Card Central gateway in staging with bounded cache-hit, cache-miss, repeat-request and exact-identity tests before production use. Existing direct adapters may remain available for separately authorized future integrations, but are not fallback paths for a TCG Card Central cache miss.


## Creator/influencer intelligence

Creator intelligence is core functionality. The system must automatically discover creators by topic, maintain canonical platform identities, ingest relevant content, extract structured calls/claims, capture the market state at call time, evaluate later outcomes without look-ahead, and calculate sample-size-aware authority/trust by category.

Keep separate:
- relevance/discovery strength
- reach/engagement
- authority/trust
- market impact/influence

Popularity is not authority.

### YouTube

The YouTube integration must search by topic/query using YouTube Data API v3 and discover channels from returned videos. `YOUTUBE_CHANNEL_IDS` may exist only as optional seed/priority channels. Normal operation must not require them.

### Reddit

Reddit discovery must find relevant communities/posts/accounts from topic/domain strategies and must not be limited to one hardcoded source.

## Social/content intelligence

Reuse canonical source/account/content/mention/creator pipelines. Preserve provenance, timestamps, bounded excerpts/references, engagement snapshots, entity resolution, sentiment, topic relevance, and creator-call extraction. Do not create parallel content stores without necessity.

## Scoring

Required TCG outputs include Opportunity, Risk, Confidence, Liquidity, Recommendation, indices, feature explanations, and evidence/provenance.

Social hype alone is not market confirmation. Conflicting creators should reduce certainty. Stale content should not drive fresh confidence. Thin markets should reduce confidence/liquidity. Weights must be versioned and auditable.

## Predictions

Support 7d, 30d, 90d, 180d, and 365d horizons with as-of data only, immutable issuance context, feature/score/model linkage, later outcome evaluation, backtests, calibration, and sample-size reporting. Customer-visible predictions remain shadow-gated until real data validates performance.

## Discovery and anomaly detection

The platform must continuously discover new creators, content, TCG sets/products, trends, anomalies, restocks/reprints, unusual supply/volume/social velocity, creator consensus/disagreement, and high-opportunity entities. Query generation must be bounded and quota-aware.

## Customer product

The customer app must present human-readable opportunities, cards/printings, market history, indices, creators, calls, evidence, freshness, data quality, API keys, usage, webhooks, team/workspace, billing, and settings. Raw JSON may exist only as expandable technical detail, not as the primary UX.

## Admin/operator product

Admin must support customers, creators, discovery topics, discovered creators, creator exclusions, indices, providers, health, pause/enable, bounded staging sync, quarantine/resolution, predictions, support/beta, config state without secrets, audit, and break-glass actions with reasons.

## Commercial SaaS

Required platform capabilities include Better Auth, verified email, workspaces, strict tenant isolation, platform-admin separation, RBAC, API keys/scopes/rate limits, usage metering, entitlements, Stripe lifecycle, webhooks, CRM, email, notifications, and audit trails.

## Security

`app_user` and `app_worker` must not bypass RLS. Platform admin is separate from tenant roles. Hosted runtimes use role-specific DB URLs. No cross-tenant IDOR. No account enumeration. No secrets in logs/UI/query strings. Hosted webhooks require HTTPS and SSRF protection. Provider credentials alone must never imply live mode.

## Infrastructure

TypeScript, pnpm/Turborepo, Next.js web, Hono API, Node/BullMQ worker, Neon/Postgres, Drizzle, Better Auth, Upstash Redis, Resend, Stripe, Vercel web, Railway API/worker. TCG Card Central remains external and must not share Social Signal IQ DB/auth/billing infrastructure.

## Provider activation

Provider modes are disabled, fixture, or live. Hosted default is disabled. Credentials alone must not activate live. Enable providers one at a time in staging with bounded syncs and validation before wider activation.

A provider is not complete merely because credentials work. It must satisfy the automatic discovery/ingestion behavior in this document.

## Definition of done

The project is not 100% complete until all are true:

1. Hosted staging is healthy across web/API/worker/DB/Redis/email.
2. Automatic topic-based creator/source discovery works in staging.
3. YouTube discovers creators without manual channel IDs.
4. Reddit/social discovery follows the same principle.
5. At least one real market provider is live in staging and validated.
6. Real data flows end-to-end through normalization, resolution, quarantine, creator intelligence, scoring, indices, and shadow predictions.
7. Exact TCG identity survives real multi-source data.
8. Outlier/currency/grade/language/variant protections work on real data.
9. Admin can operate provider/discovery/quarantine workflows.
10. Customer app shows real explainable intelligence.
11. API/webhook flows work with real staged data.
12. Beta flow is completed end-to-end.
13. Production infrastructure, secrets, migrations, Stripe live, and provider credentials are separately configured and validated when authorized.
14. Production smoke/security/load checks pass.
15. Legal placeholders are resolved before public launch.
16. Predictions remain gated until evidence supports publication.
17. No required product behavior relies on fixture-only paths or manual workarounds.
18. The final system matches this source of truth, not merely the test suite.

## Current verified state

Core SaaS/intelligence architecture exists. Hosted staging exists. Neon, Vercel, Railway, Upstash Redis, auth, email, admin, worker heartbeat, and queue health have been exercised. Staging source smoke, load smoke, and security scan have passed. Providers default safely to disabled. YouTube credentials/runtime live mode work, but the current YouTube live implementation is incomplete relative to this source of truth because it depends on known channel IDs instead of topic-based creator discovery. Real provider end-to-end validation, controlled beta, and production remain incomplete.

## Immediate priority

1. Build topic-based YouTube creator discovery.
2. Persist discovery topics/provenance/relevance/monitoring state.
3. Feed discovered videos through the existing source/creator/call pipeline.
4. Auto-monitor qualifying discovered creators without requiring channel IDs.
5. Add quota budgeting and admin visibility.
6. Validate a bounded real staging discovery run.
7. Extend the same discovery principle to Reddit/social sources.
8. Activate and validate real market providers.
9. Validate real-data scoring/indices/shadow predictions.
10. Complete beta and production gates.

## Execution rules

Every future agent/session must read this file before planning changes. Audit existing code before proposing architecture. Never substitute manual workarounds for automatic requirements. Never declare a phase complete when required product behavior is missing. Reuse canonical pipelines. Preserve provenance, exact identity, security, RLS, and explainability. Fix root causes instead of repeatedly changing configuration without evidence. Use bounded staging tests before wider activation. If another project document conflicts with this file, this file controls.

This file may only be changed when the product owner explicitly changes the intended product behavior.