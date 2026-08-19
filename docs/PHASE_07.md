# Phase 07 — TCG canonical identity and TCG Card Central sandbox contract

Status: **implemented**. Phase 08 is complete; see [PHASE_08.md](PHASE_08.md). Phase 09 has **not** started.

TCG-specific identity lives beside the generic intelligence kernel. No market-history ingestion, no real TCG Card Central network calls, no TCC credentials, no commercial TCG API.

## TCG domain boundary

Generic kernel tables (`entity`, `entity_identifier`, `observation`, `observation_metric`, `signal`, and related fact tables) stay industry-neutral. They do **not** gain `collector_number`, `language`, `variant`, `card_name`, or set fields.

TCG reference data lives in `@isp/db`:

| Location | Role |
|---|---|
| `packages/db/src/schema/tcg.ts` | Drizzle tables |
| `packages/db/drizzle/0007_phase07_tcg.sql` | Versioned migration |
| `packages/db/src/tcg/` | Catalog, resolution, fixtures, sandbox provider, kernel link |
| `packages/contracts/src/tcg.ts` | Shared types and runtime parsers (no Zod; lockfile has no `zod` on `@isp/contracts`) |
| `apps/api/src/tcg-contracts.ts` | Zod schemas for the same shapes |

A new `packages/tcg` workspace package is **not** added (frozen lockfile). TCG records reference generic kernel entities by id where a tenant analytical subject is required.

## Game model

Platform-global `tcg_game` (no `organization_id`, no tenant RLS). Seeded keys:

`pokemon`, `one_piece`, `magic`, `lorcana`, `yugioh`, `other`

Fields: `game_key`, `display_name`, optional `publisher`, `status`, `created_at`.

Games are **not** tenant-duplicated. Pokémon is not assumed to be the only game.

## Languages

Language is mandatory on exact printings and exact-resolution requests.

Required catalog codes: `en`, `ja`, `zh-Hans`.

Extensible catalog: `zh-Hant`, `ko`, `de`, `fr`, `es`, `it`, `pt` (BCP 47-style tags). Additional tags can be inserted through trusted import/migration, not tenant APIs.

Rules:

- Do not infer language from card name text
- Do not default missing language to English
- Do not map `jp` to `ja` or `zh` to `zh-Hans`
- Do not merge English, Japanese, and Simplified Chinese printings
- Do not collapse all Chinese into one undifferentiated "Chinese" value

Missing language on exact resolution fails validation (`TcgValidationError`). Invalid codes are rejected.

## Set model

Platform-global `tcg_set`:

- `id` (deterministic hash of `game_key` + `canonical_set_key`)
- `game_key`
- `canonical_set_key` (per game; not assumed globally unique across games)
- `name` (display; not identity)
- optional `language_scope` when a localized release is a distinct catalog object
- optional `release_date`
- `status`

One global set code is **not** treated as sufficient across all games and languages. Source-specific set IDs belong in identifier mappings, not as a replacement for `canonical_set_key`.

## Card concept model

Platform-global `tcg_card_concept` is the conceptual card ("Greninja ex", "Monkey D. Luffy"), **not** exact identity.

- `id`, `game_key`, `concept_key`, `canonical_name`, `normalized_name`, bounded JSON `attributes`, `status`
- Normalized name is NFKC + trim + collapse whitespace
- Display names are preserved exactly
- Japanese is not transliterated into English
- Card name alone is never an exact-printing key

## Exact printing model

Platform-global `tcg_printing` is the identity row later market series will attach to.

Required identity: game, card/concept, set, collector number (original + normalized lookup form), language, variant key.

Optional bounded attributes: `rarity`, `finish`, `edition`, `promo`, JSON `attributes`.

Unique:

- `canonical_printing_key`
- `(set_id, collector_number_normalized, language_code, variant_key)`

## Variants

Variant is a canonical key, not display text. Catalog:

`normal`, `holofoil`, `reverse_holo`, `parallel`, `alt_art`, `promo`, `first_edition`, `unlimited`, `serialized`, `special_finish`

Not every value applies to every game. Extra traits stay in bounded `attributes` rather than exploding nullable columns. Unknown keys are rejected. `normal` and `holofoil` never collapse. Promo vs standard is a different variant and/or set (`promo` flag is additional, not a substitute for identity).

If language is present but variant is omitted and multiple variants exist, resolution returns `ambiguous`.

## Collector numbers

Stored as text. Original display value is preserved (`174/172`, `TG05/TG30`, `031`, `P-001`, `OP01-001`).

Normalized lookup form: Unicode NFKC, trim, lowercase, collapse whitespace. Never coerced to integer. Set + collector number without language/variant is not unique.

## Canonical printing key

```text
tcg:{game}:{concept_key}:{set}:{normalized_collector}:{language}:{variant}
```

Properties:

- stable and reproducible from identity fields
- unique for an exact printing
- independent of database auto-increment
- independent of display-name changes
- includes `concept_key` for collision safety

