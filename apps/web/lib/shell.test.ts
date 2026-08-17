import { describe, expect, it } from "vitest";
import { healthOk } from "@isp/contracts";
import { shellLabel } from "./shell";

describe("web shell import", () => {
  it("uses the shared health contract", () => {
    expect(healthOk()).toEqual({ status: "ok" });
    expect(shellLabel()).toContain("ok");
  });
});
