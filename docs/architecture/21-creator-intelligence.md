# Creator intelligence and authority

Creator/analyst calls are a major product feature. Authority is **contextual**, never one universal number.

## Creator call (immutable)

Every detected call can record:

| Field | Required |
|---|---|
| `creator_id` | yes |
| `platform` | yes |
| `source_url` | yes |
| `published_at` | yes |
| `content_position` | when available (timestamp, comment id) |
| `entity_id` / printing fields | exact TCG entity when resolved |
| `card`, `set`, `collector_number`, `language` | snapshot of identity at extract time |
| `price_at_call` | market price when the call occurred |
| `market_conditions_at_call` | snapshot (index, liquidity, volatility) |
| `direction` | bullish / bearish / neutral / mixed |
| `target` | price or range if stated |
| `expected_percentage` | if stated |
| `time_horizon` | stated or inferred, labeled as such |
| `stated_confidence` | creator’s words |
| `extraction_confidence` | our extract quality |
| `entity_resolution_status` | exact … unresolved |
| `entity_resolution_confidence` | |
| `resolver_version` / `extractor_version` | |

Historical calls are **immutable** except for an audited correction row that points at the original. Corrections never erase the original payload.

Unresolved or ambiguous calls remain in history. They do not bind a printing and they do not count as resolved outcomes until resolution is `exact` or `high_confidence`.

## Outcomes

When the horizon elapses (or is evaluated at 7/30/90/180/365 days):

- price then vs price at call
- directional hit / miss / flat
- return, drawdown
- **alpha vs selected benchmark**
- still-open vs resolved

Bad calls are never deleted.

## Sample-size confidence (recommended method)

Do not rank 4/4 above 730/1000 on raw accuracy.

**Recommended ranking estimator:** hierarchical Bayesian shrinkage (Beta-Binomial / empirical Bayes) for directional accuracy.

- Each creator-context has successes `s` and trials `n`
- Shrink `s/n` toward a weakly informative or cohort prior (game/language/era)
- Rank on the posterior mean (or a conservative percentile), not the raw rate
- Show a **Wilson score interval** (or posterior credible interval) on profiles so uncertainty is visible
- Require a minimum effective sample size before a context leaves `insufficient_data`

For continuous metrics (return, alpha): hierarchical shrinkage of means (partial pooling) with sample-size-aware intervals. Median return is reported alongside the mean so outliers do not dominate.

Wilson-only ranking is acceptable as a simpler v1 if the hierarchical prior is not yet fit, but raw percentages are forbidden for leaderboards.

## Creator authority (contextual)

Authority is a **vector**, not a scalar.

Dimensions include:

- sample size (effective `n`)
- directional accuracy (shrunk)
- average / median return
- average / median alpha
- downside / upside
- timing advantage / early-call score
- consistency
- specialization
- recency (time-decayed)
- confidence calibration (stated vs realized)
- market-condition performance (trend vs chop, thin vs liquid)
- data quality of the underlying calls

Example: excellent on English modern Pokémon, mediocre on Japanese vintage, insufficient-data on One Piece.

Storage: `creator_authority_slices` keyed by

```text
creator_id + game + language + era + product_class + grade_class?
```

A global headline number, if shown, is labeled as a blended summary and is **not** used as the only model weight.

## Trust states

Configurable, admin-owned:

| State | Typical use |
|---|---|
| `trusted` | High weight |
| `reliable` | Normal weight |
| `developing` | Reduced weight, still visible |
| `low_confidence` | Low weight |
| `unreliable` | Near-zero model weight |
| `excluded` | Zero model weight; hidden from default recs |

A downgrade:

- does **not** delete history
- reduces authority weight
- reduces future model influence
- preserves audit
- allows admin exclusion

State changes are audited.

## Creator profile

A profile can show:

- authority slices (not one number only)
- trust state
- total / resolved / unresolved calls
- accuracy at 7 / 30 / 90 / 180 / 365 days (shrunk + interval)
- average and median return
- average and median alpha
- biggest winner / loser
- performance by game, set, language, price tier, horizon
- early-call score
- extraction / data-quality confidence
- complete historical calls with dates

## Model use

Opportunity and prediction features may include:

- this-creator authority in the matching slice
- creator consensus (weighted by slice authority and independence)
- disagreement

Consensus of excluded or low-quality extractors is ignored. Social reach is not substituted for authority.

Phase 11 implements creator identity, immutable calls, price-at-call, and pending outcome slots ([PHASE_11.md](../PHASE_11.md)). Phase 12 adds horizon evaluation, Wilson/Bayes shrinkage, contextual slices, and trust states ([PHASE_12.md](../PHASE_12.md)). Phase 13 adds language-aware index benchmarks and `alpha.v1` relative return on a separate immutable row ([PHASE_13.md](../PHASE_13.md)). Phase 20 operators can set trust to `excluded` without deleting call history ([PHASE_20.md](../PHASE_20.md)).
