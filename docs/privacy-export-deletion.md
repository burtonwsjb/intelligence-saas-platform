# Account export and deletion

Export (implemented): tenant-owned members, API key metadata (never secrets), and webhook destinations. Global TCG reference data is excluded.

Deletion (implemented as disable): tenant status is set to disabled; API keys are revoked; webhooks are disabled. Audit and global market/printings stay. Platform admin grants for that user are a separate operator action.

Legal program and counsel review remain future work. No extra legal claims.
