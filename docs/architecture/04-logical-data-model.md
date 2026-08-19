# Logical data model

This is a **logical** model for later implementation. It is not a migration and not SQL to run.

All tenant-owned objects include `tenant_id` and standard timestamps unless noted. Postgres RLS is planned on every tenant-owned table.

## Identity

### `users`

Owned by Better Auth, or mirrored from it.

### `profiles`

- `user_id` (pk)
- `display_name`
- `avatar_url` nullable
- `created_at`

### `tenants`

- `id`
- `slug` unique
- `name`
- `status` (`active` | `suspended` | `deleted`)
- `created_at`
- `created_by` user id

### `memberships`

- `id`
- `tenant_id`
- `user_id`
- `role` (`owner` | `admin` | `analyst` | `viewer`)
- `status` (`active` | `invited` | `revoked`)
- unique `(tenant_id, user_id)`

### `api_keys`

- `id`
- `tenant_id`
- `name`
- `key_prefix` (public hint, e.g. `isp_live_ab12`)
- `key_hash` (server only)
- `scopes` text array (`ingest:write`, `decisions:read`, `receipts:write`)
- `created_by`
- `last_used_at`
- `revoked_at`

Plaintext keys are shown once at creation and never stored.

## Connectors and catalog

### `connector_definitions`

Platform-owned.

- `type` unique (`generic_http`, later `tcg_card_central`)
- `pack_key` (`generic`, later `tcg`)
- `display_name`
- `inbound_event_types` json
- `enabled`

### `connectors`

- `id`
- `tenant_id`
- `type`
- `name`
- `status` (`configured` | `active` | `error` | `disabled`)
- `config` non-secret json
- `secret_ref` nullable
- `last_seen_at`
- `last_error`

### `decision_type_definitions`

Seeded platform types; tenants may add their own later.

- `key` (`price.recommend`, `position.action`, `restock.priority`, `risk.flag`)
- `description`
- `schema` json for recommendation payload

### `policies`

- `id`
- `tenant_id`
- `decision_type`
- `name`
- `status` (`draft` | `active` | `retired`)
- `active_version_id` nullable

### `policy_versions`

- `id`
- `policy_id`
- `tenant_id`
- `version` int
- `rules` json
- `created_by`
- `created_at`
- immutable after insert

## Data plane

### `source_events`

Immutable ingest log.

- `id`
- `tenant_id`
- `connector_id` nullable
- `event_type`
- `occurred_at`
- `ingested_at`
- `idempotency_key`
- `payload` json
- `payload_hash`
- unique `(tenant_id, idempotency_key)`

### `entities`

- `id`
- `tenant_id`
- `entity_type`
- `external_id`
- `display_name`
- `attributes` json
- `first_seen_at`
- `last_seen_at`
- unique `(tenant_id, entity_type, external_id)`

### `entity_links`

- `id`
- `tenant_id`
- `from_entity_id`
- `to_entity_id`
- `rel_type`
- unique `(tenant_id, from_entity_id, to_entity_id, rel_type)`

### `metrics`

Append-mostly facts.

- `id`
- `tenant_id`
- `entity_id` nullable
- `metric_key`
- `observed_at`
- `value` numeric
- `unit`
- `source_event_id` nullable

### `features`

Current computed inputs.

- `id`
- `tenant_id`
- `entity_id`
- `feature_key`
- `value` json
- `computed_at`
- `valid_until` nullable
- `version`
- unique `(tenant_id, entity_id, feature_key)`

## Decision plane

### `decision_records`

- `id`
- `tenant_id`
- `decision_type`
- `subject_entity_id`
- `status` (`proposed` | `accepted` | `rejected` | `expired` | `superseded`)
- `score` numeric nullable
- `confidence` numeric 0–1
- `recommendation` json
- `rationale` json (human-readable reasons + feature citations)
- `inputs_snapshot` json
- `policy_version_id` nullable
- `model_version` text nullable
- `expires_at` nullable
- `created_at`
- `superseded_by` nullable

### `decision_actions`

Suggested next steps on a record.

- `id`
- `tenant_id`
- `decision_id`
- `action_key`
- `label`
- `payload` json

