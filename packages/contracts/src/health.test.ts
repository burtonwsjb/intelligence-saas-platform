import { describe, expect, it } from "vitest";
import { healthOk } from "./health.js";

describe("healthOk", () => {
  it("returns the Phase 01 health contract", () => {
    const body = healthOk();
    expect(body).toEqual({ status: "ok" });
    expect(body.status).toBe("ok");
  });
});
