# Phase 15 — Prediction engine, calibration, backtesting, and accountability

Status: **implemented**. Phase 16 has **not** started.

Versioned probabilistic forecasts are issued from frozen market features, then scored when the horizon elapses. The v1 model is a deterministic statistical baseline. Default visibility is **shadow**. No customer-facing prediction product. No external AI model.

## Domain boundary

| Location | Role |
|---|---|
| `packages/db/src/schema/prediction.ts` | Immutable `tcg_prediction`, `tcg_prediction_outcome`, `tcg_backtest_run` |
| `packages/db/drizzle/0015_phase15_prediction.sql` | Migration |
| `packages/db/src/prediction/` | Model interface, issue, evaluate, metrics, walk-forward backtest |
| `packages/contracts/src/prediction.ts` | Catalogs (no Zod) |
| `apps/api/src/prediction-contracts.ts` | Internal Zod only |

Public prediction facts are platform-global. Tenants cannot insert, update, or delete them. Customer `/v1` prediction reads remain disabled while visibility is shadow.

## Horizons

`7d`, `30d`, `90d`, `180d`, `365d`. Catalogued in `PREDICTION_HORIZONS`; application code does not invent extra day counts.

## Model interface

`PredictionModel.predict(frozenFeatures, horizon)` returns ranges, probabilities, confidence, and risk. Future ML models plug into the same interface with a new `model_version`.

v1: `stats.baseline` / `stats.baseline.v1`.

- Center: 30d return if present, else 7d, else `insufficient_data`
- Range: center ± 1.5 × volatility scaled by `sqrt(horizonDays/30)`
- `probability_increase` = clipped logistic of expected return; `probability_decline` = 1 − that
- Confidence comes from sample size and feature quality, **not** Phase 14 Opportunity Score
- Price range is `price_at_issue × (1 + return_range)` when a price exists

Baselines stored as separate model versions: `baseline.no_change.v1` (expected return 0) and `baseline.momentum.v1` (7d return only).

## Feature freeze

Each issue stores `data_cutoff_at <= issued_at`, the feature snapshot id, and feature set version. Features use only `observed_at <= cutoff`. A later cutoff than `issued_at` is rejected. Re-issuing the same `(printing, issued_at, horizon, model_version)` returns the existing row.

## Records

Immutable `tcg_prediction`: printing, issued_at, cutoff, horizon, ranges, probabilities, confidence, risk, model key/version, visibility (default `shadow`), language, data quality, components.

When the horizon matures, immutable `tcg_prediction_outcome` stores actual price/return, directional accuracy, forecast error, range hit, Brier score (`calibration.v1`), benchmark return, alpha, and drawdown. Sales after the horizon are ignored. Outliers and graded prints are not mixed into the raw NM series. Pending horizons are not written as outcomes.

Bad forecasts cannot be updated or deleted.

## Calibration and backtesting

`calibration.v1` Brier score plus five probability buckets. MAPE is skipped when `|actual| < 1` so near-zero prices do not explode.

`walk_forward.v1` issues at each evaluation `as_of` with cutoff = `as_of`, then evaluates using only `(issued_at, issued_at+horizon]`. A calibration window end excludes earlier dates from the evaluation set. Future index membership is not used; benchmark levels are point-in-time as of issue and horizon end.

## Shadow mode

Default `visibility=shadow`. Phase 15 does not publish customer predictions. Internal contracts exist for later commercial exposure.

## Phase 16 boundary

Do not implement the commercial API, webhooks, usage meters, or OpenAPI in this phase.
