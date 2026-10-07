-- Owner-controlled worker resource protection. The default hosted path drains
-- the existing Postgres outboxes in bounded America/Phoenix batches with zero
-- Redis commands. Metered Redis windows reserve 600 commands each against a
-- 12,000 daily and 400,000 monthly ceiling. Forward-only; no data rewrites.

CREATE TABLE IF NOT EXISTS "worker_resource_settings" (
  "id" text PRIMARY KEY DEFAULT 'global',
  "enabled" boolean NOT NULL DEFAULT true,
  "mode" text NOT NULL DEFAULT 'free_only',
  "interval_hours" integer NOT NULL DEFAULT 1,
  "max_jobs" integer NOT NULL DEFAULT 60,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  CONSTRAINT worker_resource_settings_singleton_chk CHECK ("id" = 'global'),
  CONSTRAINT worker_resource_settings_mode_chk CHECK ("mode" IN ('free_only', 'metered_redis')),
  CONSTRAINT worker_resource_settings_interval_chk CHECK ("interval_hours" IN (1, 2, 4)),
  CONSTRAINT worker_resource_settings_jobs_chk CHECK ("max_jobs" BETWEEN 1 AND 60)
);

INSERT INTO "worker_resource_settings" ("id") VALUES ('global') ON CONFLICT ("id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "scheduled_worker_run" (
  "id" text PRIMARY KEY,
  "slot" text NOT NULL,
  "mode" text NOT NULL,
  "status" text NOT NULL DEFAULT 'running',
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "deadline_at" timestamptz NOT NULL,
  "completed_at" timestamptz,
  "attempted" integer NOT NULL DEFAULT 0,
  "processed" integer NOT NULL DEFAULT 0,
  "failures" integer NOT NULL DEFAULT 0,
  "max_jobs" integer NOT NULL,
  "reserved_redis_commands" integer NOT NULL DEFAULT 0,
  "error_class" text,
  CONSTRAINT scheduled_worker_run_slot_uidx UNIQUE ("slot"),
  CONSTRAINT scheduled_worker_run_mode_chk CHECK ("mode" IN ('free_only', 'metered_redis')),
  CONSTRAINT scheduled_worker_run_status_chk CHECK (
    "status" IN ('running', 'completed', 'failed', 'indeterminate')
  ),
  CONSTRAINT scheduled_worker_run_reserve_chk CHECK ("reserved_redis_commands" IN (0, 600))
);

CREATE INDEX IF NOT EXISTS scheduled_worker_run_open_idx
  ON "scheduled_worker_run" ("status") WHERE "status" IN ('running', 'indeterminate');
CREATE INDEX IF NOT EXISTS scheduled_worker_run_started_idx
  ON "scheduled_worker_run" ("started_at");

CREATE TABLE IF NOT EXISTS "scheduled_job_claim" (
  "kind" text NOT NULL,
  "job_id" text NOT NULL,
  "run_id" text NOT NULL REFERENCES "scheduled_worker_run"("id"),
  "organization_id" text,
  "state" text NOT NULL DEFAULT 'running',
  "attempt" integer NOT NULL DEFAULT 1,
  "error_class" text,
  "claimed_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("kind", "job_id"),
  CONSTRAINT scheduled_job_claim_kind_chk CHECK ("kind" IN ('platform', 'tenant')),
  CONSTRAINT scheduled_job_claim_state_chk CHECK (
    "state" IN ('running', 'processed', 'retry', 'failed', 'indeterminate')
  )
);

CREATE INDEX IF NOT EXISTS scheduled_job_claim_run_idx ON "scheduled_job_claim" ("run_id");

-- Pure Phoenix wall-clock rule shared with @isp/shared scheduledSlot():
-- quiet hours 02:00-06:00, five-minute admission, intervals anchored at 06:00.
CREATE OR REPLACE FUNCTION app.scheduled_slot(p_at timestamptz, p_interval_hours integer)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  local_ts timestamp := p_at AT TIME ZONE 'America/Phoenix';
  h integer := extract(hour FROM local_ts)::integer;
  m integer := extract(minute FROM local_ts)::integer;
BEGIN
  IF p_interval_hours IS NULL OR p_interval_hours NOT IN (1, 2, 4) THEN
    RETURN NULL;
  END IF;
  IF (h >= 2 AND h < 6) OR m >= 5 OR ((h + 18) % 24) % p_interval_hours <> 0 THEN
    RETURN NULL;
  END IF;
  RETURN to_char(date_trunc('hour', local_ts), 'YYYY-MM-DD"T"HH24":00-07:00"');
END;
$$;

