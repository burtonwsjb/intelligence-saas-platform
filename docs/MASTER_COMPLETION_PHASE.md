# Master Completion Phase: Social Signal IQ

Status: execution plan created; implementation and acceptance are not declared complete.

## 1. Authority, outcome, and release boundary

`PROJECT_SOURCE_OF_TRUTH.md` remains authoritative. Read it and `AGENTS.md` in full before acting. This master phase consolidates the remaining implementation, repairs, visual redesign, integration, and verification into one product-completion milestone. It does not replace the source of truth or remove requirements that are inconvenient to implement.

The owner has explicitly added these product requirements: the current UI is confusing, pages must not become increasingly long as data accumulates, cards and sentiment must be easy to explore visually, and the experience must be elegant, clean, simple, and Apple-like in restraint while remaining data-driven with visuals, circular score displays, and readable explanations. This is a product redesign, not a color change on the existing lists. Specific screen sizes, component choices, and limits below are implementation acceptance targets, not claims that the owner supplied those exact numbers.

The owner's prior market-data direction also remains binding: Social Signal IQ (SSI) obtains market data from TCG Card Central (TCC), reads TCC's existing shared cache first, and asks TCC to resolve a miss through its existing providers and save centrally. SSI must not introduce a competing upstream cache, direct vendor fallback, shared database, shared user authentication, or shared billing with TCC.

Deliver one coherent, real-data staging release for the owner's consolidated acceptance session. Engineers run automated and internal hosted tests throughout implementation; the owner is not the regression-test operator for each small change. Small reviewed commits and dependent PRs are allowed within this one phase. A single milestone does not mean one risky giant commit or deferring all tests until the end.

Separate three truthful states:

1. **Engineering complete for staging review:** all staging implementation and internal acceptance checks pass on the same release; no known blocking functional, security, data-integrity, or usability defect remains.
2. **Owner acceptance complete:** the owner completes the consolidated product walkthrough; findings are repaired and affected/full checks rerun.
3. **Full source-of-truth completion:** all 18 definition-of-done items, including separately authorized production and legal gates, have evidence. Neither a polished UI nor an enabled API implies this state.

This planning document does not authorize a production release, live Stripe charges, purchases, bulk historical retries, credential resets, or additional provider activation. Follow the existing owner authorization and release controls for each hosted write.

## 2. Inspected baseline and known gaps

Planning inspection: SSI main `d7f4a29b42004e831ec11b240e226b88d5e02360`; TCC consumer draft PR #5 at `fe7a44467000956a2f069b18881d3893388441c6`. GitHub reported CI run 34084416463 and compatibility run 34084416458 successful for that PR head. PR #5 was still draft and unmerged. These checks do not establish a live TCC connection.

The following UI facts are supported by the inspected files, not a new signed-in browser audit:

- `apps/web/app/app/page.tsx` stacks Top opportunities, Risk alerts, Recent creator calls, Market movers / indices, Watch items, Usage, and Account notices. Several items repeat across sections.
- `apps/web/app/app/cards/page.tsx` presents a text list of printing identities, rather than image-led cards with sentiment.
- `apps/web/app/app/opportunities/page.tsx` uses a table and seven text-input filters. Neither inspected list page renders pagination controls.
- `apps/web/components/PrintingWorkspaceView.tsx` stacks market, opportunity, market features, creator calls, and predictions. Its scores are primarily inline numbers; it has an existing Sparkline and expandable technical details to reuse where appropriate.
- `apps/web/components/AppNav.tsx` maps the visible links without grouping. `apps/web/app/globals.css` supplies a basic shell, tables, forms, and sparkline styles, not the visual system specified here.

The owner previously confirmed that Discovery displays results. Prior session reports described real YouTube discovery/monitoring and retained historical queue failures. Preserve those records, but reverify live status for the final candidate rather than turning previous statements into current pass flags. The source-of-truth file's historical Current verified state paragraph is not a current runtime audit.

The initial TCC integration targets a narrow reference-price surface. It must not be counted as complete sold-history, volume, graded, Japanese, or Simplified Chinese coverage. Verify the peer's actual code and deployed behavior. Code existence, provider credentials, simulated tests, and live evidence are different things.

## 3. Product structure: one clear place for each task

Use five primary customer destinations. Keep advanced account functions secondary and Admin separately authorized. The route mappings below are the intended consolidation; preserve existing links, scopes, and entitlements when migrating.

