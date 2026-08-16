# Industry packs and multi-industry expansion

The core platform is industry-agnostic. Vertical knowledge is added as a **pack**.

A pack is configuration and code boundaries, not a second database.

## Pack contents

| Part | Examples |
|---|---|
| Connector types | How an industry system sends events or exposes reference data |
| Entity type hints | Suggested `entity_type` keys (`sku`, `listing`, `location`) |
| Metric keys | Suggested measures (`price.usd`, `qty.on_hand`) |
| Decision types | `price.recommend`, `restock.priority`, `risk.flag` |
| Policy templates | Starting rules a tenant can clone |
| Reference-data clients | Optional outbound clients to an industry authority |

Core tables do not gain TCG columns, restaurant columns, or any other vertical columns.

## Packs in view

| Pack | Status | Role |
|---|---|---|
| `generic` | v1 required | HTTP ingest, generic entities, generic decisions |
| `tcg` | later | Optional. Uses TCG Card Central only as an external API provider/consumer |
| future packs | unscheduled | Other industries when a tenant and contract exist |

v1 success does not require the TCG pack.

## TCG pack, when added

TCG Card Central is **not** the pack. It is one external system the TCG pack may talk to.

The TCG pack may:

1. Map TCC’s future versioned API into generic entities and metrics
2. Let a TCC tenant call this platform’s intelligence APIs
3. Ship TCG-oriented policy templates

The TCG pack may not:

- Import TCC’s application stack
- Clone TCC tables into this database as the source of truth
- Share auth, billing, or hosting with TCC
- Make TCG identity a required concept for non-TCG tenants

## Adding a new industry

1. Define connector and decision types
2. Add policy templates
3. If a reference authority exists, add an outbound client behind the same secrets model
4. Do not fork the core schema

This is how the product expands without becoming a TCG company that later pretends to be a platform.
