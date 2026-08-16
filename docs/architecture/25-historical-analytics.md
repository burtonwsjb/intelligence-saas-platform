# Historical market state and analytics

## What to keep

Durable history, keyed by entity (TCG: exact printing + language, and grade when split):

- price
- volume (units and dollars)
- sales velocity
- supply / listings
- spread
- liquidity
- sentiment (derived)
- creator signals
- social signals
- search activity
- market index levels
- opportunity / risk / confidence / liquidity scores
- issued predictions

## Storage strategy

| Store | Use |
|---|---|
| **Event / observation tables** | Immutable facts (trades, listing snapshots ingested, mentions) |
| **Time-series tables** | Regular bars (hourly/daily) per measure |
| **Partitions** | By time (and tenant if tenant-private); printing series can be platform-shared licensed data vs tenant-private holdings |
| **Aggregates** | Daily/weekly rollups for API and indices |
| **Materialized views** | Hot latest + 30/90/365 windows |
| **Retention** | Hot vs warm vs archive |
| **Archival** | R2 for cold bars and raw dumps |

v1 recommendation:

1. Append-only `observations` (kernel)
2. `market_bars_daily` (and later hourly where density exists)
3. `index_levels` as-of
4. `score_snapshots` daily
5. `prediction_records` + `prediction_outcomes`
6. Partition bars by month
7. Keep raw source payloads only as long as license and cost allow; derived bars live longer

Do not store one giant JSON blob per day as the only history.

## Shared vs tenant data

- Licensed or platform-collected **market** series may be global (not tenant-scoped) with a `dataset_id` and license flag
- Tenant **holdings, trades, personalized scores** are tenant-scoped + RLS
- Creator calls extracted from public sources are platform-scoped; a tenant’s private notes are tenant-scoped

## Pattern matching (future)

A `market_state_vector` at time `t` for an entity or index:

- normalized features (returns, velocity z, supply z, social z, creator consensus, index RS, …)
- `feature_version`
- pointer to the bar and score snapshot

Later jobs may compute statistically evaluated similarity (distance in a validated feature space, or supervised “next-horizon return given neighbor outcomes”).

Until validation: no customer-facing “this looks like 2019” claim.

## Manipulation series

Persist flags beside bars:

- `outlier_sale`
- `low_volume_spike`
- `hype_unconfirmed`
- `thin_breakout`
- `listing_anomaly`
- `coordinated_influencer`
- `supply_disappearance`
- `price_volume_diverge`

Flags are observations/signals, not deletions of the underlying print.
