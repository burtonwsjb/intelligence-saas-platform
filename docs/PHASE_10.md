# Phase 10 — Advanced entity resolution

Status: **implemented**. Later phases through Phase 14 are complete; see [PHASE_14.md](PHASE_14.md). Phase 15 has **not** started.

Mentions and provider references resolve to canonical entities—especially exact TCG printings—with persisted candidates, evidence, and confidence. The resolver is evidence-based and never forces a winner. Fixture catalog only. No image/OCR. No production TCC.

## Domain boundary

| Location | Role |
|---|---|
| `packages/db/src/schema/resolution.ts` | Attempt, candidate, and correction tables |
| `packages/db/drizzle/0010_phase10_resolution.sql` | Migration |
| `packages/db/src/resolution/` | Resolver, signals, persistence |
| `packages/contracts/src/resolution.ts` | Catalogs (no Zod) |
| `apps/api/src/resolution-contracts.ts` | Internal Zod only |

Phase 07 `resolveTcgPrinting` remains the deterministic exact-printing lookup. Phase 10 wraps it with mention context, fuzzy candidates, history, and review. Kernel tables stay industry-neutral.

## Resolution states

| Status | Printing bind? | Meaning |
|---|---|---|
| `exact` | Yes | Conflict-free external id or complete structured identity |
| `high_confidence` | Yes, flagged | Unique remaining printing with residual doubt (e.g. fuzzy name plus strong identity) |
| `probable` | No | Best concept/candidate above threshold; not user-facing identity |
| `ambiguous` | No | Multiple plausible printings or missing language/variant under cross-identity |
| `unresolved` | No | No adequate candidate |
| `conflict` | No | External id and structured/language evidence disagree |

`not_found` from Phase 07 maps to `unresolved`.

## Deterministic first

1. Conflict-free external provider id (`tcg_printing_identifier`)
2. Exact structured identity: game + set + collector + **language** + variant
3. Only then contextual parse and controlled fuzzy name matching

Fuzzy similarity cannot produce `exact` by itself. Unicode NFKC is allowed. Japanese is **not** transliterated into English.

## Language and variant safety

- Language is never defaulted to English.
- `content_language` on source content is a **hint**, not printing identity.
- Missing language when remaining candidates span languages → `ambiguous`.
- Missing variant when remaining candidates span variants → `ambiguous`.
- Language-specific aliases (`ゲッコウガ`, `甲贺忍蛙`) match the concept and add `name_language_alias` evidence; they do not silently fill `language`.

## Confidence model

Resolution confidence is **not** market-prediction confidence, creator authority, or sentiment confidence. Version: `resolver.v1`. Stored 0..1 when a bind is made; `null` for ambiguous/unresolved/conflict.

## Evidence

Persisted per candidate: `external_id_exact`, `collector_exact`, `set_exact`, `language_exact`, `variant_exact`, `name_exact`, `name_similarity`, `name_language_alias`, `context_clue`, `content_language_hint`, `conflicting_attribute`, `manual_review`.

## History and review

Attempts are append-only. Re-resolution inserts a new row. Mentions are not mutated.

Review foundation (no admin UI): `accept_candidate`, `reject_candidate`, `mark_unresolved`, `correct_mapping`. Corrections are audited in `entity_resolution_correction` and produce a **new** attempt. Original rows stay.

## Source mention link

`resolveSourceMention` reads Phase 09 mentions and writes attempts with `subject_type=mention`. Unresolved mention metadata remains. Market/prediction consumers should prefer `exact` / `high_confidence` printing binds.

## Security

Platform-global tables, no tenant RLS. Tenants SELECT only. INSERT is worker + `principal_type=system`. History cannot be updated or deleted.

## Phase 11 boundary

Do not extract creator calls, authority scores, or price-at-call.
