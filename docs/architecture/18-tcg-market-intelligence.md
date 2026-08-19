# TCG market intelligence

First commercial vertical. Built on the kernel in [16-core-intelligence-kernel.md](./16-core-intelligence-kernel.md). Series are keyed by **exact printing** (and grade/variant when the market is split).

## Phase 08 implementation

Phase 08 implemented exact-printing market history ([PHASE_08.md](../PHASE_08.md)). Shared provider snapshots are platform-global. Fixture providers only — no live eBay, TCGplayer, or TCC market HTTP. Final liquidity scores, indices, alpha, and opportunity scoring remain later.

Condition (`nm`/`lp`/…) and grade (`grading_company` + `grade_label`) are snapshot dimensions, not new printing identities. Raw NM is not merged with PSA 10.

## Market data to track

Per exact printing, as available:

| Measure | Role |
|---|---|
| Current price | Level |
| Historical price | Series |
| Completed sales | Transactions |
| Transaction count | Activity |
| Sales volume (units) | Activity |
| Dollar volume | Activity |
| Sales velocity | Units or $ per unit time |
| Active listing supply | Offer-side |
| Supply change | Offer-side delta |
| Listing-to-sale ratio | Absorption |
| Bid activity | Demand-side when the source has bids |
| Spread | Tightness |
| Liquidity | Ability to transact without moving price |
| Volatility | Risk |
| Momentum | Price path |
| Grading population | Census |
| Grading population change | Census delta |
| Creator sentiment | Derived, not raw mentions |
| Social momentum | Derived |
| Search momentum | Derived |
| Relative performance | Vs chosen benchmark |
| Set performance | Set index / cohort |
| Game performance | Game index / cohort |

Missing source fields are `unavailable`, not zero.

## Market analytics

Collectible markets are thin, discrete, and often language-split. Adapt methods; do not paste equity formulas blindly.

| Method | Collectible adaptation |
|---|---|
| Moving averages | Use trade-time or liquidity-weighted windows, not only calendar days on empty books |
| Exponential moving averages | Same; ignore sessions with no prints or mark them as no-observation |
| Momentum | Prefer returns over windows with minimum trade counts |
| Relative strength | Vs set / language / era / game cohort, not SPX |
| Volume acceleration | Units and dollar volume; cap outlier single sales |
| Volatility | Robust scale (e.g. median absolute deviation) plus min-sample rules |
| Drawdown | Peak-to-trough on a cleaned price series, not one spike print |
| Breakout detection | Require liquidity and confirmation; see manipulation |
| Support / resistance | Cluster prior trade prices; weak in one-sale markets |
| Supply / demand imbalance | Listings vs sales, listing-to-sale, supply change |
| Price-volume divergence | Price up + velocity down is a signal, not a buy |
| Anomaly detection | Isolated outlier sales, thin spikes |
| Reversal detection | Only with sample and liquidity gates |

Every analytic stores `method_version`, `window`, `min_trades`, `language`, and `cohort_id`.

## Liquidity and quality gates

Do not rank or recommend a printing that fails minimum liquidity unless the output is explicitly `insufficient_data`.

Gates (calibrated later from evidence, not invented as final weights):

- Minimum completed sales in the window
- Maximum share of dollar volume from a single sale
- Listing count or documented thin-market flag
- Language-specific book (no borrowing EN liquidity for JP)

## Manipulation and hype

See also [25-historical-analytics.md](./25-historical-analytics.md). Detect concepts:

- Low-volume price spikes
- Isolated outlier sales
- Social hype without transaction confirmation
- Thin-market breakouts
- Listing manipulation (wash list / sudden disappearance)
- Coordinated influencer activity
- Unusual supply disappearance
- Suspicious price-volume divergence

**Social hype never automatically equals a buy signal.**

## Personalized TCG intelligence (later)

Tenant-private holdings may feed recommendations:

- exact printing, language, quantity
- cost basis, acquisition date, current value
- inventory age
- realized / unrealized P&L
- historical selling velocity
- trades, collections/folders

Holdings never leak across tenants. Personalized scores are a view over private inventory plus public (or licensed) market series.

## What this vertical is not

- Not TCC’s scanner, marketplace, or collection app
- Not a clone of TCC tables
- Not equity day-trading cosplay
