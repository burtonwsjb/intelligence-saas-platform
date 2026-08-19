# Integrations

Contracts only. Nothing is connected. TCG Card Central is not modified.

## Integration law

1. Never open another product’s database
2. Never deploy into another product’s host
3. Never reuse another product’s Stripe, auth, or email
4. External systems never write this database directly
5. HTTPS + credentials + versioned contracts only
6. TCC’s stack is irrelevant to this stack
7. TCG **vertical** is first-party in this repo; TCC **product** is external

## Ingest connectors

| Type | Role | Phase |
|---|---|---|
| `generic_http` | Reusable capability. Phase 05 ingest + Phase 06 kernel normalization | 05 / 06 |
| `market_feed` | Licensed/TCC/other price & sales (Phase 08: fixture ingest only) | 08 |
| `youtube` | Permitted metadata + derived extracts | 09 |
| `reddit` | Permitted posts + derived social signals | 09 |
| `tcg_card_central` | Sandbox 07; production 23 only with go-ahead | 07 / 23 |

## TCG Card Central

Roles only:

1. External integration
2. Potential authoritative identity/set/language/price/history **provider** via TCC’s future versioned API
3. One future **customer** of this SaaS’s intelligence APIs

This platform still owns canonical printing identity ([17-tcg-canonical-identity.md](./17-tcg-canonical-identity.md)). TCC ids are `provider_refs`.

Conceptual TCC provider routes (TCC would build; this platform does not host TCC):

```text
GET /v1/cards/{id}
GET /v1/printings/{id}
POST /v1/printings/resolve
GET /v1/sets/{id}
GET /v1/cards/{id}/price              (commercial API later; Phase 08 stores fixture history internally)
GET /v1/cards/{id}/price-history      (commercial API later)
```

As customer, TCC would call this platform’s commercial `/v1` intelligence API with a normal tenant key.

Phase 07 uses **in-memory fixtures only** (`SandboxTcgCardCentralProvider`). Phase 08 market providers are also in-memory fixtures. No staging or production TCC/TCGplayer/eBay network calls. Production TCC is Phase 23 with an explicit command.

## YouTube and Reddit

See [20-source-intelligence.md](./20-source-intelligence.md). ToS and copyright reviewed before Phase 09. Prefer URL + structured extracts over raw transcripts.

## Stripe and Resend

[06-billing.md](./06-billing.md), [14-crm-and-gtm.md](./14-crm-and-gtm.md).

## Forbidden

- TCC database or service-role access
- Embedding this app on TCC Railway
- Using social APIs as a buy-signal oracle
