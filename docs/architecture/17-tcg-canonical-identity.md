# TCG canonical identity

Identity is designed **before** TCG Card Central production integration. Cards are not identified by name + collector number alone.

This is TCG-pack identity. Non-TCG tenants never require these tables. Implemented in Phase 07; see [PHASE_07.md](../PHASE_07.md).

## Four (plus one) identity layers

| Layer | What it is | Example | Phase |
|---|---|---|---|
| 1. Canonical card concept | The character/card idea across printings | “Greninja ex” as a concept | 07 |
| 2. Exact printing | One published printing | Twilight Masquerade English Greninja ex 214/167, specific variant | 07 |
| 3. Market variant | How the market trades that printing | Raw NM vs lightly played; a stamp that clears separately | later |
| 4. Physical inventory item | One tenant-owned copy | A user’s card with qty, cost basis, acquisition date | later |
| 5. Graded / slabbed item | A certified copy | PSA 10 of that exact printing, cert number when known | later |

Market history (Phase 08) attaches to **exact printing** (and to market variant / grade when the market is split). It does not attach to the bare concept.

## Games

Platform-global `tcg_game` keys: `pokemon`, `one_piece`, `magic`, `lorcana`, `yugioh`, `other`. Not Pokémon-only.

## Exact printing key

Minimum fields for an exact printing:

| Field | Required | Notes |
|---|---|---|
| `game` | yes | Stable code from the game registry |
| `concept_key` | yes | Card concept; not display name |
| `set` / `set_id` | yes | Per-game canonical set key; localized releases may differ |
| `collector_number` | yes | As printed (text); never coerced to integer |
| `language` | yes | Catalog BCP 47 code; never defaulted to English |
| `variant` | yes | Canonical variant key (`normal`, `holofoil`, …) |

Optional when known: `rarity`, `finish`, `edition`, `promo`, bounded JSON `attributes`.

Canonical key (deterministic, not a database sequence):

```text
tcg:{game}:{concept_key}:{set}:{normalized_collector}:{language}:{variant}
```

Unknown optional fields are explicit `null` / omitted, never silently assumed to be the English base holofoil.

## Language is first-class

Internal codes (BCP 47):

| Code | Support |
|---|---|
| `en` | Required |
| `ja` | Required |
| `zh-Hans` | Required |
| `zh-Hant` | Extensible |
| `ko` | Extensible |
| `de` | Extensible |
| `fr` | Extensible |
| `es` | Extensible |
| `it` | Extensible |
| `pt` | Extensible |
| other | Extensible via catalog, not hardcoded UI |

Rules:

- Language is part of the printing key
- Do **not** merge price, supply, liquidity, demand, grading population, or trend histories across languages unless a job is explicitly computing a cross-language analytic
- English, Japanese, and Chinese printings of similar artwork are different markets
- Display names may be localized; identity keys are not
- Do not infer language from name text; do not map `jp`/`zh` aliases

## Concept vs printing

A **card concept** groups printings for navigation (“all Greninja ex printings”). Concepts never own a single price series.

Resolution may land on a concept when evidence is insufficient for a printing. That is `ambiguous` or `unresolved` at the printing layer, not a silent pick of 214/167 English.

## Source identifiers

`tcg_printing_identifier` maps TCC/external catalog ids onto **one** canonical printing. Rebind attempts write `tcg_identifier_conflict` and fail closed. Source ids never redefine canonical identity.

## Kernel link

Each tenant gets at most one generic `entity` (`entity_type=tcg_printing`) per canonical printing, keyed from the printing key. Global TCG tables are not tenant-writable.

## Graded items

Grade company, grade, and cert id (when present) hang off a printing (later phases):

```text
printing → graded_population(company, grade, as_of)
printing → slabbed_item(tenant, cert, grade)   // inventory layer
```

A PSA 10 index membership is grade-layer, not a different card concept.

## What TCG Card Central may provide later

TCC may be an authoritative **provider** of identity, set, language, price, and price history through its own versioned API. This platform still stores:

- its own printing keys
- a `tcg_printing_identifier` map (`tcg_card_central` → foreign id)
- resolution evidence

TCC ids are aliases, not the only identity. Phase 07 implements a fixture sandbox provider only.

## Forbidden shortcuts

- Name + number as the only key
- Dropping language
- Treating “Greninja” as 214/167
- Mixing JP and EN history into one series by default
- Using inventory item ids as market series keys
