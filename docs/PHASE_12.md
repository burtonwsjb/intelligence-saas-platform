# Phase 12 — Creator authority and outcome tracking

Status: **implemented**. Phase 13 is complete; see [PHASE_13.md](PHASE_13.md). Phase 14 has **not** started.

Mature creator calls are evaluated at their horizons and turned into **contextual**, sample-size-aware authority profiles. Authority is not a naive hit rate. It does not emit buy/sell recommendations.

## Outcomes (`outcome.v1`)

For a call with exact/high_confidence printing, price-at-call, and an explicit horizon, evaluation uses Phase 08 sold history **inside** `(published_at, published_at + horizon]`.

Stored: starting price, ending price, return %, directional correctness, target hit/miss, MFE, MAE, data quality, evaluation timestamp, method version.

Missing identity, missing horizon, unresolved printings, or missing market data → `insufficient_data`. Those are not scored as wins or losses.

No look-ahead: snapshots after the horizon end are ignored.

## Benchmark / alpha

`benchmark_requirement` is stored as `phase_13_language_era_set_tier_index`. `avg_relative_return` is null. Phase 13 indices are not fabricated.

## Sample size

Wilson interval (95%) and Beta-Binomial posterior mean (prior Beta(8,8)) are both stored. Ranking uses **Wilson lower bound**, not raw `s/n`. Display score also multiplies by `n/(n+20)`.

4/4 therefore ranks below a well-supported 730/1000.

## Contextual slices

Slices are keyed by creator plus game, language, set, price tier, and horizon. Era is `unspecified` until a later catalog exists. English modern Pokémon and Japanese vintage are not collapsed.

## Authority score (`authority.v1`)

0..100, explainable. Components JSON retains Wilson/Bayes/shrinkage/recency half-life. Raw accuracy and recency-weighted accuracy are stored separately (half-life 180d). Early-call score is `horizon_return - pre_call_7d_move` (`early_call.v1`). Stated confidence is calibrated with Brier-style error only when the creator stated it.

Authority weight is for later analytics. **No buy/sell signal.**

## Trust states

`trusted`, `reliable`, `developing`, `low_confidence`, `unreliable`, `excluded`.

`creator_trust_event` is append-only. Exclusion does not delete calls, outcomes, or slices.

## Queries

`getCreatorAuthorityProfile`: totals, resolved/unresolved, returns, best/worst, slices, historical calls.

## Security

Platform-global. Tenants cannot insert or rewrite slices or trust events. Outcome rows may be updated by the system worker when a horizon elapses.

## Phase 13 boundary

Phase 12 stored the benchmark requirement and left `avg_relative_return` null. Phase 13 now computes versioned `creator_call_alpha` rows without rewriting these raw outcome fields.
