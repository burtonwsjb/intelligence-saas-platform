# TCG Card Central cache-first gateway

PROJECT_SOURCE_OF_TRUTH.md controls this integration. Owner clarification: Social Signal IQ (SSI) consumes TCG Card Central (TCC)'s shared market cache, and TCC alone resolves cache misses through its existing providers. This is not a second upstream pricing system and does not connect the two applications' databases, authentication or billing.

## Interface

The SSI worker calls POST `/api/integrations/social-signal-iq/market` on the configured TCC origin. It sends `Authorization: Bearer <dedicated integration token>`, not a vendor key or user login. Contract version is `tcc.market.v1`. Maximum batch: ten exact printing identities; maximum request body: 16 KiB; maximum response: 128 KiB; one request with a 20-second deadline, no redirect following and no direct vendor fallback.

Request fields per item: request_id, game_key, language_code, card_name, set_name, collector_number (string), variant_key, condition, grading_company, grade_label, tcc_card_id. The last three are nullable. The enclosing object contains version and requests. Cache-bypass flags are forbidden.

TCC returns version, generated_at and results. Each result has request_id, status, identity, quote, cache and error_class. Status is available, not_found, refresh_pending, unavailable, unsupported or identity_mismatch. A quote contains decimal-string price, USD currency, reference price_type, reference_price market_type, observed_at, tcg_card_central source_key, upstream_source and source_reference. Cache metadata contains hit, stale, price_date and fetched_at. Missing results have null quotes, never an invented zero.

SSI validates the complete batch before ingestion: known unique request IDs, exact game/set/number/language/variant/condition/grade, external ID when supplied, major-unit money, nonfuture timestamps and original cache dates. A reference quote maps to the existing internal market_price/reference category, never a sale or invented volume. Cached observations keep their original timestamp. Staleness is recomputed locally in addition to the peer flag. Repeated delivery uses the same observation ID; a changed price at that identity/time fails closed without overwriting the original.

## Existing pipeline

The live TCC branch of syncProvider uses syncTccCachedMarket. It acquires the existing provider lease, selects at most ten active public canonical printings, then closes that database transaction before HTTP. A second transaction rechecks provider pause/enable state and invokes receiveTcgMarketRecord, which already persists the normalized-input record and durable normalize job together. There is no parallel price store or job queue.

The initial automatic sweep requests NM, ungraded, USD reference quotes for each selected printing. This is an explicit quote policy, not a guess about any user's collection condition. Language and variant come from the printing. Unsupported dimensions remain visible in the run's checkpoint counts and do not become fabricated matches. Exact fresh daily observations already stored in the intelligence history are not requested again. A keyset cursor rotates past unavailable identities; TCC remains responsible for its shared cache, per-card miss backoff and upstream quotas.

The gateway does not import TCC's entire catalog or create new printings from name-only influencer mentions. Existing catalog/resolution/quarantine protections remain required. The initial API does not imply sold-history, liquidity, authority-outcome or forecast validation.

## Activation gates

Code readiness is not live integration acceptance. TCC's existing project must implement and test the matching server route around resolveTcgplayerMarketUsd and the existing shared daily-cache lease. No new cache or database migration is needed on SSI's side.

Server configuration, only when authorized:
- TCC: SSI_MARKET_API_TOKEN, a dedicated strong integration credential of at least 32 characters.
- SSI worker: TCC_API_TOKEN with that same integration credential; TCC_API_BASE_URL containing only the TCC HTTPS origin; PROVIDER_TCG_CARD_CENTRAL_MODE=live only after route and secret provisioning are verified.

These are new service-integration settings, not database/user password resets and not copies of upstream vendor credentials. Do not expose tokens in chat, git, browser code, URLs or logs. Other provider modes remain unchanged. Production must not target the temporary preview origin.

Stage acceptance requires a real cache hit with no upstream fetch, a controlled exact cache miss resolved by TCC, concurrent and repeated requests sharing TCC's cached observation, proper stale/missing/unsupported responses, canonical normalization, and subsequent scoring without fabricated sold data. Record both project revisions and actual supported dimensions. Do not assert live completion until this evidence exists.
