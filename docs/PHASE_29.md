# Phase 29 — Shadow prediction evaluation framework

Status: **completed in-repo on the existing evaluator**. Predictions remain shadow. No accuracy claims.

## Already present and now tightened

- Issuance eligibility, horizon handling, as-of cutoff, insufficient_data
- Immutable outcome rows, walk-forward backtest, MAE/RMSE, Brier, direction accuracy, coverage, calibration buckets
- MAPE added to walk-forward metrics when prices exist
- Model-run comparison helper that cannot mark results customer-visible
- Backtest refuses any non-shadow prediction row

## Not done

- Live outcome volume needed before any published accuracy statement
- Customer prediction publication remains forbidden
