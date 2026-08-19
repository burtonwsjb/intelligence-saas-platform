# Source intelligence (YouTube, Reddit, social)

Source intelligence produces **mentions, calls, and social signals**. It does not produce buy recommendations by itself.

## Shared source document

| Field | Notes |
|---|---|
| `source_type` | `youtube` · `reddit` · `x` · `other` |
| `external_id` | Platform id |
| `url` | Canonical URL |
| `author_id` | Creator / account |
| `published_at` | Source timestamp |
| `fetched_at` | Our ingest time |
| `language` | Detected or declared |
| `license_status` | What we are allowed to store |
| `raw_ref` | Pointer to source, not necessarily full body |
| `derived` | Structured extracts |

Prefer **source reference + derived structured evidence**. Do not keep raw copyrighted transcripts by default.

## YouTube

Where APIs and licenses allow, consider:

- title, description, channel, creator
- publication timestamp, tags
- transcript **availability** (boolean)
- transcript **references** (timestamps + mention spans), not wholesale transcript text unless licensed
- referenced cards / entities (via resolution)
- recommendation language
- bullish / bearish direction
- target price, expected return, stated horizon, stated confidence
- supporting statements (short quotes if fair-use/license permits)

**Views are not authority.** Views may be a reach feature; they do not score a call.

Ingest path:

```text
YouTube API / permitted feed
  → source_document
    → mention spans
      → entity resolution
        → creator_call candidates
          → human or model review when below threshold
```

## Reddit and social

Derived information, not vanity counts:

| Derived | Why |
|---|---|
| Card mentions (resolved) | Identity |
| Mention velocity | Acceleration, not total |
| Unique participant count | Against one-user spam |
| Positive / negative sentiment | Directional tone only |
| Recommendation direction | If a call is actually made |
| Topic acceleration | Second derivative of unique participants or threads |
| Disagreement | Mixed polarity in-window |
| Hype concentration | Few accounts, many mentions |
| Coordinated activity indicators | Timing, repeated copy, graph bursts |

Do **not**:

- use total mention count as the score
- assume positive sentiment equals price appreciation
- emit a buy from social alone

Always cross-check social activity against completed sales, velocity, and liquidity. Unconfirmed social spikes are `hype_unconfirmed` signals.

## Storage and law

- Store URLs, ids, timestamps, and structured extracts
- Transcripts: store availability + span offsets + licensed excerpts only
- Reddit: store permalink + derived fields; body text only as needed and permitted
- Retention shorter for raw social text than for derived signals
- Robots / API ToS / copyright reviewed before Phase 09 implementation

Phase 09 implemented fixture ingestion only ([PHASE_09.md](../PHASE_09.md)). Mentions are stored unresolved. Live YouTube/Reddit APIs and HTML scraping are not used.

## Quality

Each source document has `data_quality` and `manipulation_risk` hints (bot-like, deleted, edited, embed-only). Low quality reduces weight in creator and social features; it does not delete the document.
