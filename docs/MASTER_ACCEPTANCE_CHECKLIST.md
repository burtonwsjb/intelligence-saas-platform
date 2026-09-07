# Master Acceptance Checklist: Social Signal IQ

Controlling documents: `PROJECT_SOURCE_OF_TRUTH.md`, `AGENTS.md`, and `MASTER_COMPLETION_PHASE.md` in this directory. This checklist is the evidence register for the single master completion phase, not a report that the product has passed.

## Status and evidence rules

`OPEN`: implementation/evidence incomplete or not reverified. `IN_PROGRESS`: actively being worked. `CODE_VERIFIED`: exact-revision automated evidence exists but required hosted validation is missing. `HOSTED_VERIFIED`: required deployed behavior is evidenced on the candidate. `OWNER_ACCEPTED`: required owner walkthrough is complete. `BLOCKED_EXTERNAL`: named external capability/permission/approval is missing. `NOT_YET_MATURE`: an outcome period has not elapsed and no legitimate historical equivalent is available. None of CODE_VERIFIED, BLOCKED_EXTERNAL, or NOT_YET_MATURE is a substitute for full completion.

Initial state is deliberately OPEN for the integrated final candidate. Prior verified work should be linked and reused, then rechecked for regressions; OPEN does not mean every feature is absent or must be rebuilt. Do not copy a prior agent's completion wording into a pass flag.

Every completed row requires an evidence record using this template:

```text
Requirement ID:
Status:
Implementation repository/files/commit:
Automated command and exact-revision run/artifact:
Hosted environment, deployment SHA, target fingerprint, checked-at time:
Observed result and expected result:
Safe evidence references or screenshot/video:
Scope/coverage/sample limits:
Open defects or external dependency:
Verifier and owner acceptance where required:
```

Do not include connection strings, API tokens, passwords, signed secret URLs, private customer payloads, or raw provider errors. For a fixture-only check, identify the fixture environment explicitly. Screenshots containing invented values are not real-provider evidence. Run IDs and database snapshots must identify the exact target, not just a branch nickname.

## A. All 18 source-of-truth definition-of-done gates

Wording below is taken from the controlling source-of-truth definition of done. The Evidence column operationalizes the requirement without narrowing it.

