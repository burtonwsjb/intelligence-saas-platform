-- Forward-only privilege repair for Phase 24 tables created by 0022.
-- 0022 created provider_runtime and related tables as the migrator and did not
-- GRANT role privileges. Bootstrap GRANT ON ALL TABLES is not retroactive.
-- No table rewrites, no data deletes, no RLS or trigger weakening.

DO $$
BEGIN
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    "provider_runtime", "provider_sync_run", "platform_outbox",
    "source_sentiment", "intelligence_quarantine",
    "tcg_market_quarantine_review", "worker_heartbeat"
  TO app_migrate, app_admin;

  GRANT SELECT ON TABLE
    "provider_runtime", "provider_sync_run",
    "source_sentiment", "intelligence_quarantine",
    "tcg_market_quarantine_review", "worker_heartbeat"
  TO app_user, app_worker;

  GRANT SELECT ON TABLE "platform_outbox" TO app_worker;

  GRANT SELECT, INSERT, UPDATE ON TABLE
    "provider_runtime", "provider_sync_run", "platform_outbox",
    "intelligence_quarantine", "worker_heartbeat"
  TO app_worker;

  GRANT SELECT, INSERT ON TABLE
    "source_sentiment", "tcg_market_quarantine_review"
  TO app_worker;

  REVOKE INSERT, UPDATE, DELETE ON TABLE
    "provider_runtime", "provider_sync_run", "platform_outbox",
    "source_sentiment", "intelligence_quarantine",
    "tcg_market_quarantine_review", "worker_heartbeat"
  FROM app_user;

  REVOKE SELECT ON TABLE "platform_outbox" FROM app_user;

  REVOKE DELETE ON TABLE
    "provider_runtime", "provider_sync_run", "platform_outbox",
    "source_sentiment", "intelligence_quarantine",
    "tcg_market_quarantine_review", "worker_heartbeat"
  FROM app_worker;

  REVOKE UPDATE ON TABLE "source_sentiment", "tcg_market_quarantine_review" FROM app_worker;

  GRANT EXECUTE ON FUNCTION app.require_system_provider_write()
    TO app_migrate, app_admin, app_worker;
  GRANT EXECUTE ON FUNCTION app.list_pending_platform_outbox(integer)
    TO app_migrate, app_admin, app_worker;
  REVOKE EXECUTE ON FUNCTION app.list_pending_platform_outbox(integer) FROM app_user;
EXCEPTION
  WHEN undefined_object THEN
    NULL;
END;
$$;