-- True when one more 600-command metered window fits the Phoenix-day 12,000
-- and Phoenix-month 400,000 free-tier ceilings.
CREATE OR REPLACE FUNCTION app.metered_redis_budget_allows(p_at timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT
    coalesce(sum(r.reserved_redis_commands) FILTER (WHERE r.started_at >=
      (date_trunc('day', p_at AT TIME ZONE 'America/Phoenix') AT TIME ZONE 'America/Phoenix')), 0) + 600 <= 12000
    AND coalesce(sum(r.reserved_redis_commands), 0) + 600 <= 400000
  FROM public.scheduled_worker_run r
  WHERE r.started_at >= (date_trunc('month', p_at AT TIME ZONE 'America/Phoenix') AT TIME ZONE 'America/Phoenix')
    AND r.started_at <= p_at;
$$;

-- Admits at most one batch per Phoenix slot and never while an earlier batch is
-- running or awaiting owner review. The time is always the server's now().
CREATE OR REPLACE FUNCTION app.claim_scheduled_run()
RETURNS SETOF public.scheduled_worker_run
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  s public.worker_resource_settings;
  v_slot text;
  reserve integer;
  admitted public.scheduled_worker_run;
BEGIN
  SELECT * INTO s FROM public.worker_resource_settings WHERE id = 'global' FOR UPDATE;
  IF NOT FOUND OR NOT s.enabled THEN
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.scheduled_worker_run WHERE status IN ('running', 'indeterminate')) THEN
    RETURN;
  END IF;
  v_slot := app.scheduled_slot(now(), s.interval_hours);
  IF v_slot IS NULL THEN
    RETURN;
  END IF;
  reserve := CASE WHEN s.mode = 'metered_redis' THEN 600 ELSE 0 END;
  IF reserve > 0 AND NOT app.metered_redis_budget_allows(now()) THEN
    RETURN;
  END IF;
  INSERT INTO public.scheduled_worker_run (id, slot, mode, deadline_at, max_jobs, reserved_redis_commands)
  VALUES (gen_random_uuid()::text, v_slot, s.mode, now() + interval '180 seconds', s.max_jobs, reserve)
  ON CONFLICT (slot) DO NOTHING
  RETURNING * INTO admitted;
  IF admitted.id IS NULL THEN
    RETURN;
  END IF;
  RETURN NEXT admitted;
END;
$$;

