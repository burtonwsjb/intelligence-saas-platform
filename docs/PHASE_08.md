# Phase 08 — TCG market-history model and exact-printing ingest

Status: **implemented**. Phase 09 is complete; see [PHASE_09.md](PHASE_09.md). Phase 10 has **not** started.

Exact printings accumulate immutable market observations. Shared provider facts are platform-global. Fixture providers only. No real TCG Card Central, TCGplayer, or eBay network calls. No YouTube/Reddit, creator authority, market indices, alpha, or opportunity scoring.

## Domain boundary

Generic kernel tables stay industry-neutral. They do **not** gain price, condition, grade, currency, or listing columns.

TCG market structures live beside the kernel:

| Location | Role |
|---|---|
| `packages/db/src/schema/tcg-market.ts` | Drizzle tables |
| `packages/db/drizzle/0008_phase08_tcg_market.sql` | Versioned migration |
| `packages/db/src/tcg/market-*.ts` | Identity, ingest, query, fixtures, providers, tenant projection |
| `packages/contracts/src/tcg-market.ts` | Shared catalogs and parsers (no Zod) |
| `apps/api/src/tcg-market-contracts.ts` | Zod schemas (internal; no public market routes) |

Identity authority remains Phase 07. Market ingest never creates canonical printings.

## Source model

Platform-global `tcg_market_source` (no credentials):

`tcg_card_central`, `tcgplayer`, `ebay`, `manual`, `fixture`

Fields: `source_key`, `display_name`, capability flags (`supports_sold` / `listings` / `volume` / `condition` / `grades`), `status`, `default_quality`.

One bad record does **not** change the source catalog quality. Record-level `quality_label` is separate.

## Market types and price types

Market channels (do not mix):

| `market_type` | Default `price_type` | Meaning |
|---|---|---|
| `marketplace_listing` | `asking` | Active asks / listing snapshot |
| `marketplace_sold` | `sold` | Completed sale or sold aggregate |
| `market_price` | `reference` | Source reference/market price |
| `direct_sale` | `sold` | Direct completed sale |
| `manual_observation` | `reference` | Manual fact |

`price_type` is first-class: `asking` | `sold` | `reference` | `bid`. Listing price is never treated as sold price. Shipping, tax, and fees are stored separately and are not folded into `sale_price` / `price`.

## Condition and grade

Raw condition catalog: `nm`, `lp`, `mp`, `hp`, `dmg`, `unknown`. Unknown is **not** treated as NM. Source-reported text may be stored as `attributes.raw_condition`.

Grade is a separate dimension: optional `grading_company` (`psa`, `bgs`, `cgc`, `sgc`, `other`), `grade_label`, optional `grade_numeric`, optional `certification_number` only when the source record includes it. Raw NM is not PSA 10.

## Currency

ISO 4217 uppercase codes (`USD`, `JPY`, `EUR`, `GBP`, `CAD`, …). No silent FX conversion. Converted values, if added later, must store original amount/currency plus rate/source/time plus converted amount/currency.

## Snapshots

Append-only `tcg_market_snapshot` bound to exactly one `printing_id`. Fields include source, market/price type, `observed_at`, currency, condition, optional grade, price, listing/sales counts, volume, low/median/high/average, bid/seller counts, fees, aggregation metadata, `source_record_id`, fingerprint, quality/outlier flags, attributes.

Not every source populates every field. UTC timestamps only.

## Sold, listings, volume

- **Event-level sale:** `aggregation_kind=event`, `price_type=sold`, optional quantity.
- **Listing supply snapshot:** `market_type=marketplace_listing`, `listing_count`, `low_price` / `median_price` / `high_price`, `seller_count` only when the source provides it (never inferred).
- **Aggregated volume:** `aggregation_kind=window` plus `window_seconds`, `sales_count`, `volume_value`. Do not mix event and window rows without this metadata.

## Spread

Deterministic helper `spread.v1`, formula name `lowest_ask_minus_latest_sold`:

- `spread_abs = lowest_ask - latest_sold`
- `spread_ratio = lowest_ask / latest_sold` (null if sold ≤ 0 or either side missing)

Units: currency amount for abs; dimensionless ratio. Missing inputs are not fabricated.

