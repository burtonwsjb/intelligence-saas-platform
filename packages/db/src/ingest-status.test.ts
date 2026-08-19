import { describe, expect, it } from "vitest";
import { canTransitionSourceEvent } from "./ingest-status.js";

describe("source event status transitions", () => {
  it("allows only the documented transitions", () => {
    expect(canTransitionSourceEvent("received", "queued")).toBe(true);
    expect(canTransitionSourceEvent("received", "failed")).toBe(true);
    expect(canTransitionSourceEvent("queued", "processing")).toBe(true);
    expect(canTransitionSourceEvent("processing", "processed")).toBe(true);
    expect(canTransitionSourceEvent("processed", "failed")).toBe(false);
    expect(canTransitionSourceEvent("failed", "processed")).toBe(false);
    expect(canTransitionSourceEvent("unknown", "processed")).toBe(false);
  });
});