| Destination | Purpose | Route direction |
| --- | --- | --- |
| Overview | A short daily briefing: what changed, why it matters, and what needs attention | Existing `/app` |
| Cards | Default visual card explorer, search, filters, saved views, and opportunity presets | Existing `/app/cards`; consolidate `/app/opportunities` as a preset/compatible entry |
| Markets | Market trends, signal feed, set/product views, and indices | Existing `/app/markets` and `/app/indices` under one navigation group |
| Creators | Discover who is talking, their relevance, reach, actual track record, calls, and disagreement | Existing `/app/creators` and detail routes |
| Watchlist | Saved exact printings and alerts with a compact summary | Reuse existing watch/alert models; simplify `/app/alerts` presentation without silently changing its semantics |

Settings contains workspace/team, billing, usage, notifications, privacy, and support. Developer tools contain API keys, scopes, usage, and webhooks. Neither group becomes a permanent wall of dashboard sections. Admin contains Operations, Discovery, Providers, Data quality, Customers, and configuration. Existing admin capabilities remain reachable and protected on the server.

Use a persistent desktop side navigation, compact header with scoped search, and a mobile navigation that does not require horizontally scrolling through every account/admin link. Show the current workspace and environment without exposing internal connection values. Do not show role-restricted controls and then fail after click; enforce permissions both in navigation and on direct requests.

## 4. Visual system and bounded page design

Create a shared design system in the existing Next.js application. Do not rebuild SSI as another Lovable project or move its auth/database to TCC.

Visual direction: light neutral surfaces, near-black typography, generous but purposeful whitespace, a restrained accent, subtle borders/shadows, consistent spacing, and restrained motion. Use existing or appropriately licensed system typography rather than downloading proprietary Apple fonts. This is a quality benchmark, not an Apple-branded clone. Card artwork is the visual focus. Use a coherent type scale and design tokens for spacing, radii, colors, chart treatments, focus, elevation, and density. Default is light; respect an existing theme preference if one exists. Do not add an unsolicited theme project at the expense of required workflows.

A reusable minimum component set: `CardIntelligenceTile`, `ScoreRing`, `SentimentSummary`, `PriceTrendChart`, `EvidenceDrawer`, `QualityBadge`, `FilterBar`, `ResultPager`, `CompactStat`, `CreatorTile`, and state/skeleton components. Names are implementation proposals; reuse equivalent components rather than making duplicates.

### Overview

A concise briefing, not a dump of every database table. Default: one summary row with no more than four indicators, one featured-card region capped at eight cards, and one compact updates/attention region capped at five entries. Each region has a clear View all destination. Billing/usage/notices move to their relevant destinations or a discreet notice control. A market-wide label is only valid for a market-wide aggregation; a top-five sample must not be presented as all-market sentiment or risk.

The overview's component count and height must remain effectively bounded as the database grows. Target no more than roughly two viewport heights at 1440 x 900 with the default density. At small screens or enlarged text, permit necessary vertical scrolling rather than shrinking type, clipping content, or trapping scrolling. Do not interpret this as an absolute no-scroll requirement.

### Cards: the core customer screen

Default to a responsive image-led gallery, with a compact table toggle for advanced comparison. The list is useful for unscored catalog cards as well as scored opportunities. Do not hide the catalog merely because no score exists yet.

Each card tile has a deliberate reading order:

1. Verified artwork with consistent aspect ratio, exact name, set, collector number, language, and printing/variant badge. Artwork and alt text must correspond to the exact printing; use an honest placeholder when missing, not a similar card's image.
2. Current price with explicit currency and quote type, a selected-window change when supported by comparable observations, and a restrained sparkline only when genuine history exists.
3. One primary Opportunity ring, a plain-language sentiment label, a freshness/quality state, and a short Why it is moving sentence supported by evidence. Keep Risk visible as a warning when material.
4. A clear open-details action and an accessible watch/save action. Do not create invalid nested interactive elements or require hover to understand the tile.

Do not cram four large rings, three charts, and every raw metric into every grid tile. Full Risk, Confidence, and Liquidity breakdowns belong in quick view and the detail overview. The compact table can expose sortable columns for those metrics. Any high-opportunity/low-confidence or bullish/unconfirmed combination must remain visibly qualified in the tile.

