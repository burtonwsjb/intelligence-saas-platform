# Index review (Phase 21)

No blind indexes were added. Existing coverage already includes:

- market snapshots / history tables from Phases 08–13
- opportunity/score snapshots (Phase 14)
- creator history (Phase 11–12)
- webhook delivery due indexes (Phase 16)
- notifications (Phase 17)
- admin customer/org indexes (Phase 17/20)
- beta feedback/org indexes (Phase 22)

N+1: dashboard overview uses parallel queries (`Promise.all`) rather than per-row follow-up queries for the primary lists. Commercial list endpoints paginate. Revisit EXPLAIN on Neon after staging exists; do not tune against empty local data as if it were production.
