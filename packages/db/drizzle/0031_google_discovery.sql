-- Google web search as a discovery source. Websites found for a topic become
-- creators (one per domain) through the same discovery, budget and
-- monitoring tables as YouTube and Reddit. The provider row starts disabled;
-- turning it on is an operator decision.
ALTER TABLE "discovery_topic" DROP CONSTRAINT IF EXISTS discovery_topic_provider_chk;
ALTER TABLE "discovery_topic" ADD CONSTRAINT discovery_topic_provider_chk
  CHECK ("provider_key" IN ('youtube', 'reddit', 'google'));
ALTER TABLE "discovery_run" DROP CONSTRAINT IF EXISTS discovery_run_provider_chk;
ALTER TABLE "discovery_run" ADD CONSTRAINT discovery_run_provider_chk
  CHECK ("provider_key" IN ('youtube', 'reddit', 'google'));
ALTER TABLE "discovered_creator" DROP CONSTRAINT IF EXISTS discovered_creator_provider_chk;
ALTER TABLE "discovered_creator" ADD CONSTRAINT discovered_creator_provider_chk
  CHECK ("provider_key" IN ('youtube', 'reddit', 'google'));
ALTER TABLE "discovery_request_budget" DROP CONSTRAINT IF EXISTS discovery_request_budget_provider_key_check;
ALTER TABLE "discovery_request_budget" ADD CONSTRAINT discovery_request_budget_provider_key_check
  CHECK ("provider_key" IN ('youtube', 'reddit', 'google'));
ALTER TABLE "discovery_creator_topic" DROP CONSTRAINT IF EXISTS discovery_creator_topic_provider_key_check;
ALTER TABLE "discovery_creator_topic" ADD CONSTRAINT discovery_creator_topic_provider_key_check
  CHECK ("provider_key" IN ('youtube', 'reddit', 'google'));

INSERT INTO "provider_runtime" ("provider_key", "provider_type", "mode", "schedule_seconds", "capabilities")
VALUES
  ('google', 'social', 'disabled', 3600, '{"supported_games":[],"supported_languages":["en"],"supported_regions":["US"],"supported_market_types":[],"supported_content_types":["article"]}'::jsonb)
ON CONFLICT ("provider_key") DO NOTHING;
