-- Additive Better Auth 1.7 account.issuer + organization.updated_at.
-- Safe on empty and previously applied 0001 databases.

ALTER TABLE "account" ADD COLUMN IF NOT EXISTS "issuer" text;
UPDATE "account" SET "issuer" = "provider_id" WHERE "issuer" IS NULL;
ALTER TABLE "account" ALTER COLUMN "issuer" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS account_issuer_account_id_uidx
  ON "account" ("issuer", "account_id");

ALTER TABLE "organization" ADD COLUMN IF NOT EXISTS "updated_at" timestamptz;
