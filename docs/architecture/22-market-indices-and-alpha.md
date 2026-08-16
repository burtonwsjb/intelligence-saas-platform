# Market indices and alpha

## Generalized index framework

Indices are kernel objects. TCG supplies the first membership rules. Names below are **examples**, not a closed list:

- Pokémon Market Index
- One Piece Market Index
- Modern / Vintage Pokémon
- English / Japanese / Chinese Pokémon
- Pikachu / Charizard thematic
- PSA 10
- Sealed Product

Operators (or later, tenants with entitlement) define an index by spec, not by shipping a new table per name.

## Index spec

| Field | Purpose |
|---|---|
| `key` / `name` | Stable id + display |
| `universe` | Game, language, era, product class, grade |
| `membership_rule` | Query or explicit list + rule version |
| `weighting` | Equal, cap-weighted (liquidity or dollar volume), capped weights |
| `min_liquidity` | Printings below this are ineligible |
| `min_history` | Avoid newborn spikes |
| `rebalance_frequency` | Calendar + event-driven |
| `language_segmentation` | Default: do not mix EN/JA/ZH books |
| `quality_thresholds` | Outlier sale filters |
| `survivorship` | See below |
| `reconstruction` | Point-in-time membership |

## Survivorship-bias prevention

- Membership is **point-in-time**. Historical index levels use who qualified *then*, not today’s survivors
- Delisted / illiquid printings remain in historical baskets until the rebalance that removed them
- Backfills must replay rules on snapshots, not on the current catalog
- Store `index_constituents` as-of each rebalance

## Historical reconstruction

```text
for each rebalance_date:
  apply membership_rule to market snapshots as_of that date
  apply weights and liquidity gates
  persist constituents + level
```

Do not recompute history by dropping names that later went to zero liquidity.

## Alpha and benchmarking

Creator calls and platform predictions are scored **relative to a suitable benchmark**, not only raw return.

```text
card_return     = +20%
benchmark       = +12%   (same game, language, era/set or price-tier cohort)
alpha           = +8%
```

Do not fully reward a “it went up” call when the relevant market rose by nearly the same amount.

### Benchmark selection

Pick the tightest **qualified** cohort:

1. Same printing’s set index (same language) if liquid
2. Else era + language + game
3. Else game + language
4. Else game
5. Else `insufficient_benchmark` (alpha withheld)

Price-tier and sealed-vs-singles cuts apply when the call is in that class. Grade-specific calls use grade indices when they exist.

Benchmark id, rule version, and level-at-call / level-at-horizon are stored on the outcome row.

## Use in the product

- Creator profile alpha
- Platform prediction accountability
- Opportunity “relative strength”
- Content evidence (“+6.2% vs set”)