| ID | Requirement | Required evidence for final candidate | Initial status |
| --- | --- | --- | --- |
| SOT-01 | Hosted staging is healthy across web/API/worker/DB/Redis/email. | Actual deployment identities, fresh role-correct heartbeat, numeric queue metrics, classified active/historical failures, working web/API and email delivery. Historical-failure disposition is explicit and evidence-preserving, not silent deletion or threshold manipulation. | OPEN |
| SOT-02 | Automatic topic-based creator/source discovery works in staging. | Bounded real topic run, canonical accounts/content, relevance/provenance, exclusions, and a naturally due monitoring cycle. No manual account prerequisite. | OPEN |
| SOT-03 | YouTube discovers creators without manual channel IDs. | Search request/result record -> discovered channel -> later upload -> normalization/extraction, with quota accounting and error behavior. Preserve earlier evidence and reverify on candidate. | OPEN |
| SOT-04 | Reddit/social discovery follows the same principle. | Real topic-based community/post/account discovery and subsequent permitted monitoring, not one hardcoded subreddit. Missing access remains a named gate. | OPEN |
| SOT-05 | At least one real market provider is live in staging and validated. | TCC serving revision and SSI worker revision, authenticated cache hit, controlled miss resolved/cached by TCC, and normalized real observation. Merely having a token is insufficient. | OPEN |
| SOT-06 | Real data flows end-to-end through normalization, resolution, quarantine, creator intelligence, scoring, indices, and shadow predictions. | Trace IDs from genuine social and market records to every required downstream stage, plus independent checks of outcomes and as-of context. | OPEN |
| SOT-07 | Exact TCG identity survives real multi-source data. | Game/concept/set/text collector number/language/printing/condition/grade/provider IDs remain distinguishable. Cross-source contradictions are resolved or quarantined with evidence. | OPEN |
| SOT-08 | Outlier/currency/grade/language/variant protections work on real data. | Genuine varied observations plus isolated negative tests: no currency mixing, outlier headline contamination, language/grade substitution, or ambiguous-image/printing match. | OPEN |
| SOT-09 | Admin can operate provider/discovery/quarantine workflows. | Bounded run/pause/enable/exclude/review workflows on the deployed admin UI, server authorization, safe diagnostics, pagination and audited reasons. | OPEN |
| SOT-10 | Customer app shows real explainable intelligence. | Owner-reviewed Overview/Cards/detail/Markets/Creators/Watchlist, all displayed values traced to records, all UI gates below passed. | OPEN |
| SOT-11 | API/webhook flows work with real staged data. | Tenant-scoped API key issue/use/revoke, pagination/scopes/quotas, signed delivery with retry/idempotency/SSRF protection, and revoked/foreign-tenant denial. | OPEN |
| SOT-12 | Beta flow is completed end-to-end. | Test workspace onboarding, verified email, roles/invite, real-data browse/alert, feedback/support, test billing/entitlements and documented owner acceptance. | OPEN |
| SOT-13 | Production infrastructure, secrets, migrations, Stripe live, and provider credentials are separately configured and validated when authorized. | Explicit authorization reference, isolated production targets, backup/rollback, approved migration/deploy/config records, and no copied staging or vendor credentials. | OPEN |
| SOT-14 | Production smoke/security/load checks pass. | Exact deployed-revision results with disclosed load profile and safe non-destructive checks; repository smoke tests alone are insufficient. | OPEN |
| SOT-15 | Legal placeholders are resolved before public launch. | Approved final policy/legal content and applicable source/data-use permissions recorded by the appropriate owner/reviewer. An agent must not impersonate legal approval. | OPEN |
| SOT-16 | Predictions remain gated until evidence supports publication. | Server/API/UI negative tests for unentitled/unpublished access; shadow as-of issuance/backtests/calibration/sample sizes and explicit publication decision. | OPEN |
| SOT-17 | No required product behavior relies on fixture-only paths or manual workarounds. | Inventory of required paths with hosted real-data evidence, honest coverage disclosures, and no hardcoded creator IDs, copied prices, or fixture injection to appear complete. | OPEN |
| SOT-18 | The final system matches this source of truth, not merely the test suite. | Full row-by-row reconciliation of this register, resolved blocking defects, owner test record, production gates, and final release evidence. | OPEN |

## B. New owner UI requirements and measurable visual acceptance

These are additional implementation acceptance criteria arising from the owner's request for a clean, elegant, visual, simple card-and-sentiment product without ever-lengthening pages. They do not weaken section A.