The sticky filter bar has search plus a few common selectors. Expand advanced filters intentionally, rather than exposing seven blank technical fields. Include game, set, language, printing/variant, condition/grade context, price range, sentiment, opportunity, risk, confidence, liquidity, freshness, and time window where data permits. The backend validates bounds and applies filtering/sorting before pagination. Search by card, set, collector number, and exact identifiers; ambiguous results stay distinct.

Provide curated view presets such as All cards, Opportunities, Market-confirmed, Social attention, and Caution, but only where the underlying predicate is defined and supported. Do not call attention alone an opportunity. Preserve search, filters, sort, selected tab, pagination position, and view mode in URL state. Returning from a card restores context. Prefer cursor/keyset pagination for growing data, with deterministic tie-breaks and accessible next/previous controls; default page size 24, selectable 12/24/48, server-enforced maximum 48 for this view. Mobile may present fewer columns, not smaller unreadable cards. No endless default append-only scrolling.

### Card detail

One canonical exact-printing detail page, reachable from Cards, opportunities, watchlist, market events, and creator evidence. Reuse current card/opportunity loaders and prevent conflicting duplicate screens.

A compact identity/price header remains context. Below it use Overview, Market, Sentiment, Creators, and Evidence tabs with URL-addressable state. Fetch and paginate heavier inactive panels on demand. The overview shows Opportunity, Risk, Confidence, and Liquidity as four separate labeled score displays, plus the recommendation, market-confirmation state, concise positive/negative drivers, and data freshness. Open source records in an evidence drawer or focused panel. Forecasts appear only under the existing entitlement and publication gates; do not expose shadow forecasts through a redesigned component or raw API payload.

### Creators, Markets, Watchlist, and Admin

Creator tiles show identity/avatar, domain relevance, reach, evaluated-call count, authority where a meaningful sample exists, latest material call, and monitoring state. Creator detail separates track record, calls, activity, and methodology. A large following cannot be relabeled as authority.

Markets uses bounded signal cards and comparable time-series/index views, not a long concatenation of all discoveries. Distinguish market events from claims about events; surface source attribution and uncertainty. Watchlist uses the same card model, not a second set of score calculations. Both require pagination, actionable empty states, and persistent filters.

Admin Discovery becomes separate tabs for Topics, Creators, Runs, and Quarantine/attention, with server-side pagination, search, status filters, and row/detail panels. Queue failures and audits are compact summaries with drill-down. Diagnostics stay collapsed and admin-only. Missing tables, denied permissions, disabled providers, stale workers, and retained historical failures need distinct messages and distinct remedies. Preserve evidence rather than deleting failures just to turn a health badge green.

## 5. What the scores and sentiment visuals actually mean

All numbers come from versioned, server-side, auditable calculations over canonical records. Do not hardcode demo scores, randomly generate charts, calculate a competing score in the browser, or use API fetch time as market observation time. Design fixtures may exist only in isolated test/component environments and must not enter hosted acceptance data.

| Visual | Meaning and guardrail |
| --- | --- |
| Opportunity ring | Existing versioned opportunity score on its documented scale. A score of 82/100 is not an 82% chance of profit. |
| Risk display | Existing risk score. Higher means more risk; never color it as a positive outcome solely because the number is larger. |
| Confidence display | Evidence sufficiency/reliability under its defined methodology, not a made-up probability. |
| Liquidity display | Actual market liquidity evidence. Reference price alone is insufficient for a confident liquidity score. |
| Sentiment distribution donut | Clearly defined bullish/neutral/bearish proportions among eligible, deduplicated, resolved content for the selected period. Show denominator, unique creators, time range, and weighted/unweighted basis. Do not label weighted shares as raw counts. |
| Price/history chart | Comparable exact-identity observations, explicit currency and quote type, timestamps, selected range, and visible gaps. Do not connect sold and ask prices as a single undifferentiated series. |
| Market confirmation | A separate state: confirmed, mixed, unconfirmed, or insufficient evidence, based on defined market evidence. It is not another name for positive sentiment. |

Sentiment must account for content quality, source identity, recency, relevance, duplication, and creator disagreement through the canonical pipeline. Reuse and audit the existing weighting/versioning; define any needed change in code and tests, not a front-end magic formula. Insufficient evaluated history must not grant a new creator high authority. A claim shared across channels is not independent corroboration. Exclusions, spam controls, uncertain identity, outliers, and missing sources affect confidence explicitly. Preserve positive, negative, and contradictory evidence in the detail view; a concise tile summary must not hide material risk.