### `action_receipts`

- `id`
- `tenant_id`
- `decision_id`
- `action_key` nullable
- `result` (`accepted` | `rejected` | `acted` | `ignored`)
- `actor_user_id` nullable
- `actor_kind` (`user` | `connector` | `system`)
- `occurred_at`
- `note` nullable

## CRM

Platform-owned. Not tenant Decision Record data.

### `crm_accounts`

- `id`
- `name`
- `tenant_id` nullable unique
- `status` (`lead` | `trial` | `active` | `at_risk` | `past_due` | `cancelled` | `churned` | `reactivated` | `enterprise_prospect`)
- `owner_user_id` nullable

### `crm_contacts`

- `id`
- `account_id`
- `email`
- `name`
- `user_id` nullable

### `crm_opportunities`

- `id`
- `account_id`
- `stage`
- `plan_key` nullable
- `amount_usd` nullable
- `close_date` nullable

### `crm_activities`

- `id`
- `account_id`
- `contact_id` nullable
- `kind` (`note` | `email` | `call` | `support`)
- `body`
- `occurred_at`

## Billing and jobs

### `billing_customers`

- `tenant_id` unique
- `stripe_customer_id` unique
- `email`

### `subscriptions`

- `id`
- `tenant_id`
- `stripe_subscription_id` unique
- `plan_key`
- `status`
- `current_period_end`

### `entitlements`

- `tenant_id`
- `flag` / `limit_key`
- `value`
- `source` (`plan` | `override`)

### `usage_events`

- `id`
- `tenant_id`
- `meter_key` (`api.requests`, `ingest.events`, `predictions.issued`, `webhooks.delivered`, `content.generated`)
- `quantity`
- `occurred_at`
- `stripe_reported_at` nullable

### `webhook_endpoints` / `webhook_deliveries`

- tenant endpoint URL, secret ref, subscribed event types, disabled_at
- delivery: event_id, attempt, status, response_code, next_retry

### `job_runs`

Observability only. Redis + BullMQ is the broker.

- `id`
- `tenant_id` nullable
- `queue`
- `kind`
- `bullmq_job_id`
- `status`
- `attempts`
- `started_at`
- `finished_at`
- `error`

### `audit_logs`

- `id`
- `tenant_id` nullable
- `actor_user_id` nullable
- `actor_kind`
- `action`
- `resource_type`
- `resource_id`
- `before` json nullable
- `after` json nullable
- `ip` nullable
- `created_at`

## Kernel intelligence (industry-independent)

These are not TCG tables. TCG printings bind to `entities` / pack tables.

### `source_documents`

- `id`, `source_type`, `external_id`, `url`, `author_id`, `published_at`, `license_status`, `raw_ref`, `derived`, `data_quality`

### `source_platform` / `source_account` / `source_content` / `source_content_segment` / `source_mention` / `source_engagement_snapshot` / `source_ingest`

Implemented in Phase 09 as platform-global tables (no tenant RLS). See [PHASE_09.md](../PHASE_09.md).

- Public source accounts and content are shared reference facts
- Mentions do not bind exact printings in Phase 09
- Excerpts are bounded; full transcripts are not stored

### `mentions` + `entity_resolutions`

- raw text, context, status (`exact`|`high_confidence`|`probable`|`ambiguous`|`unresolved`|`conflict`), confidence, evidence, versions

Implemented in Phase 10 as platform-global `entity_resolution_attempt`, `entity_resolution_candidate`, `entity_resolution_correction`, and `tcg_card_name_alias`. See [PHASE_10.md](../PHASE_10.md). Attempts are append-only. Printings bind only for `exact` / `high_confidence`.

### `observations` / `signals` / `score_snapshots`

Phase 06 implements tenant-scoped `observation`, `observation_metric`, `signal`, `feature_snapshot`, and a `decision_record` foundation. See [PHASE_06.md](../PHASE_06.md). Score snapshots, opportunity components, and TCG market bars remain later phases. Do not put TCG printing fields on kernel tables.

### `creators` / `creator_calls` / `creator_call_outcomes` / `creator_authority_slices` / `creator_trust_states`

