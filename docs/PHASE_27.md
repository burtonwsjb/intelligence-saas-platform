# Phase 27 — Data integrity and intelligence correctness

Status: **implemented in-repo**. Predictions remain shadow. No live providers. No hosted migration.

## Chain covered

provider → raw ingest → normalize → resolve → evidence → sentiment → creator calls → observations → market features → scoring → recommendation → indices → predictions

## Regression catalog

`INTELLIGENCE_REGRESSION_SCENARIOS` in `packages/db/src/intelligence/integrity.ts` plus `integrity.regression.test.ts` lock:

- normal / thin / outlier / manipulated spike
- mixed currencies fail closed
- graded vs ungraded stay separate in existing market ingest tests (re-asserted via fixture identity)
- multiple languages and variants do not collapse
- ambiguous card names and reused collector numbers do not silently bind
- conflicting creators are authority-weighted and language-split
- stale social does not dominate a confirmed market
- viral social without sales cannot emit buy/strong_buy
- market move without social still scores from market evidence

## Invariants

- Every score is explainable and marked uncalibrated
- Every issued prediction is `visibility=shadow`
- Data cutoff cannot be after `issued_at`
- Mixed-currency sold series produce `insufficient_data`, not a blended price

## Hosted actions

None. Do not publish customer predictions.
