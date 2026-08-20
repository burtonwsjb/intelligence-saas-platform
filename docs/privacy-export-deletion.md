# Account export and deletion (architecture)

Not a completed legal program. No extra legal claims.

Export (future): tenant-owned rows (users in org, keys metadata not secrets, usage, webhooks endpoints without plaintext secrets, feedback). Exclude other tenants and global TCG reference data.

Deletion (future): disable tenant; tombstone PII in CRM; keep audit/break-glass; keep global market/printings/predictions accountability. Platform admin grants for that user are removed.

Until implemented, operators handle requests manually with this boundary.