Missing is not zero. An empty ring says No score or Insufficient evidence; no data is not neutral sentiment or 0% bullish. Stale is not fresh. Unsupported language/grade is not an English/NM substitute. A limited source mix must be labeled so that 'based on everything' means all available, eligible evidence, not a claim to see every conversation on the internet.

## 6. Unified implementation work packages

These are ordered work packages inside one master phase, not repeated owner handoffs.

### MP-A: baseline, contract, and evidence setup

Read current refs, reconcile open PR #5, inspect the active TCC repository and serving environments, and record release SHAs and database-target fingerprints without secrets. Inventory all source-of-truth requirements against code and live evidence. Use `MASTER_ACCEPTANCE_CHECKLIST.md`; statuses start unverified unless an actual supporting record is attached. Reconcile stale docs without weakening the owner-controlled source of truth. Add the owner's UI direction and prior cache-first clarification to the authoritative change history during reviewed integration.

Audit each proposed tile/panel field back to its repository, API DTO, permission boundary, and underlying evidence. Build a source-to-display map for price, sentiment, opportunity, risk, confidence, liquidity, images, calls, and freshness. Any missing field becomes an explicit backend task, not fabricated UI data.

### MP-B: complete and validate the TCC gateway

Finish peer/client contract review, code repairs, and cross-repository contract tests before activation. Resolve the confirmed deadline gap: auth/rate-limiter/body-reading time belongs inside the total request budget; no late catalog continuation may start new pricing work after timeout. Bound body bytes, response bytes, batch size, network and database time, and concurrency. Preserve decimal amounts, original observation dates, safe source references, source attribution, exact identifiers, and secret-safe errors.

Use a dedicated server-to-server credential, never a database, user, or upstream vendor key. Confirm the deployed route is reachable with service authentication alone and does not rely on an end-user session. Preserve shared-cache ownership, quota controls, retry backoff, pause/exclusion behavior, atomic ingestion/outbox handoff, idempotency, and contradictory-observation handling. Confirm server config against the actual deployed targets before writing or deploying. No blind migration replay or runtime permission expansion.

With authorization, provision the dedicated token securely, deploy reviewed revisions, and enable only TCC in staging. Validate cache hit, controlled exact miss, repeated/concurrent reuse, stale fallback, no-data, unsupported dimensions, rate limiting, timeout, and downstream normalization using real observations. Do not erase valid cache entries just to manufacture a miss. Track both repositories' revisions and request evidence.

### MP-C: complete identity, market coverage, and automatic intelligence

Connect public catalog discovery/resolution to real TCC identifiers so the system does not depend forever on a small seeded catalog. The initial gateway sweep does not import the entire TCC catalog; implement the missing bounded canonical lookup/expansion path where needed, including new sets/products and relevant exact printings. Ambiguous creator mentions remain unpriced until resolved. Never copy tenant collections as a substitute for a public catalog.

Complete the source-of-truth market dimensions through the authorized TCC gateway: sold prices, asks/listings, reference prices, volume/velocity, supply, seller counts, spreads, volatility, momentum, liquidity, supply absorption, relative strength, source disagreement, freshness/outliers, and population where available. Keep clear capability records for each upstream source. An unavailable external capability is a named open gate, not a reason to synthesize it or reduce the scope.

Preserve first-class English, Japanese, and Simplified Chinese identity and exact variant/condition/grade dimensions. Extend the currently narrow pricing contract/resolver where necessary rather than treating unsupported as full coverage. Test real cross-source conflicts, text collector numbers, currencies, grades, and image identity. Respect applicable source permissions; do not create a second direct-vendor path in SSI to bypass a TCC integration gap.

Verify YouTube discovery and recurring creator monitoring, complete topic-based Reddit/community/account discovery without mandatory seed IDs, and audit how actual content feeds sentiment and structured claims. Titles/descriptions alone must not be described as a full video-channel review. Where deeper permitted content is unavailable, expose coverage and confidence limitations. Add bounded backfill/catch-up and scheduling coverage appropriate to the number of monitored creators; one successful poll does not demonstrate reliable monitoring of a growing creator list.