## Liquidity and volatility foundations

Inputs preserved, not scored: sales frequency, listing count, seller count, time between observations, bid count when present. No final liquidity or risk score.

Historical helpers: daily returns on days that have observations, rolling median, observation count. Empty days are not fabricated. Windows: `24h`, `7d`, `30d`, `90d`, `1y`, `all` (UTC `from`/`to`).

## Outliers and quality

Algorithm `outlier.v1` (versioned, deterministic):

- quantity > 1000 → `extreme_quantity`
- ≥ 3 prior sold prices for the same printing + condition + currency + grade slice, and price > 5× or < 0.2× rolling median → `outside_rolling_median`

Outliers are **flagged, not deleted**. Labels: `verified`, `normal`, `suspect`, `outlier`, `incomplete`.

## Exact-printing binding

Every persisted snapshot requires Phase 07 exact resolution (`exact` + `printing_id`). Language and variant mismatches fail. Card name / collector number / set / concept alone cannot bind. Market ingest does not create printings.

## Idempotency and immutability

Uniqueness: `(source_key, source_record_id)`. Fingerprint is SHA-256 of canonical source fields (**not** resolved `printing_id`). Same fingerprint replay: `duplicate`. Material field change: insert `tcg_market_revision` and throw `TcgMarketRevisionError` (no silent rewrite). Snapshots are append-only (UPDATE/DELETE forbidden).

## Quarantine

Unresolved rows go to `tcg_market_quarantine` (global operational data), not market history.

Reasons: `not_found`, `ambiguous`, `conflict`, `invalid_printing`, `concept_only`, `validation_error`.

Invalid currency and non-positive prices are rejected at validation (not stored).

## Global vs tenant

Public/shared provider observations are **platform-global** (no tenant RLS, no per-tenant copies). Tenants have SELECT. INSERT is `app_worker` plus `app.current_principal_type=system`. Tenant principals cannot write. Tenant holdings / cost basis are **not** in this phase.

## Kernel projection

Chosen architecture: **global market fact + optional tenant analytical projection**.

`projectTcgMarketSnapshotToTenant` creates a tenant `source_event` + `observation` + metrics keyed by `tcg.market.project:{snapshotId}` against the tenant’s `entity_type=tcg_printing` entity. It does not duplicate the global snapshot.

Metric keys (dimensions in JSON, not in the key string): `market.price.sold`, `market.price.ask.low`, `market.price.reference`, `market.listings.active`, `market.sales.count`, `market.volume.gross`. Dimensions: `source`, `currency`, `condition`, `grade`, `grading_company`.

## Ingest pipeline

Job type `tcg.market.normalize.v1` (not tenant `source_event` / `outbox_job`).

Flow: fixture record → `tcg_market_ingest` → worker `withPlatformContext` → exact printing resolution → immutable snapshot or quarantine → optional tenant projection.

Pack event types (`tcg.market.sold`, `tcg.market.listing_snapshot`, `tcg.market.reference_price`, `tcg.market.volume_snapshot`) are **not** in the generic `/v1/events` registry. Extension mechanism: TCG pack catalogs in `@isp/contracts` / `@isp/db`, Zod in `apps/api`.

## Providers

`TcgMarketProvider`: `getMarketSnapshots`, `getSoldTransactions`, `getListingSnapshot`, `healthCheck`.

Implementations: `FixtureTcgCardCentralMarketProvider`, `FixtureTcgplayerMarketProvider`, `FixtureEbayMarketProvider`. In-memory only. No `fetch`, no production hosts.

Fixtures cover English / Japanese / zh-Hans Greninja, holofoil vs normal, raw NM vs LP, PSA 10, listings, sales, volume, reference, an outlier, and replay/conflict cases in tests.

## Queries

Repositories (source-separated; no canonical composite price):

- latest by source / type / condition / grade / currency
- sold history range
- listing history range
- multi-source history
- spread helper
- window presets

Languages are never merged.

## Phase 09 boundary

Do not start YouTube, Reddit, creator calls, social sentiment, or source personalities.

## Known limitations

- No public `/v1` market routes (Phase 16)
- No FX conversion
- No final liquidity, volatility, or opportunity scores
- No market indices / alpha
- No live provider clients
