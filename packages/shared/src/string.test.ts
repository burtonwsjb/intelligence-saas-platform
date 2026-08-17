import { describe, expect, it } from "vitest";
import { isNonEmptyString } from "./string.js";

describe("isNonEmptyString", () => {
  it("accepts trimmed non-empty strings", () => {
    expect(isNonEmptyString("ok")).toBe(true);
  });

  it("rejects blank strings and non-strings", () => {
    expect(isNonEmptyString("  ")).toBe(false);
    expect(isNonEmptyString("")).toBe(false);
    expect(isNonEmptyString(null)).toBe(false);
    expect(isNonEmptyString(1)).toBe(false);
  });
});
