# Opportunity scoring and recommendations

## Separate outputs

Never hide the product in one number. Persist and expose:

| Output | Meaning |
|---|---|
| **Opportunity** | Attractiveness of a long (or short) setup |
| **Risk** | Downside, manipulation, thin-book, volatility |
| **Confidence** | Statistical and data-quality confidence |
| **Liquidity** | Ability to transact |
| **Recommendation** | Discrete action label plus rationale |

Weights are **provisional** until calibrated from evidence (backtests, prediction accountability). Architecture stores `score_version` and component contributions.

## Candidate components (TCG)

Calibrate later; do not treat this list as final weights:

- price momentum
- volume momentum
- sales velocity
- liquidity
- supply pressure
- market absorption (listing-to-sale, supply change)
- creator authority (contextual slices)
- creator consensus (authority-weighted)
- social momentum (unconfirmed hype is a risk, not opportunity)
- search momentum
- relative strength vs benchmark
- grading / population trends
- catalysts (set release, reprint rumor — sourced)
- volatility
- manipulation risk
- data quality
- prediction confidence

Social and creator inputs are capped when market activity does not confirm.

## Recommendation labels

| Label | Use |
|---|---|
| `strong_buy` | High opportunity, acceptable risk, adequate confidence and liquidity |
| `buy` | Positive setup, not extreme |
| `watch` | Building evidence, not actionable |
| `hold` | Neutral for holders; no new risk-on |
| `reduce` | Deteriorating setup |
| `sell` | Negative setup |
| `strong_sell` | High risk / confirmed breakdown |
| `insufficient_data` | Failed gates |

Personalized holdings may later map the same scores onto a tenant’s position (hold vs reduce) without changing the public printing score.

## Explainability (required)

Every recommendation stores an evidence list, for example:

- sales volume +48%
- price +7%
- listings −17%
- trusted creator consensus bullish
- search demand accelerating
- relative performance vs set +6.2%
- liquidity strong

Each line cites observation/signal ids. The API and UI must be able to render this list. No unexplained label.

## Insufficient data

If liquidity, sample size, resolution, or data quality fails gates, emit `insufficient_data` even if momentum looks strong. Thin breakouts route to manipulation/hype review, not `strong_buy`.