Kernel entity canonical key:

```text
tcg_printing:tcg:canonical_printing_key:{printing_key}
```

## Global vs tenant-owned data

| Data | Scope | RLS | Runtime writes |
|---|---|---|---|
| `tcg_game`, `tcg_language`, `tcg_set`, `tcg_card_concept`, `tcg_printing`, `tcg_printing_identifier`, `tcg_identifier_conflict` | Platform-global canonical reference | No tenant RLS | `app_user` / `app_worker`: SELECT only. INSERT via trusted system/migration/admin path. UPDATE/DELETE forbidden by trigger `app.forbid_tcg_canonical_mutate()` |
| Kernel `entity` of type `tcg_printing` | Tenant-owned analytical subject | FORCE RLS | Tenant/worker may create the link; cannot rewrite global printing identity |

Tenant API keys cannot alter canonical game/set/card/printing identity.

## Source identifiers

`tcg_printing_identifier` maps external ids onto one canonical printing:

- `tcg_card_central_catalog_id`
- `tcgplayer_product_id`
- `ebay_reference_id`
- `manufacturer_id`
- `internal_legacy_id`

Source IDs are aliases. They do not redefine canonical identity. TCGplayer/eBay are **not** fetched in this phase.

The same `(source_namespace, identifier_type, normalized_value)` cannot bind to two printings.

## Conflict handling

Rebinding an existing identifier to a different printing:

1. Insert `tcg_identifier_conflict` (existing vs attempted printing ids)
2. Throw `TcgIdentifierConflictError`
3. Leave the original mapping unchanged

No silent remap. Identifier rows are immutable after insert. Manual resolution is a later operator workflow.

## Kernel entity linkage

`ensureTcgPrintingEntity`:

- TCG printing = domain identity (global)
- generic `entity` (`entity_type=tcg_printing`) = tenant analytical subject
- one stable link **per tenant** (kernel entities are tenant-scoped)
- idempotent: replay returns the same entity id
- observations in later phases attach to that entity id

Generic ingest already accepts `entity.type=tcg_printing` without adding TCG columns to kernel tables. Phase 08 projects optional tenant observations from global market snapshots onto that entity. Phase 07 does **not** ingest prices.

## TCC sandbox contract

TCG Card Central is a separate external system. No shared database, auth, Stripe, storage, or sessions.

Versioned identity operations (contract only; fixtures implement them):

- `GET /v1/cards/{id}`
- `GET /v1/printings/{id}`
- `POST /v1/printings/resolve`
- `GET /v1/sets/{id}`

Market-price routes remain deferred to the commercial API (Phase 16). Phase 08 stores fixture market history internally.

## TCC provider

`TcgIdentityProvider`:

- `getPrintingByExternalId`
- `resolvePrinting`
- `getSet`
- `healthCheck`

`SandboxTcgCardCentralProvider` uses in-memory fixtures only. No `fetch`, no `tcgcardcentral.com`, no token.

## Future TCC auth

Documented, not implemented:

- Server-side only (never browser / Next.js public env)
- Versioned, scoped Bearer token or HMAC
- Rotation-capable
- `.env.example` names only: `TCC_API_BASE_URL=`, `TCC_API_TOKEN=` (empty)

No real secret exchange in Phase 07.

## Fixture behavior

`seedTcgIdentityFixtures` is representative identity data, not market data. Distinctions covered:

1. Same concept, different set (Pikachu SV1 vs SV2)
2. Same card/set/number, English vs Japanese (Greninja ex TWM 214/167)
3. Same card/set/number, Simplified Chinese vs other languages
4. Same card/set/number/language, different variant (normal / holofoil / reverse_holo)
5. Same collector number in different sets (Charizard `174/172` on SV1 vs promo set)
6. Promo vs standard
7. Pokémon examples (Greninja, Pikachu, Charizard — not Charizard-only)
8. One Piece `OP01-001` English vs Japanese

## Resolution states

Deterministic exact-printing lookup only. No image/OCR, no fuzzy match, no guessed language or variant.

| Status | Confidence | Bind? |
|---|---|---|
| `exact` | `1.0` (explicit match, not a probability model) | Yes |
| `ambiguous` | `null` (not fabricated) | No |
| `not_found` | `null` | No |
| `conflict` | write-path only (`TcgIdentifierConflictError`) | No silent rebind |

This is distinct from later image/AI identification confidence (Phase 10+).

## Phase 08 handoff

Phase 08 ingested TCG market history keyed by exact printing. See [PHASE_08.md](PHASE_08.md).

## API

No public commercial TCG routes (`cards:read`, `prices:read`, `markets:read`). Those wait for Phase 16. Internal Zod contracts exist in `apps/api` for validation only.

## Known limitations

- No production TCC client
- No tenant-owned holdings/overrides table yet (portfolio is later)
- No fuzzy / mention resolution (Phase 10)
- No production market-provider clients