-- Claims the oldest due job across both outboxes. A job that was processed,
-- failed or left indeterminate is never claimed again; only 'retry' re-enters.
CREATE OR REPLACE FUNCTION app.claim_scheduled_job(p_run_id text)
RETURNS TABLE (kind text, job_id text, organization_id text, payload jsonb, attempt integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_column
DECLARE
  r public.scheduled_worker_run;
  p_id text;
  p_payload jsonb;
  p_at timestamptz;
  t_id text;
  t_org text;
  t_payload jsonb;
  t_at timestamptz;
  v_attempt integer;
BEGIN
  SELECT * INTO r FROM public.scheduled_worker_run WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND OR r.status <> 'running' OR r.mode <> 'free_only'
    OR r.deadline_at <= now() OR r.attempted >= r.max_jobs THEN
    RETURN;
  END IF;
  SELECT o.id, o.payload, o.available_at INTO p_id, p_payload, p_at
  FROM public.platform_outbox o
  WHERE o.status = 'pending' AND o.available_at <= now()
    AND NOT EXISTS (
      SELECT 1 FROM public.scheduled_job_claim c
      WHERE c.kind = 'platform' AND c.job_id = o.id AND c.state <> 'retry')
  ORDER BY o.available_at, o.id
  LIMIT 1
  FOR UPDATE OF o SKIP LOCKED;
  SELECT j.id, j.organization_id, j.payload, j.available_at INTO t_id, t_org, t_payload, t_at
  FROM public.outbox_job j
  WHERE j.status = 'pending' AND j.available_at <= now()
    AND NOT EXISTS (
      SELECT 1 FROM public.scheduled_job_claim c
      WHERE c.kind = 'tenant' AND c.job_id = j.id AND c.state <> 'retry')
  ORDER BY j.available_at, j.id
  LIMIT 1
  FOR UPDATE OF j SKIP LOCKED;
  IF p_id IS NULL AND t_id IS NULL THEN
    RETURN;
  END IF;
  IF t_id IS NULL OR (p_id IS NOT NULL AND p_at <= t_at) THEN
    kind := 'platform';
    job_id := p_id;
    organization_id := NULL;
    payload := p_payload;
  ELSE
    kind := 'tenant';
    job_id := t_id;
    organization_id := t_org;
    payload := t_payload;
  END IF;
  INSERT INTO public.scheduled_job_claim AS c (kind, job_id, run_id, organization_id, state, attempt)
  VALUES (kind, job_id, p_run_id, organization_id, 'running', 1)
  ON CONFLICT ON CONSTRAINT scheduled_job_claim_pkey DO UPDATE
    SET run_id = EXCLUDED.run_id, state = 'running', attempt = c.attempt + 1,
        error_class = NULL, updated_at = now()
    WHERE c.state = 'retry'
  RETURNING c.attempt INTO v_attempt;
  IF v_attempt IS NULL THEN
    RETURN;
  END IF;
  attempt := v_attempt;
  UPDATE public.scheduled_worker_run SET attempted = attempted + 1 WHERE id = p_run_id;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION app.finish_scheduled_job(
  p_run_id text, p_kind text, p_job_id text, p_state text, p_error_class text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  safe_error text := left(p_error_class, 80);
BEGIN
  IF p_state NOT IN ('processed', 'retry', 'failed', 'indeterminate') THEN
    RAISE EXCEPTION 'invalid_scheduled_job_state';
  END IF;
  UPDATE public.scheduled_job_claim
  SET state = p_state, error_class = safe_error, updated_at = now()
  WHERE kind = p_kind AND job_id = p_job_id AND run_id = p_run_id AND state = 'running';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'scheduled_claim_missing';
  END IF;
  UPDATE public.scheduled_worker_run
  SET processed = processed + CASE WHEN p_state = 'processed' THEN 1 ELSE 0 END,
      failures = failures + CASE WHEN p_state = 'processed' THEN 0 ELSE 1 END
  WHERE id = p_run_id;
  IF p_kind = 'tenant' THEN
    IF p_state = 'processed' THEN
      UPDATE public.outbox_job SET status = 'published', published_at = now(), last_error = NULL
      WHERE id = p_job_id AND status = 'pending';
    ELSIF p_state = 'failed' THEN
      UPDATE public.outbox_job SET status = 'failed', attempts = attempts + 1, last_error = safe_error
      WHERE id = p_job_id AND status = 'pending';
    ELSIF p_state = 'retry' THEN
      UPDATE public.outbox_job
      SET attempts = attempts + 1, last_error = safe_error, available_at = now() + interval '15 minutes'
      WHERE id = p_job_id AND status = 'pending';
    END IF;
  ELSE
    IF p_state = 'processed' THEN
      UPDATE public.platform_outbox SET status = 'processed', completed_at = now()
      WHERE id = p_job_id AND status IN ('pending', 'processing');
    ELSIF p_state = 'failed' THEN
      UPDATE public.platform_outbox
      SET status = 'failed', failed_at = now(), attempts = attempts + 1, last_error = safe_error
      WHERE id = p_job_id AND status IN ('pending', 'processing');
    ELSIF p_state = 'retry' THEN
      UPDATE public.platform_outbox
      SET status = 'pending', attempts = attempts + 1, last_error = safe_error,
          available_at = now() + interval '15 minutes'
      WHERE id = p_job_id AND status IN ('pending', 'processing');
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION app.finish_scheduled_run(p_run_id text, p_status text, p_error_class text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_status NOT IN ('completed', 'failed', 'indeterminate') THEN
    RAISE EXCEPTION 'invalid_scheduled_run_status';
  END IF;
  UPDATE public.scheduled_worker_run
  SET status = p_status, error_class = left(p_error_class, 80), completed_at = now()
  WHERE id = p_run_id AND status = 'running';
END;
$$;

-- Redis dispatch must not replay a job the scheduled path already handled or
-- left unresolved. Same signatures, so existing grants are kept.
CREATE OR REPLACE FUNCTION app.list_pending_outbox(p_limit integer)
RETURNS TABLE (
  id text,
  organization_id text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
    p_limit := 20;
  END IF;
  RETURN QUERY
    SELECT j.id, j.organization_id
    FROM public.outbox_job AS j
    WHERE j.status = 'pending'
      AND j.available_at <= now()
      AND NOT EXISTS (
        SELECT 1 FROM public.scheduled_job_claim c
        WHERE c.kind = 'tenant' AND c.job_id = j.id AND c.state <> 'retry')
    ORDER BY j.created_at
    LIMIT p_limit;
END;
$$;

CREATE OR REPLACE FUNCTION app.list_pending_platform_outbox(p_limit integer)
RETURNS TABLE (id text, job_type text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o.id, o.job_type
  FROM "platform_outbox" o
  WHERE o.status = 'pending'
    AND o.available_at <= now()
    AND NOT EXISTS (
      SELECT 1 FROM "scheduled_job_claim" c
      WHERE c.kind = 'platform' AND c.job_id = o.id AND c.state <> 'retry')
  ORDER BY o.available_at
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 20), 100));
$$;

REVOKE ALL ON FUNCTION app.scheduled_slot(timestamptz, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.metered_redis_budget_allows(timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.claim_scheduled_run() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.claim_scheduled_job(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.finish_scheduled_job(text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.finish_scheduled_run(text, text, text) FROM PUBLIC;

DO $$
BEGIN
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    "worker_resource_settings", "scheduled_worker_run", "scheduled_job_claim"
  TO app_migrate, app_admin;

  GRANT SELECT ON TABLE
    "worker_resource_settings", "scheduled_worker_run", "scheduled_job_claim"
  TO app_worker;

  REVOKE INSERT, UPDATE, DELETE ON TABLE
    "worker_resource_settings", "scheduled_worker_run", "scheduled_job_claim"
  FROM app_worker;

  REVOKE ALL ON TABLE
    "worker_resource_settings", "scheduled_worker_run", "scheduled_job_claim"
  FROM app_user;

  GRANT EXECUTE ON FUNCTION
    app.claim_scheduled_run(),
    app.claim_scheduled_job(text),
    app.finish_scheduled_job(text, text, text, text, text),
    app.finish_scheduled_run(text, text, text)
  TO app_worker, app_migrate, app_admin;
EXCEPTION
  WHEN undefined_object THEN
    NULL;
END;
$$;
