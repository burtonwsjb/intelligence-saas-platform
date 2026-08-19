# Phase 06 — Core intelligence kernel

Status: **implemented**. Phase 07 is complete; see [PHASE_07.md](PHASE_07.md). Phase 08 has **not** started.

Industry-neutral substrate for entities, identifiers, observations, metrics, signals, evidence, feature snapshots, and decision-record foundations. No TCG identity, TCG Card Central, YouTube, Reddit, creator intelligence, market indices, prediction execution, or opportunity scoring.

`docs/architecture/01-product-principles.md` and `docs/architecture/02-domain-model.md` are not in this repo. Closest documents: [01-product-scope.md](architecture/01-product-scope.md), [02-system-architecture.md](architecture/02-system-architecture.md), [04-logical-data-model.md](architecture/04-logical-data-model.md).

## Intelligence kernel model

The kernel module in `@isp/db` (`normalizeSourceEvent`) normalizes a durable `source_event` into canonical analytical rows. Shared types live in `@isp/contracts`. The kernel is a tenant-scoped, append-oriented fact store. JSON `attributes` / `features` / `result` fields are **data only** — never executable code, never HTML to render, never fetched URLs.

Generic core tables (no `card_name`, `set_name`, `collector_number`, `pokemon`, `tcgplayer_price`, `ebay_price`, `youtube_creator`):

| Table | Role |
|---|---|
| `source_definition` | Platform catalog of source keys and reliability priors |
| `entity` | Canonical tenant entity |
| `entity_identifier` | Deterministic source identifier → entity map |
| `observation` | Immutable factual evidence |
| `observation_metric` | Queryable numeric/text facts |
| `evidence_reference` | Provenance identifiers |
| `feature_snapshot` | Immutable versioned inputs |
| `signal` | Derived interpretation with required confidence |
| `signal_evidence` | Signal → observation/evidence links |
| `decision_record` | Foundation only (`draft` → `finalized`) |
| `decision_evidence` | Decision → signal/evidence links |

## Entity model

Tenant-scoped `entity`:

- `id`, `organization_id`, `entity_type`, `canonical_key`, optional `display_name`, `status` (`active` \| `archived`), JSON `attributes`, `created_at`, `updated_at`
- Unique `(organization_id, canonical_key)`
- `entity_type` constrained to `^[a-z][a-z0-9_]{0,63}$`
- Identity fields (`id`, `organization_id`, `entity_type`, `canonical_key`) are immutable
- Soft archive via `status`; rows are not deleted
- v1 types: `sku`, `product`, `listing`, `account`, `item`, `generic`

Canonical key: `{entityType}:{sourceNamespace}:{identifierType}:{normalizedValue}`.

## Identifier model

`entity_identifier` maps an external identifier to one canonical entity.

- Unique `(organization_id, source_namespace, identifier_type, normalized_value)`
- Normalization: trim, lowercase, collapse whitespace (`normalizeIdentifierValue`)
- Rebinding the same identifier to a different entity raises `IdentifierCollisionError` (no silent reassignment)
- Generic examples: `sku`, `external_product_id`, `listing_id`, `account_id`, `generic_id`
- HTTP ingest namespace: `ingest`

Phase 06 matching is **deterministic lookup only**. If no mapping exists, a new entity is created with a stable id derived from organization + canonical key. Fuzzy / multi-source resolution is Phase 10.

## Observation semantics

Observations are facts, not recommendations.

- One observation per `source_event` (`observation.id` = `source_event.id`)
- `entity_id` is set when a deterministic identifier exists (v1 ingest always resolves or creates)
- `observed_at` = source `occurred_at` (event time)
- `received_at` = ingest `received_at` (not overwritten by `created_at`)
- `observation_type` comes from the v1 event registry mapping
- `confidence` nullable — never invented
- `quality_flag` bounded: `complete` \| `partial` \| `stale` \| `conflicting` \| `suspect`
- v1 quality: empty metrics → `partial`, else `complete`
- Corrections: insert a **new** observation, optionally `supersedes_observation_id`. Do not rewrite history.

Generic observation types include price/inventory/volume/sentiment/rank snapshots without TCG semantics.

## Metrics

`observation_metric` stores queryable facts:

- PostgreSQL `numeric(20, 8)` as strings (no floating-point money, no hidden FX conversion)
- Exactly one of `numeric_value` or `text_value`
- `metric_key` dotted lowercase (`price.usd`)
- `unit` explicit when relevant
- Source precision preserved via `Number#toString()` then numeric storage

## Signals

A signal is a derived interpretation. v1 ingest emits a generic `snapshot` signal (`algorithm_key=kernel.normalize`, version `1`) so fixture events produce observations **and** signals without TCG or scoring logic.

Required: `confidence` in `[0, 1]`, `algorithm_key`, `algorithm_version`, `valid_from`. Optional `valid_until`, `magnitude`, `score`, `feature_snapshot_id`.

Directions: `up` \| `down` \| `flat` \| `unknown`.

Generic future types (not hard-coded now): `momentum`, `velocity_change`, `supply_change`, `demand_change`, `sentiment_shift`, `anomaly`, `risk_change`.

## Evidence / provenance

`evidence_reference` stores identifiers only (`source_event`, `observation`, or `external`). No HTML, no fetch.

`signal_evidence` and `decision_evidence` use composite FKs `(organization_id, …)` so tenant A cannot attach B’s evidence. A signal without evidence is invalid at the kernel API (`requireSignalEvidence`).

## Feature snapshots

