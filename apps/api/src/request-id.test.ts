import { describe, expect, it } from "vitest";
import { resolveRequestId } from "./request-id.js";

describe("resolveRequestId", () => {
  it("accepts a well-formed header and otherwise generates a UUID", () => {
    expect(resolveRequestId("req_phase05_ok")).toBe("req_phase05_ok");
    expect(resolveRequestId("bad")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(resolveRequestId(undefined)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });
});
