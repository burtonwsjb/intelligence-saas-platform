# Phase 28 — Scoring validation and calibration infrastructure

Status: **implemented in-repo**. Weights were not changed. No statistical calibration is claimed.

## Added

- Score bounds, weight-sum, and missing-input redistribution invariants
- Monotonicity check on 30d return
- Shadow score-version comparison
- Calibration dataset / historical-outcome interfaces that stay `calibrated: false` until real outcomes exist

## Not done (requires live outcomes)

- Recalibrating `score.v1` weights
- Publishing a calibrated recommendation policy
