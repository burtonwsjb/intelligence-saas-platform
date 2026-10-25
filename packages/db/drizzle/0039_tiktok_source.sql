-- TikTok as a source platform. Operators paste a creator's TikTok video links
-- on /admin/sources; the worker gets each video's transcript from the paid
-- transcript service (TRANSCRIPT_PROVIDER=supadata), which fetches the video
-- itself. Sentiment never downloads TikTok media. Forward-only, idempotent.
ALTER TABLE "source_platform" DROP CONSTRAINT IF EXISTS source_platform_type_chk;
ALTER TABLE "source_platform" ADD CONSTRAINT source_platform_type_chk CHECK (
  "source_type" IN ('youtube', 'reddit', 'web', 'rss', 'manual', 'tiktok')
);

INSERT INTO "source_platform" ("source_type", "display_name")
VALUES ('tiktok', 'TikTok')
ON CONFLICT ("source_type") DO NOTHING;
