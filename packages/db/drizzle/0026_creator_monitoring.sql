-- Persist due times for automatic polling of discovered creators. No source list
-- or new credentials. Existing runtime role grants on discovered_creator apply.
ALTER TABLE discovered_creator ADD COLUMN IF NOT EXISTS last_monitor_attempt_at timestamptz;
ALTER TABLE discovered_creator ADD COLUMN IF NOT EXISTS last_monitor_success_at timestamptz;
ALTER TABLE discovered_creator ADD COLUMN IF NOT EXISTS next_monitor_at timestamptz;
ALTER TABLE discovered_creator ADD COLUMN IF NOT EXISTS monitor_error_class text;
CREATE INDEX IF NOT EXISTS discovered_creator_monitor_due_idx
  ON discovered_creator (provider_key, next_monitor_at)
  WHERE relevance_state = 'monitored';
