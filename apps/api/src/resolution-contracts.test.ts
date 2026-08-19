import { describe, expect, it } from "vitest";
import { EntityResolutionRequest, EntityResolutionReview } from "./resolution-contracts.js";

describe("entity resolution Zod contracts", () => {
  it("accepts resolver.v1 signals and rejects unknown statuses", () => {
    expect(
      EntityResolutionRequest.parse({
        subject_type: "manual",
        subject_id: "m1",
        signals: { game: "pokemon", language: "ja", collector_number: "214/167" },
      }).signals.language,
    ).toBe("ja");
    expect(
      EntityResolutionRequest.safeParse({
        subject_type: "manual",
        subject_id: "m1",
        signals: {},
        resolver_version: "resolver.v0",
      }).success,
    ).toBe(false);
    expect(EntityResolutionReview.parse({ action: "mark_unresolved" }).action).toBe("mark_unresolved");
  });
});
