# Phase 14 — Opportunity, risk, confidence, liquidity, and recommendations

Status: **implemented**. Phase 15 is complete; see [PHASE_15.md](PHASE_15.md). Phase 16 is complete; see [PHASE_16.md](PHASE_16.md). Phase 17 is complete; see [PHASE_17.md](PHASE_17.md). Phase 18 is complete; see [PHASE_18.md](PHASE_18.md). Phase 19 has **not** started.

This is the first phase that may issue a structured recommendation. Four scores remain separate. Weights are centralized, versioned, and marked **uncalibrated**. Hype cannot create `strong_buy`. Weak evidence is `insufficient_data`.

## Domain boundary

| Location | Role |
|---|---|
| `packages/db/src/scoring/weights.ts` | `score.v1` / `recommendation.v1` weights and thresholds |
| `packages/db/src/scoring/model.ts` | Pure scoring, consensus, explainability |
| `packages/db/src/schema/scoring.ts` | Immutable `tcg_score_snapshot` |
| `packages/db/drizzle/0014_phase14_scoring.sql` | Migration |
| `apps/api/src/scoring-contracts.ts` | Internal Zod only |

Inputs that do not exist yet (search momentum, grading population, prediction confidence) are skipped, not fabricated.

## Separate outputs (0–100)

| Output | Meaning |
|---|---|
| Opportunity | Strength of a favorable setup, not a guaranteed return |
| Risk | Volatility, thin book, outliers, unconfirmed hype, supply shock |
| Confidence | Reliability of the evidence (sample, freshness, coverage, authority) |
| Liquidity | Ability to transact (sales frequency, depth, spread, seller diversity) — not price level |
| Recommendation | Discrete label plus explanation lines |

Component contributions are stored. Missing inputs have `present=false`, `applied_weight=0`. Remaining present weights are renormalized.

## Recommendation labels (`recommendation.v1`)

`strong_buy`, `buy`, `watch`, `hold`, `reduce`, `sell`, `strong_sell`, `insufficient_data`.

`strong_buy` / `buy` require market confirmation (at least 3 completed sales in 7d) and fail if social hype is unconfirmed. Social momentum is a small opportunity weight and is capped at 55 when unconfirmed.

## Creator consensus

Calls are weighted by Phase 12 `authority_weight` in the matching language slice. A 4-call creator cannot outweigh a large-sample creator. Weak total weight is skipped (`weak_creator_sample`).

## Immutability and decisions

`(printing_id, as_of, score_version)` is unique. A new score version inserts a new snapshot. Finalized snapshots cannot be updated.

`projectScoreToDecision` writes a tenant `decision_record` (`policy_key=tcg.opportunity`) with the four scores, explanation list, and `score_snapshot_id` / feature snapshot id in `result`. That is the Phase 06 evidence projection; the global snapshot remains the source of truth.

## Phase 15 boundary

Prediction engine, calibration, and walk-forward backtesting are implemented in [PHASE_15.md](PHASE_15.md). Opportunity Score is not reused as prediction confidence.