- calls immutable; outcomes and slices versioned; trust audited

Phase 11 implements platform-global `creator`, `creator_source_account`, `creator_call`, and pending `creator_call_outcome` slots. See [PHASE_11.md](../PHASE_11.md). Authority slices are Phase 12.

### `index_specs` / `index_constituents` / `index_levels`

- point-in-time membership for survivorship-safe history

### `predictions` / `prediction_outcomes`

- horizons, ranges, versions; outcomes include alpha and calibration

### `content_candidates` / `evidence_packages`

- no generation without evidence

### `market_bars_*` / `market_state_vectors`

- partitioned time series; vectors for later similarity (not a model until validated)

## TCG pack identity (not in the kernel)

Implemented in Phase 07 as platform-global tables (no tenant RLS). See [PHASE_07.md](../PHASE_07.md).

### `tcg_game` / `tcg_language`

- Game registry (`pokemon`, `one_piece`, `magic`, `lorcana`, `yugioh`, `other`)
- Language catalog: `en`, `ja`, `zh-Hans` required; `zh-Hant`, `ko`, `de`, `fr`, `es`, `it`, `pt` extensible

### `tcg_set`

- Per-game `canonical_set_key`; optional language scope and release date
- Localized releases may be distinct sets

### `tcg_card_concept`

- Conceptual card (`concept_key`, canonical + normalized name)
- Not exact-printing identity

### `tcg_printing`

- Exact printing: game, concept, set, collector number (text), language, variant
- Deterministic `canonical_printing_key`
- Optional rarity/finish/edition/promo + bounded JSON attributes

### `tcg_printing_identifier` / `tcg_identifier_conflict`

- External aliases (TCC catalog id, future TCGplayer/eBay ids) point at one printing
- Rebind attempts are recorded and rejected

### `tcg_market_source` / `tcg_market_ingest` / `tcg_market_snapshot` / `tcg_market_quarantine` / `tcg_market_revision`

Implemented in Phase 08 as platform-global tables (no tenant RLS). See [PHASE_08.md](../PHASE_08.md).

- Snapshots bind to exact `printing_id` only
- `price_type` distinguishes asking / sold / reference / bid
- Condition and grade are snapshot dimensions
- Unresolved records quarantine; snapshots are append-only

### `tcg_market_variants` / `tcg_graded_populations` / `tcg_slabbed_items`

- Census / inventory-item layers (not Phase 08)

### `tcg_holdings` (tenant RLS)

- printing, language, qty, cost basis, acquired_at — personalized intelligence only (later)

Do not store TCG market history on the concept. Do not merge language series by default. Do not put TCG fields on kernel `entity` / `observation` tables.

## Relationships

```text
tenants 1──* memberships *──1 profiles
tenants 1──* api_keys
tenants 1──* connectors
tenants 1──* source_events
tenants 1──* entities 1──* features
entities 1──* decision_records 1──* decision_actions
decision_records 1──* action_receipts
tenants 1──1 billing_customers
tenants 1──* subscriptions
tenants 1──* usage_events
crm_accounts 0..1──1 tenants
crm_accounts 1──* crm_contacts
crm_accounts 1──* crm_opportunities
entities 1──* observations 1──* signals
creators 1──* creator_calls 1──* creator_call_outcomes
tcg_card_concepts 1──* tcg_printings 1──* tcg_market_snapshots
```

## Indexes that must exist later

- `source_events (tenant_id, ingested_at desc)`
- `source_events (tenant_id, idempotency_key)` unique
- `entities (tenant_id, entity_type, external_id)` unique
- `decision_records (tenant_id, status, created_at desc)`
- `decision_records (tenant_id, subject_entity_id, created_at desc)`
- `features (tenant_id, entity_id, feature_key)` unique
- `job_runs (tenant_id, started_at desc)`
- `crm_accounts (tenant_id)` unique where not null

## What is intentionally absent

- Cloned TCG Card Central operational tables (scans, collections, marketplace)
- Production SQL
- Seed data for real tenants
- A single `cards.price` without language/printing
- A single `creators.authority` as the only score
