# Entity resolution

Dedicated subsystem. The kernel resolves mentions to entities. The TCG pack resolves mentions to **exact printings** when evidence supports it.

## Phase 06 boundary

Phase 06 implements **deterministic identifier mapping only**:

`source_namespace` + `identifier_type` + `normalized_value` → existing `entity`, else create a new canonical entity.

There is no fuzzy matching, no mention span resolver, and no multi-source merge. Those belong to Phase 10. Phase 07 adds **deterministic exact-printing resolution** against TCG pack tables (`exact` / `ambiguous` / `not_found`; identifier rebind is `conflict` and fail-closed). Identifier collisions (same external id already bound to a different entity or printing) fail closed.

## Phase 07 exact printing resolution

Phase 07 implements deterministic lookup only (see [PHASE_07.md](../PHASE_07.md)):

Inputs: `game` + `set` + `collector_number` + **required** `language` + optional `variant`, or an external provider id.

- Missing language fails validation (never defaulted to English)
- Missing variant with multiple remaining printings → `ambiguous`, confidence `null`
- Unique match → `exact`, confidence `1.0` (not a probability model)
- No match → `not_found`
- External id already bound to a different printing → write conflict, original mapping kept

No image/OCR, no fuzzy name matching, no guessed language or variant. Phase 10 still owns mention-span resolution (“Greninja 214” vs “Japanese Greninja”).

## Problem

Inputs are messy:

- Greninja
- Greninja ex
- Greninja SIR
- Greninja 214
- 214/167
- Twilight Masquerade Greninja
- Japanese Greninja

These are not the same printing. Some are not even the same card concept.

## Resolution object

Every attempt persists:

| Field | Meaning |
|---|---|
| `mention_id` | Stable id for the span / record |
| `raw_text` | Original mention |
| `context` | Title, channel, language hints, surrounding entities |
| `candidate_ids` | Ranked printing or concept ids |
| `chosen_id` | Set only when status allows |
| `chosen_layer` | `concept` · `printing` · `market_variant` · `graded` |
| `status` | See below |
| `confidence` | 0–1, never hidden |
| `evidence` | Features that supported or blocked a match |
| `resolver_version` | Code/model version |
| `created_at` | Immutable attempt; new attempt on re-resolve |

## Statuses

| Status | Meaning | May bind a printing? |
|---|---|---|
| `exact` | Unambiguous key match | Yes |
| `high_confidence` | Strong multi-field evidence, residual doubt documented | Yes, flagged |
| `probable` | Best candidate above a threshold, alternatives remain | Optional bind for analytics with lower weight; **not** for silent user-facing identity |
| `ambiguous` | Multiple plausible printings | **No** |
| `unresolved` | No adequate candidate | **No** |

**Never silently map ambiguous content to a particular printing.**

User-facing pages, creator-call entity fields, and commercial card APIs may only use `exact` or `high_confidence` unless the consumer asked for candidates.

## Evidence (TCG)

Positive evidence:

- Set name or set code
- Collector number (including fraction form)
- Language cues (“Japanese”, “JP”, “S-Chinese”, kana)
- Rarity / finish / SIR / ex / promo tokens
- Artwork or set symbol when licensed/available
- Provider id from TCC or another catalog

Negative evidence:

- Conflicting language
- Number that belongs to another set
- Variant tokens that the candidate lacks

A name-only “Greninja” tops out at `ambiguous` or concept-level, never 214/167.

## Outputs

1. Persist the resolution row
2. Link source documents and calls to `mention_id`
3. Downstream jobs that need a printing must read `status` and skip or down-weight `ambiguous` / `unresolved`
4. Re-resolution creates a new row; it does not rewrite history of calls that already stored their resolution snapshot

## Generic kernel

Non-TCG verticals use the same statuses and evidence shape against their own entity types. The TCG printing key is a pack plugin to this engine.
