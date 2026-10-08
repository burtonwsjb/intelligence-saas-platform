-- Topics a workspace asks the platform to track (any subject, not only cards).
-- Each active topic becomes a global discovery query, run in the existing
-- rotation under the existing request budgets. The worker reads only the
-- distinct query text through a SECURITY DEFINER function, never which
-- workspace asked for it.
CREATE TABLE IF NOT EXISTS "tenant_topic" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "created_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "query" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_topic_status_chk CHECK ("status" IN ('active', 'paused')),
  CONSTRAINT tenant_topic_query_chk CHECK (length("query") BETWEEN 3 AND 120)
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_topic_query_uidx
  ON "tenant_topic" ("organization_id", lower("query"));
CREATE INDEX IF NOT EXISTS tenant_topic_active_idx
  ON "tenant_topic" (lower("query"))
  WHERE "status" = 'active';

SELECT app.install_tenant_owned_rls('tenant_topic', true);
DROP POLICY IF EXISTS tenant_topic_delete ON "tenant_topic";
CREATE POLICY tenant_topic_delete ON "tenant_topic"
  FOR DELETE
  USING (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  );

CREATE OR REPLACE FUNCTION app.list_tracked_topic_queries(p_limit integer)
RETURNS TABLE (query text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT min(t.query) AS query
  FROM "tenant_topic" t
  WHERE t.status = 'active'
  GROUP BY lower(t.query)
  ORDER BY min(t.created_at), lower(t.query)
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200));
$$;

REVOKE ALL ON FUNCTION app.list_tracked_topic_queries(integer) FROM PUBLIC;
DO $$
BEGIN
  GRANT EXECUTE ON FUNCTION app.list_tracked_topic_queries(integer) TO app_worker, app_migrate, app_admin;
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "tenant_topic" TO app_user;
EXCEPTION
  WHEN undefined_object THEN
    NULL;
END;
$$;