| ID | Acceptance scenario | Pass condition | Initial status |
| --- | --- | --- | --- |
| UI-01 | First-use orientation | Five clear primary customer destinations; secondary account/developer tools grouped; separately authorized Admin. Users can distinguish Cards, market trends, creators and watchlist without knowing table/job names. | OPEN |
| UI-02 | Bounded Overview | At most four top indicators, eight featured cards, five attention items by default; no stacked usage/billing/full logs. Adding historical rows does not add overview sections or grow payload with the database. | OPEN |
| UI-03 | Visual card explorer | Default gallery uses correctly matched artwork/placeholder, exact identity, labeled price/currency/type, honest trend, opportunity ring, sentiment, quality/freshness and watch action. A compact table is optional, not the only experience. | OPEN |
| UI-04 | Quick reading and hierarchy | One primary score ring per tile, no wall of inline scores, visible risk/low-confidence qualifications, concise evidence-backed explanation. Advanced detail opens intentionally rather than becoming a giant card. | OPEN |
| UI-05 | Search/filter/sort correctness | Input search and typed common/advanced selectors work on the complete eligible server dataset, not just current-page rows. Language, variant, condition and grade never collapse. Invalid filters have safe actionable errors. | OPEN |
| UI-06 | Page growth and return context | Deterministic bounded pagination, default 24 and max 48, with filters/sort/view/tab/page in URL. Open/back/refresh restore context. No full-catalog browser download or default infinite append. | OPEN |
| UI-07 | Focused card workspace | Canonical identity header; Overview/Market/Sentiment/Creators/Evidence tabs; separate score displays and evidence drill-down. Existing card/opportunity deep links resolve without contradictory detail views. | OPEN |
| UI-08 | Score semantics | Opportunity/Risk/Confidence/Liquidity remain separate and versioned. Risk orientation is clear. No score is formatted as probability without that meaning. Missing values use No score/Insufficient evidence, not a filled zero ring. | OPEN |
| UI-09 | Sentiment meaning and sample | Distribution visual has bullish/neutral/bearish labels, eligible sample, unique creators, time window, freshness and weighted/unweighted basis. No sources is not neutral; duplicated posts are not independent votes. | OPEN |
| UI-10 | Genuine market visuals | Actual dated comparable history, quote type/currency labels, gaps/outliers and source context. No fake sparklines, invented percent change, sold/ask mixing, or reference-price-derived volume/liquidity. | OPEN |
| UI-11 | Creator and market-confirmation clarity | Reach/relevance/authority/impact are distinct; new creators have honest limited-history state. Bullish social sentiment does not automatically become a market-confirmed buy signal. | OPEN |
| UI-12 | Useful states | Loading, empty, filtered-empty, stale, partial, unsupported, error, locked and offline/dependency failure states tested in core screens. One failed widget does not blank the entire page. No production copy asks a customer to ingest local fixtures. | OPEN |
| UI-13 | Scalable operator views | Topics/Creators/Runs/Quarantine separated, paginated and searchable; job/audit details in focused panels. Safe diagnostics remain collapsed/admin-only. Bulk actions are bounded, permitted and audited. | OPEN |
| UI-14 | Responsive/accessibility acceptance | 360/390/768/1024/1440/1920px screenshots; keyboard flow, focus return, screen-reader labels, 200% zoom/reflow, contrast targets, touch target sizing, reduced motion. Color and hover are never the only communication. | OPEN |
| UI-15 | Performance and density | Fixed result payload/render count with 10,000+ cards and 100,000+ history rows in disposable scale data; no per-card N+1; disclosed p95/latency/LCP/CLS results against master targets. All deep histories load on demand. | OPEN |
| UI-16 | Owner elegance/readability review | Owner completes the consolidated flow and confirms the information hierarchy and visual presentation are clean and understandable; recorded blocking usability defects are fixed, not dismissed because automated tests pass. | OPEN |

## C. Cross-application integration, data completeness, and safety

| ID | Acceptance scenario | Pass condition | Initial status |
| --- | --- | --- | --- |
| DATA-01 | Serving targets and reviewed code | Both application revisions and actual serving environments match the release record; PR #5 is reconciled rather than silently assumed merged. Dedicated token stays server-only and does not activate live automatically. | OPEN |
| DATA-02 | Real cache hit | Same exact TCC cache observation returned through actual authenticated HTTP and ingested by SSI, with no extra upstream fetch. Request/observation/cache evidence corroborates this. | OPEN |
| DATA-03 | Controlled miss and repeated/concurrent reuse | Genuine exact miss invokes TCC's existing resolver once per shared refresh ownership; central cache persists; repeated/simultaneous requests reuse or report refresh_pending. No cache deletion just for testing and no SSI direct-vendor fallback. | OPEN |
| DATA-04 | Complete request deadline | Total budget includes auth, rate limit, slow/chunked body and catalog resolution. Timeouts stop new batch/pricing starts, including late catalog completions. In-flight shared refresh ownership is not falsely claimed cancelled. | OPEN |
| DATA-05 | Adversarial contract and money | Missing/wrong auth, unknown fields, oversized/chunked bodies, non-JSON, redirects, rate-limit Retry-After, invalid/future dates, invalid decimals, unsafe references, partial result correlation and no-secret leakage are exercised. Source precision is preserved. | OPEN |
| DATA-06 | Idempotent canonical handoff | Ingest plus normalize outbox is atomic; repeats do not duplicate/overwrite immutable observations; contradictions fail closed. Retry exhaustion is recorded without erasing Redis evidence. Pause state is honored before/after HTTP. | OPEN |
| DATA-07 | Public catalog and image coverage | Automatic relevant set/product/printing expansion and exact TCC IDs, permitted verified artwork and fallback. Not restricted forever to seeded printings; no tenant collection import or name-only guesses. | OPEN |
| DATA-08 | Required market and language coverage | Capability matrix covers source-of-truth sold/ask/reference/volume/supply/metrics, English/Japanese/Simplified Chinese and relevant condition/grade/variants. Missing external capabilities stay named open gates. Initial English/NM/raw/reference success is not full coverage. | OPEN |
| DATA-09 | Monitoring coverage and content interpretation | Topic discovery, scheduler fairness/catch-up and growing monitored creator coverage work within actual quotas. Track what content was analyzed; metadata-only analysis is labeled and not sold as complete video understanding. | OPEN |
| DATA-10 | Combined evidence and anti-hype behavior | Eligible source dedupe, exclusions, recency, relevance, spam/quality, contradiction and creator evaluation affect defined versioned sentiment/confidence/scoring. The UI reads that same snapshot rather than computing another score. | OPEN |
| DATA-11 | Call-time context and later evaluation | Immutable original claim and market-as-of context; no look-ahead or rewriting losing calls; sample-aware authority and category slices; pending/unresolved calls do not count as verified wins. | OPEN |
| DATA-12 | Complete forecasts without fabricated history | Required 7d/30d/90d/180d/365d software paths, authorized historical replay/backtests, calibration/sample reporting and unelapsed-outcome labels. No invented performance, no customer forecast leak. | OPEN |

