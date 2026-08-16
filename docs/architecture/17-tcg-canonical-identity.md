# TCG canonical identity

Identity is designed **before** the TCG Card Central integration is built. Cards are not identified by name + collector number alone.

This is TCG-pack identity. Non-TCG tenants never require these tables.

## Four (plus one) identity layers

| Layer | What it is | Example |
|---|---|---|
| 1. Canonical card concept | The character/card idea across printings | “Greninja” as a concept, or “Greninja ex” as a distinct card concept when the game treats it as a different card |
| 2. Exact printing | One published printing | Twilight Masquerade English Greninja ex 214/167, specific artwork and finish |
| 3. Market variant | How the market trades that printing | Raw NM vs lightly played; or a specific promo stamp that clears at a different price |
| 4. Physical inventory item | One tenant-owned copy | A user’s card with qty, cost basis, acquisition date |
| 5. Graded / slabbed item | A certified copy | PSA 10 of that exact printing, cert number when known |

Market history attaches to **exact printing** (and to market variant / grade when the market is split). It does not attach to the bare concept.

## Exact printing key

Minimum fields for an exact printing:

| Field | Required | Notes |
|---|---|---|
| `game` | yes | Stable code: `pokemon`, `one_piece`, `mtg`, … |
| `card_name` | yes | Canonical display name for that printing |
| `set_code` / `set_id` | yes | Set identity, not only set name |
| `collector_number` | yes | As printed; do not drop the denominator when it is part of the printed number |
| `language` | yes | BCP 47 / ISO-derived internal code |
| `variant` | yes | Stamp, staff, pokeball, masterball, etc. Empty string means “base variant” |
| `printing` | yes | Print run / plate / reprint identifier when the set has multiple printings |

Evaluate and store when known:

| Field | Why |
|---|---|
| `rarity` | Cohort and index membership |
| `finish` | Holofoil, reverse, texture, etc. |
| `foil_type` | Finer than finish when markets split |
| `edition` | 1st edition vs unlimited |
| `promo_status` | Promo vs set-legal retail |
| `region` | When region is not implied by language |
| `artwork_id` | Same name/number, different art |
| `release_date` | Era and vintage/modern cuts |
| `parallel` | Numbered parallel, gold, etc. |

Uniqueness is a **normalized printing key**, not a single human string.

```text
printing_key =
  game + set_id + collector_number + language
  + variant + printing + finish + artwork_id + edition + parallel
```

Unknown optional fields are explicit `null` / `unspecified`, never silently assumed to be the English base holofoil.

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

## Concept vs printing

A **card concept** groups printings for navigation (“all Greninja ex printings”). Concepts never own a single price series.

Resolution may land on a concept when evidence is insufficient for a printing. That is `ambiguous` or `unresolved` at the printing layer, not a silent pick of 214/167 English.

## Graded items

Grade company, grade, and cert id (when present) hang off a printing:

```text
printing → graded_population(company, grade, as_of)
printing → slabbed_item(tenant, cert, grade)   // inventory layer
```

A PSA 10 index membership is grade-layer, not a different card concept.

## What TCG Card Central may provide later

TCC may be an authoritative **provider** of identity, set, language, price, and price history through its own versioned API. This platform still stores:

- its own printing keys
- a `provider_refs` map (`tcg_card_central` → foreign id)
- resolution evidence

TCC ids are aliases, not the only identity.

## Forbidden shortcuts

- Name + number as the only key
- Dropping language
- Treating “Greninja” as 214/167
- Mixing JP and EN history into one series by default
- Using inventory item ids as market series keys
