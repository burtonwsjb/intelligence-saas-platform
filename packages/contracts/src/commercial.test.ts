import { describe, expect, it } from "vitest";
import { COMMERCIAL_METER_KEYS, WEBHOOK_EVENT_TYPES } from "./commercial.js";

describe("commercial contracts", () => {
  it("lists supported webhook events without prediction.created while shadow", () => {
    expect(WEBHOOK_EVENT_TYPES).toContain("opportunity.changed");
    expect(WEBHOOK_EVENT_TYPES).not.toContain("prediction.created");
    expect(COMMERCIAL_METER_KEYS).toContain("opportunity.read");
  });
});
