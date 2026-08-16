# Industry packs: kernel vs first vertical

The **shared kernel is not TCG-specific**.  
**TCG is the first complete commercial vertical**, not an optional later experiment.

## Rule

| Layer | TCG-specific? |
|---|---|
| Tenancy, auth, billing, CRM, email, API, webhooks, jobs | No |
| Observation, signal, score, prediction, content, resolution, creator, index | No (generic types) |
| Printing key, language books, collectible analytics, TCG dashboard | Yes (TCG pack) |
| Generic HTTP ingest | No (reusable capability) |

Core tables do not grow `pokemon_*` columns. TCG tables and feature catalogs live in the TCG pack and **bind** to kernel ids.

## Packs

| Pack | Status | Role |
|---|---|---|
| `kernel` | Required | Platform + intelligence objects |
| `tcg` | **First commercial vertical** | Complete TCG intelligence implementation |
| `generic_http` | Supporting | Reusable ingest for any tenant |
| future packs | After TCG proves the kernel | Other industries |

v1 commercial success **requires** the TCG pack. Generic HTTP success is not sufficient.

## TCG Card Central vs TCG pack

TCG Card Central is an external system. The TCG pack is **this** product’s vertical.

The pack may later:

1. Consume TCC’s versioned API as a reference/market provider
2. Sell intelligence APIs to TCC as a customer
3. Ingest YouTube/Reddit/other sources independently of TCC

The pack may not import TCC’s stack or database.

## Adding a later industry

Copy the TCG pattern: identity plugin, source bindings, feature catalog, dashboards — without forking tenancy, billing, or the observation/prediction kernel.
