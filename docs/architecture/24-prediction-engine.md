# Prediction engine and accountability

## Horizons

Supported forecast horizons:

- 7 days
- 30 days
- 90 days
- 180 days
- 365 days

Additional horizons may be added as catalog rows. Do not invent one-off day counts in application code.

## Output shape

Avoid false precision. Prefer ranges and probabilities:

| Field | Notes |
|---|---|
| `expected_range` | Price or return band, not a single tick |
| `expected_return_range` | Band |
| `probability_increase` | Calibrated later; show as estimate |
| `probability_decline` | |
| `confidence` | Data and model confidence |
| `risk` | Separate from opportunity |
| `model_version` | |
| `scoring_version` | |
| `feature_version` | |

Do not publish four-decimal price targets as if they were exact.

## Issued prediction (immutable)

Every issued prediction preserves:

- prediction timestamp
- entity (exact printing when TCG)
- market price at issue
- horizon
- predicted outcome / range
- confidence, risk
- model / scoring / feature versions
- benchmark id used for later alpha

Bad predictions are **not** silently deleted. Corrections are audited supersedes.

## Accountability (later recorded)

When the horizon elapses:

- actual outcome (price, return)
- directional accuracy
- forecast error (range hit, pinball/interval score — method versioned)
- alpha vs stored benchmark
- calibration contribution (predicted p vs realized)
- drawdown during the horizon

These rows feed:

- platform model report cards
- creator-vs-platform comparison
- weight calibration for opportunity scoring
- content disclaimers

## Path to historical pattern matching

Feature vectors / market-state snapshots (see [25-historical-analytics.md](./25-historical-analytics.md)) may later support “today resembles prior states.”

Rules:

- Similarity is a **candidate generator**, not a published model, until validated
- Do not call embeddings a predictive model without backtest, holdout, and calibration
- Any similarity-based forecast is a new `model_version` under this same accountability regime
