# Phase 11 — Creator call extraction

Status: **implemented**. Phase 12 has **not** started.

Source content becomes structured, auditable market calls. This is not creator authority ranking. Fixture extractors only. No production OpenAI/Anthropic/Grok calls.

## Domain

| Location | Role |
|---|---|
| `packages/db/src/schema/creator.ts` | Creator, account map, call, outcome slot |
| `packages/db/drizzle/0011_phase11_creator.sql` | Migration |
| `packages/db/src/creator/` | Extract, price-at-call, ingest, queries |
| `packages/contracts/src/creator.ts` | Catalogs (no Zod) |
| `apps/api/src/creator-contracts.ts` | Internal Zod only |

Creators are **platform-global**. One creator may map to many source accounts. Auto-provisioned links are `unresolved_ownership` until confirmed. One account is not assumed to be one person.

## Call fields

`creator_id`, `source_account_id`, `content_id`, segment/mention, `published_at`, printing when `exact`/`high_confidence`, price-at-call, direction, optional target price/percent, horizon, optional stated confidence, extraction confidence, resolution status/confidence, evidence, fingerprint, status.

Directions: `bullish`, `bearish`, `neutral`, `watch`, `avoid`, `unknown`.

A mention becomes a call only with recommendation/prediction language (`will go up`, `I would buy`, `sell now`, `overpriced`, `target $100`). Pulls and bare price quotes are not calls.

## Extraction

Default: `creator.extract.v1` deterministic extractor.

LLM interface exists with `FixtureLlmCreatorCallExtractor`. Model output is untrusted and must pass `validateExtractedCall`. No paid model in tests.

Horizons: `7d`, `30d`, `90d`, `180d`, `365d`, `custom` when the source states another duration, else `unspecified`. Horizons are never invented.

Targets are stored only when explicit. “Going up” is direction-only.

## Price at call

`price_at_call.v1` uses Phase 08 snapshots with `observed_at <= published_at` only. Latest ungraded **NM** sold, else latest ungraded sold, else latest reference. Listings are not sold. Future snapshots are never used.

## Immutability and duplicates

Finalized calls cannot be updated or deleted. Corrections insert a new call with `revises_call_id`. Duplicate content/mention/direction/horizon fingerprints return `duplicate`.

## Outcomes

Each call gets a `creator_call_outcome` row with `evaluation_status=pending`. Phase 11 does not score authority.

## Queries

Calls by creator, printing, date, direction, unresolved (no printing), awaiting outcome.

## Security

Platform-global, no tenant RLS. Tenants SELECT only. INSERT is system principal. Calls are immutable.

## Phase 12 boundary

Do not compute authority scores, trust states, or sample-size ranking yet.