Immutable `feature_snapshot`: versioned `feature_set_key` / `feature_set_version`, JSON `features`, SHA-256 `fingerprint` of canonically sorted JSON, `as_of` = event time. v1 set: `ingest.v1` / `1`.

## Decision records

Foundation only. Worker does **not** auto-create decisions. Drafts may update; `finalized` rows are immutable (payload cannot change on finalize). Later recommendation scoring (Phase 14) will use `policy_key`, `policy_version`, and `feature_snapshot_id` already stored here. No LLM decisions.

## Confidence / quality

| Kind | When | Bounds |
|---|---|---|
| Source quality / reliability prior | `source_definition.default_reliability_weight` | 0..1 |
| Measurement confidence | `observation.confidence` | nullable 0..1 |
| Signal confidence | `signal.confidence` | required 0..1 |
| Prediction probability | later phases | not in Phase 06 |

Do not conflate these. Quality flags are separate from confidence.

## Timestamp semantics (UTC)

| Field | Meaning |
|---|---|
| `occurred_at` / `observed_at` | When the fact happened in the source |
| `received_at` | When the platform ingested it |
| `created_at` | Row insert time |
| `valid_from` / `valid_until` | Signal validity window |
| `as_of` | Feature snapshot time |

Event time is never replaced with ingestion time.

## Normalization flow

1. BullMQ job envelope validated
2. Worker binds system tenant context
3. Load `source_event`; tenant mismatch is permanent
4. If `processed` or observation already exists → idempotent return
5. Parse v1 generic event contract
6. Resolve/create entity via identifier lookup
7. Insert observation, metrics, evidence, feature snapshot, snapshot signal + evidence
8. Mark `source_event` `processed`
9. Commit in one `withSystemContext` transaction

Unknown `event_type` is a permanent failure. No arbitrary observations from unknown types. Do not guess semantics from `payload`.

### v1 generic event registry

`metric.snapshot`, `pricing.snapshot` (legacy generic metric event, preserved), `transaction.summary`, `inventory.snapshot`, `sentiment.snapshot`, `ranking.snapshot`.

`pricing.snapshot` maps to observation type `metric.snapshot`.

Ingest (`POST /v1/events`) and the worker both reject unknown types.

## Idempotency

- Unique observation per `(organization_id, source_event_id)`
- Observation id = source event id
- Deterministic ids for entity, identifier, metrics, evidence, snapshot, signal
- Identifier unique constraint + collision error
- Worker replay of a processed event returns `duplicate` and does not insert again

## Immutability (application roles)

| Table | `app_user` / `app_worker` |
|---|---|
| `observation`, `observation_metric`, `evidence_reference`, `feature_snapshot`, `signal`, `signal_evidence`, `entity_identifier`, `decision_evidence` | SELECT + INSERT; UPDATE/DELETE revoked; triggers forbid mutate |
| `entity` | SELECT + INSERT + UPDATE of non-identity fields; DELETE revoked; identity trigger |
| `decision_record` | SELECT + INSERT + UPDATE of `draft` only; DELETE revoked; finalized trigger |
| `source_definition` | SELECT only (platform catalog) |

High-volume analytical inserts are **not** audit-logged. Audit remains lifecycle/security: `source_event.accepted`, `job.permanent_failure`. Entity merge and decision finalize audits wait until those workflows exist.

## Tenant security

Every tenant-owned kernel table uses FORCE RLS with `organization_id = app.current_organization_id()` and `app.is_authorized_principal()`. Composite FKs prevent cross-tenant entity/evidence links. Machine and worker principals stay bound to the job organization.

## Indexing

| Index | Why |
|---|---|
| `entity (organization_id, canonical_key)` unique | Deterministic create/lookup |
| `entity_identifier (organization_id, source_namespace, identifier_type, normalized_value)` unique | Identifier resolution |
| `observation (organization_id, entity_id, observed_at)` | Entity history |
| `observation (organization_id, observation_type, observed_at)` | Type time range |
| `observation (organization_id, source_event_id)` unique | Normalization linkage / idempotency |
| `observation_metric (organization_id, metric_key)` | Metric scans; `observed_at` comes from joining `observation` |
| `signal (organization_id, signal_type, valid_from)` | Signal history |
| `feature_snapshot (organization_id, entity_id, as_of)` | Snapshot history |
| `decision_record (organization_id, entity_id, created_at)` | Decision history |

No extra covering indexes until query load is measured.

## Historical analytics

Tenant-scoped repositories (not public commercial APIs):

- `listEntities` / `listEntityIdentifiers`
- `listObservationsInRange` / `listObservationMetricsInRange`
- `listSignalsInRange` / `listFeatureSnapshotsInRange`
- `listDecisionRecords`

All require an active tenant context.

## Source reliability foundation

`source_definition` is platform-owned (no tenant RLS, no credentials). Seeded keys: `generic_http`, `ingest` with `default_reliability_weight=1`. No YouTube/Reddit/TCC instances. No creator accuracy, no Bayesian scoring. Later weighting can read this prior.

## Phase 07 handoff

Phase 07 added TCG canonical identity and a TCG Card Central **sandbox** contract as pack tables plus `entity_type=tcg_printing`. The generic kernel was not given TCG columns. See [PHASE_07.md](PHASE_07.md). Do not start Phase 08 until explicitly instructed.

## Known limitations

- Snapshot signals are provenance placeholders, not opportunity or momentum scores
- Decision records are not produced by the worker
- Fuzzy entity resolution is not implemented
- No public `/v1/entities` or `/v1/decisions` commercial routes
