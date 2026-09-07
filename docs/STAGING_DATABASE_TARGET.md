# Bind maintenance inspection to the deployed database target

PROJECT_SOURCE_OF_TRUTH.md remains controlling. This document does not authorize
hosted writes, provider requests, retries, deletion, or switching runtime URLs.

## Observed incident

The owner supplied a successful 0023 baseline adoption, application of 0024-0026,
and an empty post-migration plan. Later, the deployed web diagnostic at 079adc9
reported the admin and app targets were equal, but the actual admin connection
had no migration ledger and none of the five discovery tables, in public or
another application schema. Public was in the search path. Catalog queries
succeeded. SELECT=false accompanied absence, not proof of a permission defect.

The successful maintenance result therefore does not establish migration of the
currently serving database. A different maintenance branch/database, a changed
runtime target, or a later database restore must be distinguished using evidence.
The prior migration output did not include a target fingerprint, so it cannot
establish which branch received the changes. Do not assume the backup was used.

## Corrected operator inspection

The existing read-only preflight now accepts -ExpectedTarget with the adminTarget
fingerprint from the deployed Discovery diagnostics. Before running pnpm or
opening a database connection, a local Node-only guard compares the maintenance
URL's normalized endpoint, port, and database against that fingerprint.

```powershell
.\scripts\staging-repair-preflight.ps1 -IncludeNeonSample -ExpectedTarget '<adminTarget from deployed diagnostics>'
```

Use an authorized owner URL for that deployed target. The hidden URL is not
passed as a process argument, logged, saved to a file, or committed. Both changed
environment variables are restored on success and failure. A mismatch prints
only fingerprints and a fixed error class, then refuses database access.
A match continues with the existing database-enforced read-only baseline plan.
It does not apply migrations or change any service configuration.

The fingerprint contract matches apps/web/lib/discovery-runtime.ts: SHA-256 of
JSON [normalized hostname, effective port, decoded database path], truncated to
16 hex characters. On Neon, only the pooler marker is normalized. Different
roles/passwords and TLS parameters do not change the target. URL query parameters
that can override routing are refused. Distinct read replicas can share a branch
but have different fingerprints; obtain the owner URL for the same compute, not
an arbitrary replica. A matching fingerprint establishes the configured target,
not proof of current database contents, a verified backup, or migration success.

If the old maintenance URL mismatches, do not move the application to that target
just to make Discovery appear fixed. Resolve the correct branch using the host
of the existing deployed DATABASE_ADMIN_URL, keeping passwords private, and use
its owner connection. Inspect the matching target before proposing a backed-up,
authorized migration. Leave the current app, admin, worker URLs and permissions
unchanged until evidence supports a specific change.

## Verification

Node tests cover direct/pooled equivalence, role independence, different branch,
port and database rejection, runtime-contract golden values, malformed inputs,
routing overrides, secret-safe CLI output, and unknown-argument refusal.
The Windows PowerShell 5.1 and PowerShell 7 workflow also runs the real local guard
with a fixture URL and mocked pnpm, proving target mismatch never starts the
migration runner and restores environment state. No database is contacted by
these script tests. Provider HTTP and queue contents are not involved.

The 47 retained BullMQ failures remain a separate unresolved runtime gate. A
single old database outbox failure does not explain all retained Redis failures.
Do not clear failures or change health thresholds to hide them.
