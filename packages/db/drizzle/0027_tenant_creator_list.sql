-- Workspace-private influencer list. A workspace can follow or hide a known
-- creator, or ask to follow a YouTube channel / Reddit user by handle. Follows
-- never feed authority, trust or global exclusion; hiding only filters this
-- workspace's views. The worker resolves handle requests and starts monitoring
-- through SECURITY DEFINER functions, so it never gains general tenant reads.
CREATE TABLE IF NOT EXISTS "tenant_creator_list" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "created_by_user_id" text REFERENCES "user"("id") ON DELETE SET NULL,
  "platform" text NOT NULL,
  "input_handle" text,
  "external_account_id" text,
  "creator_id" text REFERENCES "creator"("id"),
  "preference" text NOT NULL DEFAULT 'follow',
  "status" text NOT NULL DEFAULT 'pending',
  "error_class" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_creator_list_platform_chk CHECK ("platform" IN ('youtube', 'reddit')),
  CONSTRAINT tenant_creator_list_preference_chk CHECK ("preference" IN ('follow', 'hide')),
  CONSTRAINT tenant_creator_list_status_chk CHECK ("status" IN ('pending', 'resolved', 'not_found', 'blocked', 'failed')),
  CONSTRAINT tenant_creator_list_handle_chk CHECK (
    "input_handle" IS NULL OR (length("input_handle") BETWEEN 1 AND 200)
  ),
  CONSTRAINT tenant_creator_list_target_chk CHECK ("creator_id" IS NOT NULL OR "input_handle" IS NOT NULL),
  CONSTRAINT tenant_creator_list_resolved_chk CHECK ("status" <> 'resolved' OR "creator_id" IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_creator_list_creator_uidx
  ON "tenant_creator_list" ("organization_id", "creator_id")
  WHERE "creator_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tenant_creator_list_handle_uidx
  ON "tenant_creator_list" ("organization_id", "platform", lower("input_handle"))
  WHERE "input_handle" IS NOT NULL;
CREATE INDEX IF NOT EXISTS tenant_creator_list_pending_idx
  ON "tenant_creator_list" ("platform", "created_at")
  WHERE "status" = 'pending';
CREATE INDEX IF NOT EXISTS tenant_creator_list_follow_idx
  ON "tenant_creator_list" ("creator_id")
  WHERE "preference" = 'follow' AND "status" = 'resolved';

SELECT app.install_tenant_owned_rls('tenant_creator_list', true);
DROP POLICY IF EXISTS tenant_creator_list_delete ON "tenant_creator_list";
CREATE POLICY tenant_creator_list_delete ON "tenant_creator_list"
  FOR DELETE
  USING (
    "organization_id" = app.current_organization_id()
    AND app.is_authorized_principal()
  );

-- Pending handle requests for one platform, oldest first. Returns only what the
-- worker needs to resolve the handle; no other tenant data is exposed.
CREATE OR REPLACE FUNCTION app.list_pending_creator_follows(p_platform text, p_limit integer)
RETURNS TABLE (id text, input_handle text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT l.id, l.input_handle
  FROM "tenant_creator_list" l
  WHERE l.status = 'pending'
    AND l.platform = p_platform
    AND l.input_handle IS NOT NULL
  ORDER BY l.created_at, l.id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 5), 20));
$$;

-- Records the worker's resolution of one pending request. Only pending rows
-- change, and a resolved row must name a creator.
CREATE OR REPLACE FUNCTION app.complete_creator_follow(
  p_id text, p_status text, p_creator_id text, p_external_account_id text, p_error_class text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  changed integer;
BEGIN
  IF p_status NOT IN ('resolved', 'not_found', 'blocked', 'failed') THEN
    RAISE EXCEPTION 'invalid creator follow status %', p_status;
  END IF;
  IF p_status = 'resolved' AND p_creator_id IS NULL THEN
    RAISE EXCEPTION 'resolved creator follow needs a creator';
  END IF;
  UPDATE "tenant_creator_list" l
  SET status = p_status,
      creator_id = CASE WHEN p_status = 'resolved' THEN p_creator_id ELSE l.creator_id END,
      external_account_id = COALESCE(p_external_account_id, l.external_account_id),
      error_class = CASE WHEN p_status = 'resolved' THEN NULL ELSE left(p_error_class, 80) END,
      updated_at = now()
  WHERE l.id = p_id
    AND l.status = 'pending'
    -- A workspace that already lists this creator keeps its existing row.
    AND NOT (
      p_status = 'resolved' AND EXISTS (
        SELECT 1 FROM "tenant_creator_list" o
        WHERE o.organization_id = l.organization_id AND o.creator_id = p_creator_id AND o.id <> l.id
      )
    );
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed = 0 AND p_status = 'resolved' THEN
    DELETE FROM "tenant_creator_list" l
    WHERE l.id = p_id AND l.status = 'pending'
      AND EXISTS (
        SELECT 1 FROM "tenant_creator_list" o
        WHERE o.organization_id = l.organization_id AND o.creator_id = p_creator_id AND o.id <> l.id
      );
    GET DIAGNOSTICS changed = ROW_COUNT;
  END IF;
  RETURN changed > 0;
END;
$$;

-- Creators at least one workspace follows. Monitoring uses this to keep them
-- polled; it never reads which workspace follows whom.
CREATE OR REPLACE FUNCTION app.list_followed_creator_ids(p_limit integer)
RETURNS TABLE (creator_id text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT l.creator_id
  FROM "tenant_creator_list" l
  WHERE l.preference = 'follow' AND l.status = 'resolved' AND l.creator_id IS NOT NULL
  ORDER BY l.creator_id
  LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 200), 1000));
$$;

REVOKE ALL ON FUNCTION app.list_pending_creator_follows(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.complete_creator_follow(text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.list_followed_creator_ids(integer) FROM PUBLIC;
DO $$
BEGIN
  GRANT EXECUTE ON FUNCTION app.list_pending_creator_follows(text, integer) TO app_worker, app_migrate, app_admin;
  GRANT EXECUTE ON FUNCTION app.complete_creator_follow(text, text, text, text, text) TO app_worker, app_migrate, app_admin;
  GRANT EXECUTE ON FUNCTION app.list_followed_creator_ids(integer) TO app_worker, app_migrate, app_admin;
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "tenant_creator_list" TO app_user;
  GRANT SELECT ON TABLE "tenant_creator_list" TO app_worker;
EXCEPTION
  WHEN undefined_object THEN
    NULL;
END;
$$;