Verify source -> normalization -> exact resolution/quarantine -> structured call with call-time market context -> later outcome -> category/sample-aware creator authority -> features -> scores -> indices -> shadow predictions. Support all required 7d/30d/90d/180d/365d horizons with immutable as-of evidence and no look-ahead. Use genuine authorized historical data for retrospective validation where available; otherwise label not-yet-mature outcomes pending. Never fabricate a year of performance or require a year of idle waiting to test the software mechanics.

### MP-D: implement the visual product, not a disconnected mockup

Create the design tokens and real-data summary DTOs, then replace the shell, Overview, Cards, canonical detail, Creators, Markets, Watchlist, and Admin Discovery surfaces described above. Keep existing auth, entitlements, API/scoring repositories, RLS, and feature gates. Create preview fixtures only for visual edge-case tests; real acceptance uses the deployed canonical pipeline.

Add exact-image metadata through the existing catalog contracts when missing, with provenance, permitted host handling, aspect-preserving rendering, accessible fallback, lazy loading, and size reservation. Avoid third-party scraping or generic stock-card art. Secure remote image fetching rather than making a generic URL fetch proxy.

Implement accessible tabs/dialogs, persistent filters and pagination, genuine keyboard operation, and complete empty/loading/stale/partial/error/locked states. Replace developer-facing fixture and environment-variable instructions in customer screens with clear product language. Keep technical details available where useful without making them the primary experience. Compare old and new routes so no required workflow is lost during navigation cleanup.

### MP-E: complete operational and commercial workflows

Audit and verify provider health, scheduler coverage, failure/retry handling, notifications, email, tenant isolation, platform-admin separation, RBAC, API scopes/rate limits, usage metering, entitlements, workspace/team, Stripe test lifecycle, webhooks, CRM/support, privacy export/disable, audit logs, and beta flow. Reuse current code; do not rebuild already verified capabilities unnecessarily.

For historical failures, preserve the retained job evidence and record disposition separately. Repair/replay only where safe and authorized, with idempotency checks. Distinguish fresh active failures, old acknowledged failures, and dependency incidents in operator views. Do not silently redefine health thresholds to pass acceptance. Resolve the staging-health definition-of-done item explicitly.

### MP-F: internal QA, repairs, and consolidated owner testing

Run component, contract, unit, integration, isolation, visual, accessibility, performance, and hosted end-to-end checks while building. Use two independent tenant accounts, admin and restricted roles, real staged market/social data, and deterministic isolated malformed/outlier test cases. Keep synthetic security/load fixtures out of public product scores and provider acceptance claims.

Only call the consolidated owner session ready after staging gates in the checklist pass on one release and no required customer workflow is blocked by the current implementation. Prepare a short test guide, known supported coverage, release URLs/SHAs, health snapshot, rollback reference, and evidence links. Repair findings from owner testing, rerun affected checks and the full suite, and preserve the same acceptance checklist rather than declaring another unrelated phase.

### MP-G: authorized production and final closure

Prepare production runbooks and rollback plans during the phase. Separately obtain or verify authorization for actual production infrastructure/secrets, migrations, provider activation, Stripe live, and launch. Complete legal placeholders and operational ownership before public release. Then verify production smoke, security, and load acceptance without destructive tests or real charges unless explicitly approved. Keep forecasts shadow-gated until measured evidence supports publication. Mark full source-of-truth completion only after the final 18-item reconciliation.

## 7. Internal quality gates and execution sequence

Critical path: MP-A -> peer/client correctness in MP-B -> bounded hosted market verification -> complete MP-C data paths -> final real-data MP-D binding -> MP-E/MP-F acceptance -> MP-G when authorized. Design-system/layout work in MP-D and unaffected MP-C/MP-E tests can proceed while a service credential or provider approval is pending. Do not stop all useful work because one integration is blocked.

Current repository verification commands, read from root `package.json`:

```text
pnpm typecheck
pnpm lint
pnpm test
pnpm test:isolation
pnpm test:integration
pnpm build
pnpm test:load-smoke
pnpm test:security-scan
git diff --check
```

These commands alone are not browser, complete security, hosted load, or source-of-truth acceptance. Add browser/visual/accessibility test wiring where absent; record actual commands and artifacts rather than claiming nonexistent suites ran. Run TCC's actual current verification scripts on its pinned peer revision. Use disposable databases for integration tests and target-verified, authorized operations for hosted changes.

