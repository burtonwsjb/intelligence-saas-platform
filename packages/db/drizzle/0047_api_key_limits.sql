-- Public API keys the platform operator issues from the admin console
-- (owner request 2026-11-20: "create an api that I can give access to users
-- ... and make api keys in admin").
--
-- api_key gains:
--   rate_limit_per_minute  requests per one-minute window for this key. NULL keeps
--                          today's behavior (only the shared 300/min per-IP
--                          guard), so existing keys such as TCG Card Central's
--                          are unchanged.
--   request_count          authenticated requests made with this key, bumped
--                          in the same UPDATE that already sets last_used_at.
--   note                   operator's note: who the key is for, plan, contact.
--   issued_by_operator     true when a platform operator issued it from
--                          /admin/api-keys rather than the workspace itself.
--
-- Run this before deploying the code that ships with it: the API reads and
-- writes these columns on every authenticated request.
-- Forward-only, idempotent: safe to run twice.
ALTER TABLE "api_key" ADD COLUMN IF NOT EXISTS "rate_limit_per_minute" integer;
ALTER TABLE "api_key" ADD COLUMN IF NOT EXISTS "request_count" bigint NOT NULL DEFAULT 0;
ALTER TABLE "api_key" ADD COLUMN IF NOT EXISTS "note" text;
ALTER TABLE "api_key" ADD COLUMN IF NOT EXISTS "issued_by_operator" boolean NOT NULL DEFAULT false;

ALTER TABLE "api_key" DROP CONSTRAINT IF EXISTS api_key_rate_limit_chk;
ALTER TABLE "api_key" ADD CONSTRAINT api_key_rate_limit_chk CHECK (
  "rate_limit_per_minute" IS NULL OR "rate_limit_per_minute" BETWEEN 1 AND 10000
);
ALTER TABLE "api_key" DROP CONSTRAINT IF EXISTS api_key_note_chk;
ALTER TABLE "api_key" ADD CONSTRAINT api_key_note_chk CHECK (
  "note" IS NULL OR char_length("note") <= 500
);
