# Source-of-truth acceptance record

PROJECT_SOURCE_OF_TRUTH.md remains authoritative and unchanged. This record is a
release checklist, not a replacement scope or a declaration that the product is
complete. CI results must be checked against the exact proposed commit.

## Repair release coverage

| Requirement | Implemented and regression-covered in this repair | Hosted acceptance still required |
| --- | --- | --- |
| Safe database upgrades | Transactional checksum history; no historical replay; read-only baseline detection; verified explicit adoption; ownership preflight; rollback; PostgreSQL 16/18 catalog compatibility | Inspect the actual staging schema with its existing authorized owner; back up; apply only the verified pending migrations |
| Topic-based creator discovery | YouTube and Reddit topic search; canonical identities; durable worker execution; no required channel IDs; operator states and exclusions | Real bounded YouTube run and authorized Reddit run |
| Continuous creator monitoring | Automatically discovered monitored channels/authors are polled on scheduled cycles; due claims; at most 10 recent records per poll; shared persistent budgets | Observe new content and later engagement snapshots through real scheduled worker cycles |
| Bounded dynamic topic generation | Generic topics plus bounded active catalog sets and recent score candidates; paused topics are not re-enabled | Verify live catalog-derived queries and operator relevance |
| Data quality and accountability | Repeated topic evidence is not inflated; first provenance and explicit operator decisions persist; observations do not rewrite canonical content/calls | Inspect live records, exclusions, and outcomes |
| Reliable ingestion handoff | Transactional downstream jobs; duplicate-retry recovery; safe BullMQ transport IDs; single-settlement shutdown | Verify hosted queue processing and normalizer/recompute results |
| Operator visibility | Recent discovery/monitoring runs, accepted counts, safe errors, last/next monitoring times, pending-schema state | Authenticated browser check after migration and coordinated deployment |
| Maintenance usability | Hidden existing-connection prompt; read-only plan; environment restoration; cross-platform PowerShell regression checks | One read-only preflight on the user's actual staging connection |

The automated checks use disposable databases and synthetic provider responses.
They do not constitute permission to call live providers, a vendor data-license
review, a hosted security audit, or evidence of profitable predictions.

## Full product acceptance gates

The numbered references below correspond to Definition of done in the source of
truth. No unchecked hosted gate is waived by a green repository test run.

- [ ] 1: Revalidate the deployed staging web, API, worker, database, Redis and email together.
- [ ] 2-4: Verify real automatic discovery and ongoing monitoring, without manual source lists.
- [ ] 5: Activate and validate at least one authorized real market-data provider.
- [ ] 6: Trace real source records through normalization, identity/quarantine, creator calls, features, scores, indices and shadow predictions.
- [ ] 7-8: Inspect exact language, printing/variant, grade, currency and outlier behavior on real multi-source records.
- [ ] 9-10: Complete authenticated admin and customer browser acceptance using real explainable intelligence.
- [ ] 11: Validate API scopes, usage, event delivery and webhook behavior on real staging data.
- [ ] 12: Complete the controlled beta tenant flow, including onboarding, team roles, billing test mode and notifications.
- [ ] 13-15: Obtain authorization and complete separate production infrastructure, billing, production validation and legal review.
- [ ] 16: Keep predictions shadow-gated until real outcome evidence supports publication. Automated shadow-gate tests are not a substitute for that evidence.
- [ ] 17-18: Finish a product-wide acceptance audit, not only a code scan or fixture test run.

Earlier completion reports are not accepted as verification of these gates.
The current repair does not certify all market adapters, privacy obligations,
notification delivery, billing, UI usability or scoring calibration as complete.
These existing subsystems must satisfy the owner-defined acceptance tests before
Social Signal IQ can be called complete.

## Deployment order

Use docs/REPAIR_RELEASE.md for read-only preflight and maintenance instructions.
Do not merge this release into an auto-deployed main branch before staging schema
readiness is verified. Do not manually replay historical migration files or
broaden runtime privileges to bypass a failed preflight. After a verified backup
and authorized migration, coordinate web, API and worker deployment, then conduct
a bounded live discovery run and record the evidence here.
