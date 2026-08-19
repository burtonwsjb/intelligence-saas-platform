import { describe, expect, it } from "vitest";
import { SourceContentRecord } from "./source-contracts.js";

describe("source intelligence Zod contracts", () => {
  it("requires provider, account, content URL, and bounds excerpts", () => {
    expect(
      SourceContentRecord.parse({
        provider: "youtube",
        provider_record_id: "yt_1",
        event_type: "source.content.ingested",
        account: { external_account_id: "ch_1" },
        content: {
          external_content_id: "vid_1",
          content_type: "video",
          published_at: "2026-01-01T00:00:00.000Z",
          canonical_url: "https://youtube.com/watch?v=vid_1",
          excerpt: "Greninja 214",
        },
      }).provider,
    ).toBe("youtube");
    expect(
      SourceContentRecord.safeParse({
        provider: "youtube",
        provider_record_id: "yt_1",
        event_type: "source.content.ingested",
        account: { external_account_id: "ch_1" },
        content: {
          external_content_id: "vid_1",
          content_type: "video",
          published_at: "2026-01-01T00:00:00.000Z",
          canonical_url: "https://youtube.com/watch?v=vid_1",
          excerpt: "x".repeat(501),
        },
      }).success,
    ).toBe(false);
  });
});
