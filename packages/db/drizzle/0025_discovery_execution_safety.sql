-- Discovery execution counters and distinct topic evidence. Forward-only.
CREATE TABLE IF NOT EXISTS discovery_request_budget (
  provider_key text NOT NULL CHECK (provider_key IN ('youtube','reddit')),
  bucket text NOT NULL CHECK (bucket IN ('search','data')),
  budget_day date NOT NULL,
  requests_used integer NOT NULL DEFAULT 0 CHECK (requests_used >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_key, bucket, budget_day)
);
CREATE TABLE IF NOT EXISTS discovery_creator_topic (
  creator_id text NOT NULL REFERENCES creator(id),
  provider_key text NOT NULL CHECK (provider_key IN ('youtube','reddit')),
  topic_key text NOT NULL CHECK (char_length(topic_key) BETWEEN 3 AND 120),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (creator_id, provider_key, topic_key)
);
ALTER TABLE discovered_creator ALTER COLUMN reach_views TYPE bigint;
ALTER TABLE discovered_creator ALTER COLUMN reach_subscribers TYPE bigint;
CREATE INDEX IF NOT EXISTS discovered_creator_creator_idx ON discovered_creator(creator_id);
CREATE INDEX IF NOT EXISTS discovery_run_started_idx ON discovery_run(started_at DESC);
-- Roles may not exist on a freshly initialized disposable database; the normal
-- bootstrap repeats these grants after role creation. Never swallow other errors.
DO $$ DECLARE role_name text; BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('app_admin','app_migrate','app_worker') LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON discovery_request_budget, discovery_creator_topic TO %I', role_name);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='app_user') THEN
    REVOKE ALL ON discovery_request_budget, discovery_creator_topic FROM app_user;
  END IF;
END $$;
