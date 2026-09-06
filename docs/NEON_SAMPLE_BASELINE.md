# Explicitly preserving the Neon tutorial table during legacy verification

PROJECT_SOURCE_OF_TRUTH.md remains controlling. No hosted changes or deployment
are authorized by this document.

## Identified staging mismatch

The owner's catalog.v2 diagnostic contains seven unexpected entries and no
missing or changed entries against 0023. Every reported identifier fingerprint
matches the documented Neon example table and its associated objects:

| Fingerprint | Identifier |
| --- | --- |
| 6bda0830a227 | public.playing_with_neon |
| 9a0a8f21ee1a | public.playing_with_neon_id_seq |
| 78b9bacf6632 | public.playing_with_neon.id |
| 0b28015a2aec | public.playing_with_neon.name |
| 6b369cbeb60b | public.playing_with_neon.value |
| 4b7f5948771f | public.playing_with_neon.playing_with_neon_pkey (constraint and index) |

The fingerprint identifies the object, not its definition or contents. The
profile therefore still verifies its complete catalog structure before accepting
an exact application baseline. Source of the independent example definition:
https://neon.com/blog/announcing-point-in-time-restore

## Read-only operator command

On the repair branch, after pulling the verified revision:

```powershell
.\scripts\staging-repair-preflight.ps1 -IncludeNeonSample
```

Use the same existing authorized staging schema-owner URL at the hidden prompt.
The script passes only `--plan --detect-baseline --include-neon-sample` to the
canonical runner. PostgreSQL enforces a read-only transaction. No sample rows,
application rows, migration ledger, credentials or privileges are modified.

## How verification works

Without the explicit flag, the strict default remains unchanged. With it, the
checker constructs the documented sample table ONLY in its isolated in-memory
reference, alongside the repository migrations. It compares every existing
catalog group against this reference. This is not a name-based ignore list.

The extra check verifies that the sample has its original serial sequence,
owned by its id column, with the documented integer range and sequence settings.
The live sequence counter and all sample rows are never read by the checker.
Missing sample fields, changed types/defaults/nullability, altered constraints,
RLS flags, unowned or changed sequences, other unexpected objects and application
schema drift still fail. A same-named table alone is not sufficient.

A successful plan explicitly reports
`preservedExternalProfiles: ["neon_sample.v1"]`, an exact `baselineCandidate`,
no `adopted` or `applied` files, and the genuinely pending application migrations.
The sample is not part of application migration history and is never recreated,
deleted, moved or rewritten on the target. Its values and sequence remain intact.

## Release gate stays closed

After an exact verified plan, a separately authorized, backed-up legacy adoption
may use the same `--include-neon-sample` profile with the existing paired
`--baseline-through` and `--confirm-existing-schema` arguments. The baseline is
reverified inside that transaction. It cannot be inferred from a nearest match.
The profile flag by itself never authorizes writes. Existing migration ledgers
cannot be re-baselined with this option.

Do not merge or deploy schema-dependent code until the staging migration sequence
has been authorized and validated. Real provider, customer, beta and production
acceptance still require evidence under the owner's source of truth.
