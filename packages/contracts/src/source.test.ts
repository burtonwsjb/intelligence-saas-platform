import { describe, expect, it } from "vitest";
import {
  MAX_SOURCE_EXCERPT_CHARS,
  SourceContractError,
  boundSourceExcerpt,
  isSourceType,
  parseSourceContentRecord,
} from "./source.js";
import { isGenericEventType } from "./kernel.js";

describe("source intelligence contracts", () => {
  it("keeps pack event types out of the generic registry and bounds excerpts", () => {
    expect(isSourceType("youtube")).toBe(true);
    expect(isSourceType("reddit")).toBe(true);
    expect(isGenericEventType("source.content.ingested")).toBe(false);
    expect(boundSourceExcerpt("ok")).toBe("ok");
    expect(() => boundSourceExcerpt("x".repeat(MAX_SOURCE_EXCERPT_CHARS + 1))).toThrow(
      SourceContractError,
    );
    expect(
      parseSourceContentRecord({
        provider: "youtube",
        provider_record_id: "yt_1",
        event_type: "source.content.ingested",
        account: { external_account_id: "ch_1", handle: "alpha" },
        content: {
          external_content_id: "vid_1",
          content_type: "video",
          published_at: "2026-01-01T00:00:00.000Z",
          canonical_url: "https://youtube.com/watch?v=vid_1",
          language: "en",
          excerpt: "Greninja 214 looks interesting.",
        },
      }).provider,
    ).toBe("youtube");
  });
});