Test responsive layouts at 360, 390, 768, 1024, 1440, and 1920 CSS-pixel widths, keyboard-only interaction, screen-reader semantics, 200% text zoom/reflow, and reduced motion. Target minimum 44px primary touch controls, at least 4.5:1 normal-text contrast and 3:1 essential graphical/large-text contrast, with no color-only interpretation. These are project acceptance targets; passing them is not a blanket accessibility certification.

Set reproducible performance budgets before optimization: bounded 24-card default response, no per-card N+1 query pattern, no hidden full-catalog download, and no unbounded admin histories. In a disclosed production-like warm environment, target p95 list API <= 1 second over a documented bounded run, page LCP <= 2.5 seconds and CLS <= 0.1 under the agreed mobile profile. Record profile, sample count, cold/warm state, network, failure rate, and actual result; do not present laboratory thresholds as measured field performance. Verify 10,000+ catalog records and 100,000+ historical evidence records in a disposable scale fixture with page size fixed. The database may grow; the rendered page payload must not grow with it.

## 8. Owner acceptance session

The owner tests the finished staging candidate, not intermediate migration fixes. Walkthrough:

1. Open Overview and identify what changed without searching through admin logs.
2. Open Cards, search an exact printing, filter by language/time window/sentiment, sort, switch grid/table, and navigate to another page of results.
3. Open a card, explain the price type and opportunity/risk/confidence/liquidity, inspect sentiment and its evidence/sample/window, and distinguish social hype from market confirmation.
4. Open a cited creator, inspect actual claims, evaluated outcomes, uncertainty, and monitoring state; return to the same card/list position.
5. Save a card, configure a permitted alert, and verify the Watchlist and notification workflow without duplicating subscriptions.
6. Inspect a genuine stale/partial/unsupported example: it must be honest and readable, not blank, crashing, or silently substituted.
7. Repeat the principal workflow on mobile and keyboard. Confirm no endlessly lengthening discovery/history page.
8. As admin, run a bounded discovery, review a run/failure/quarantine, apply a permitted pause/exclusion, and see the resulting state. As a non-admin, verify those operations cannot be accessed.
9. Complete workspace/invite/role, API/webhook, billing-test, privacy/support, and beta scenarios through their intended product screens.

Record usability findings as defects with severity and reproduction steps. Aesthetic acceptance belongs to the owner; an automated screenshot alone does not prove the experience feels elegant or understandable.

## 9. Evidence, blockers, and completion rules

Use `MASTER_ACCEPTANCE_CHECKLIST.md` for all final gates. Each record needs requirement ID, implementing file/commit, automated result, hosted evidence/time/target, UI evidence where relevant, defects/blockers, and verifier. Reference immutable SHAs, not just mutable branch names. A code-passing row with no required live evidence remains open.

Track external dependencies precisely: missing credential vs missing provider capability vs authorization restriction vs data-history maturity. State the exact affected acceptance IDs and finish unaffected work. Do not ask the owner to repeat an already verified password/migration step. Do not put tokens, connection strings, signed URLs, tenant payloads, or customer data in the evidence file.

UI completion requires the new screens, real fields, pagination, chart semantics, state coverage, accessibility, and owner readability review. Backend completion requires real data and auditable outcomes. Production/legal gates remain part of full completion even when not yet authorized. Retain missing-data states and shadow gates without representing an unsupported feature as complete.

During an active execution session, show concrete progress with files, test results, and the next dependency at useful intervals, approximately once a minute for long work. Never imply work continues between chat turns unless an actual external job was started and its status is reported accurately. Resume from the recorded checklist and last verified commit, not another speculative troubleshooting loop.

## 10. Start-of-execution instruction

Execute this single master phase against the current authoritative source of truth and the owner's cache-first/UI clarifications. First inspect current refs and open changes; preserve concurrent work. Implement and test the real-data gateway, complete intelligence coverage, and the bounded visual product. Update the acceptance checklist with evidence as each requirement is verified. Use small safe commits and one integrated staging candidate. Do not hand unfinished regression work to the owner, do not erase failures or weaken security to get green badges, and do not claim completion from tests alone. Stop only for owner direction or a genuine named access/approval restriction after completing unaffected work. No deployment, secret change, migration, paid-provider activation, or production billing action is implied merely by this instruction; honor the actual authorization boundary.
