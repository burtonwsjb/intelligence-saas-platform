import { describe, expect, it } from "vitest";
import { CREATOR_AUTHORITY_VERSION, CREATOR_BENCHMARK_REQUIREMENT, CREATOR_TRUST_STATES } from "./authority.js";

describe("creator authority contracts", () => {
  it("versions authority separately from outcomes and defers Phase 13 benchmarks", () => {
    expect(CREATOR_AUTHORITY_VERSION).toBe("authority.v1");
    expect(CREATOR_BENCHMARK_REQUIREMENT).toContain("phase_13");
    expect(CREATOR_TRUST_STATES).toContain("excluded");
  });
});
