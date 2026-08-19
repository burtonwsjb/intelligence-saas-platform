# Phase 13 — Market analytics, indices, benchmarks, and alpha

Status: **implemented**. Phase 14 has **not** started.

Phase 08 sold/listing history is turned into versioned, collectible-aware analytical features and a generalized market-index framework. No buy/sell recommendations. No interpolated fake daily closes. Languages stay first-class.

## Domain boundary

| Location | Role |
|---|---|
| `packages/db/src/schema/analytics.ts` | Feature snapshots, index spec/membership/levels, creator alpha |
| `packages/db/drizzle/0013_phase13_analytics.sql` | Migration |
| `packages/db/src/analytics/` | Feature engine, index engine, benchmark resolver, alpha |
| `packages/contracts/src/analytics.ts` | Catalogs (no Zod) |
| `apps/api/src/analytics-contracts.ts` | Internal Zod only |

Public market facts remain platform-global. Tenants cannot insert or rewrite analytics history.

## Feature set (`tcg.market.features` / `features.v1`)

Immutable `tcg_market_feature_snapshot` rows store `printing_id`, `as_of`, feature set key/version, market dimensions, JSON features, data quality, sample size, source composition.

All inputs are `observed_at <= as_of`. Recomputation with a later clock does not rewrite an existing snapshot.

### Collectible formulas

| Metric | Method | Interpretation |
|---|---|---|
| Price return 1d/7d/30d/90d/180d/365d | `nearest_observation.v1` | Latest sold at or before `as_of` and at or before `as_of − period`, each inside slack `max(1d, 0.25×period)`. Missing or identical prints → `insufficient_data`. Never interpolate. |
| Rolling median | `rolling_median.v1` | Median of completed-sale prices in 30d |
| SMA | `sma_trade_time.v1` | Mean of actual sold prints; empty days omitted |
| EMA | `ema_trade_time.v1` | EMA over the sold sequence, not calendar sessions |
| Sales velocity | `sales_count.v1` / `median_intersale.v1` | Sales/day, sales/7d, sales/30d, median gap. Listing count is not volume. |
| Volume momentum | `volume_momentum.v1` | `(sales_7d / sales_prior_7d) − 1`; min 2 sales each window |
| Supply | listing snapshots | Active listing change, seller change, listing/sale ratio, absorption |
| Spread change | `spread_change.v1` | Change in lowest ask − latest sold |
| Volatility | `mad_trade_returns.v1` | MAD of consecutive sold-to-sold returns; method, window, sample count stored |
| Drawdown | `peak_to_current.v1` | Peak-to-current on the observed sold series |
| Momentum | period return | Transparent component, not a recommendation |
| Relative strength | `relative_strength.v1` | Printing return minus language-aware benchmark return. Absolute return stored separately. |
| Candidates | breakout / reversal / anomaly | Gated flags only |
| Manipulation foundation | thin-volume spike, price jump without volume, supply disappearance, outlier-driven | Flags only — no final risk score |

Default outlier policy `exclude_flagged.v1`. `include_all.v1` is explicit and changes results; insufficient data is never hidden.

## Indices (`index.v1`)

Generalized definitions (`index_key`, name, game, optional language, membership rule, weighting, min liquidity/history, rebalance schedule, method version, status). Seeded examples (Pokémon EN/JA/zh-Hans, modern EN, Pikachu, Charizard, PSA 10, One Piece EN) are **not** a closed list — `upsertIndexDefinition` adds more.

v1 membership requires `language_code` unless `allow_mixed_languages` is explicitly true. English, Japanese, and Simplified Chinese are never merged automatically.

Default weighting is **equal.v1**. `liquidity.v1` weights by trailing 30d completed sales. Market cap is not invented.

Membership stores `effective_from` / `effective_to`. Historical levels use who qualified *then*. Closing a window may set `effective_to` only; other membership fields and all index levels are immutable. Base 100 at the member’s as-of entry price.

## Benchmarks (`benchmark.v1`)

Tightest qualified cohort with coverage and component gates:

1. set + language
2. era + language + game
3. game + language
4. `insufficient_benchmark` (no automatic mixed-language fallback)

## Creator alpha (`alpha.v1`)

`creator_call_alpha` is append-only and keyed by `(call_id, method_version)`.

```text
alpha = card_return − benchmark_return
```

Card return is the existing `outcome.v1` `return_pct`. Raw outcome rows are not rewritten. Authority slices recompute `avg_relative_return` from alpha rows. Riding a broad rally is not fully credited.

## Security

SELECT for runtime roles. INSERT is worker + `principal_type=system`. Feature snapshots, index levels, and alpha rows cannot be updated or deleted. Index membership may only close `effective_to`.

## Phase 14 boundary

Do not issue opportunity/risk/confidence/liquidity scores or buy/sell recommendations.
