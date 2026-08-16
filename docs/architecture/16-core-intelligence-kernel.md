# Core intelligence kernel

The kernel is **industry-independent**. TCG is the first complete vertical that proves it. Generic HTTP ingest is a reusable capability, not the commercial product.

## Pipeline

```text
Sources
  → ingestion
    → entity resolution
      → observations
        → signals
          → scoring
            → predictions
              → recommendations / opportunities
                → content intelligence
                  → commercial API · webhooks · console
```

Every stage stores evidence, versions, and confidence. Later stages may not silently discard earlier uncertainty.

## Kernel objects

| Object | Meaning |
|---|---|
| **Source document** | A fetched or received item (page, video metadata, post, API payload) plus lawful derived extracts |
| **Observation** | A dated fact about an entity or market (`price`, `volume`, `mention`, `listing_count`) |
| **Signal** | A derived change or condition (`volume_acceleration`, `supply_contraction`, `creator_consensus_bullish`) |
| **Score** | A named numeric output with components (`opportunity`, `risk`, `confidence`, `liquidity`) |
| **Prediction** | A dated, versioned forecast with a horizon and later outcome |
| **Recommendation** | An explainable action label (`strong_buy` … `insufficient_data`) |
| **Content candidate** | Evidence-backed draft for a channel (article, report, email) |
| **Index** | A defined basket with membership, weights, and history |
| **Creator** | An analyst/publisher whose calls are tracked (any vertical) |
| **Call** | An immutable extracted recommendation tied to entities |
| **Resolution** | A mapping from mention text/context → entity, with confidence and evidence |

TCG printings, languages, and collectible-market metrics are **pack bindings** of these objects, not replacements for them.

## Observation rules

- An observation has `observed_at`, `entity_id` (or unresolved mention id), `key`, `value`, `unit`, `source_id`, and quality flags
- Observations are append-only
- Corrections are new observations or audited supersedes, not silent overwrites
- Language, market, and quality dimensions travel with the observation when they affect meaning

## Signal rules

- A signal cites the observations or other signals that produced it
- A signal has a window, a method version, and a confidence
- Social signals are never sufficient alone to emit a buy recommendation

## Scoring rules

Keep component scores separate. Do not collapse opportunity, risk, confidence, liquidity, and recommendation into one hidden number. See [23-opportunity-and-recommendations.md](./23-opportunity-and-recommendations.md).

## Prediction rules

Predictions are first-class, accountable, and never silently deleted. See [24-prediction-engine.md](./24-prediction-engine.md).

## Content rules

Content is generated from evidence packages, not from a prompt that invents a market. See [26-content-seo-intelligence.md](./26-content-seo-intelligence.md).

## What v1 commercially proves

The first production vertical is **TCG market intelligence**. It must exercise the full kernel: identity, resolution, observations, signals, creators, indices, opportunity, predictions, content, API, and webhooks.

A tenant that only posts generic HTTP events can still use the kernel. That path is not the first commercial offering.