## D. Consolidated execution and owner-session record

Internal checks are continuous. The owner performs a single consolidated acceptance session after engineering staging readiness, followed by focused retesting of repaired findings. Do not skip normal engineering tests to interpret 'then we can test it all' literally as no testing during implementation.

### Staging candidate manifest

```text
SSI release SHA:
TCC release SHA:
Web/API/worker deployed revisions:
TCC serving origin and revision:
Actual database-target fingerprints (no URLs/credentials):
Provider modes and supported capability summary:
Migration history verification and backup/rollback reference:
Data sample interval and production-like scale test profile:
Exact automated run links:
Hosted pipeline trace references:
Desktop/mobile/accessibility artifacts:
Historical-failure disposition:
Outstanding production-only approvals:
```

### Owner walkthrough

| Test | Task | Expected result |
| --- | --- | --- |
| OWNER-01 | Start on Overview | Quickly understand current attention and material changes without scrolling through full operational history. |
| OWNER-02 | Explore Cards | Recognize artwork/printing, search/filter/sort, change page and grid/table, open/back with state retained. |
| OWNER-03 | Understand one card | Explain price type, sentiment, opportunity, risk, confidence and liquidity; access supporting/contradicting evidence. |
| OWNER-04 | Investigate an influencer | Find source identity, monitored content, an original call and measured/pending outcome; do not mistake reach for accuracy. |
| OWNER-05 | Save and alert | Watch an exact printing and receive a permitted notification, with clear edit/disable behavior and no duplicates. |
| OWNER-06 | Review partial or stale coverage | See honest limitations and next action without zero-filled charts, false language/grade substitutions or crashed pages. |
| OWNER-07 | Use mobile and keyboard | Complete primary flow with readable cards, accessible navigation and no horizontal page overflow/endless histories. |
| OWNER-08 | Operate Admin | Discover by topic, inspect runs/creators, pause/exclude and review a quarantine/failure with visible audited feedback. |
| OWNER-09 | Complete SaaS/beta flow | Workspace/team, permissions, API/webhook, billing-test, privacy and feedback/support work through intended product controls. |

### Defect register

For each finding record: ID, linked requirement IDs, severity, exact revision/target, reproduction, expected vs actual, evidence, assigned work package, fix SHA, regression result, and owner retest if needed. Block staging handoff for security/data-integrity defects, broken required flows, and substantial navigation/readability problems. Do not relabel a defect as an external blocker when the code itself is wrong.

### Handoff versus final completion

'Engineering ready for owner testing' requires all applicable staging/data/UI checks to be HOSTED_VERIFIED or appropriately automated where exclusively a negative/scale test, and no required staging feature dependent solely on fixtures. UI-16 and the owner walkthrough then require actual owner feedback. Production gates stay visibly open until separately authorized and passed; a staging handoff is not a full-product completion statement.

Do not calculate a misleading overall percent from passing unit tests. A summary may report counts by evidence state and name the remaining critical gates. Finish with the verified release(s), observed outcomes, known coverage, explicit blockers, and the source-of-truth reconciliation, not merely 'CI green'.
