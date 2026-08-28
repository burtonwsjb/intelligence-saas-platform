import { describe, expect, it } from "vitest";
import { formatMoney } from "@isp/shared";

describe("customer money display", () => {
  it("formats opportunity and card prices for people", () => {
    expect(formatMoney("41.00000000", "USD")).toBe("$41.00");
    expect(formatMoney("4000.00000000", "USD")).toBe("$4,000.00");
    expect(formatMoney("8000", "JPY")).toBe("¥8,000");
  });
});
