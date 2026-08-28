import { describe, expect, it } from "vitest";
import {
  MONEY_UNIT_MAJOR,
  MoneyError,
  assertSameCurrency,
  formatMoney,
  majorMoneyFields,
  moneyToFiniteNumber,
  normalizeCurrencyCode,
  parseMoneyDecimal,
  persistMoneyDecimal,
} from "./money.js";

describe("monetary unit integrity", () => {
  it("keeps $40.00 as 40 and $4,000.00 as 4000 with no cents conversion", () => {
    expect(parseMoneyDecimal(40)).toBe("40");
    expect(parseMoneyDecimal("40.00")).toBe("40");
    expect(parseMoneyDecimal("40.00000000")).toBe("40");
    expect(parseMoneyDecimal(4000)).toBe("4000");
    expect(parseMoneyDecimal("4000.00000000")).toBe("4000");
    expect(persistMoneyDecimal(40.5)).toBe("40.5");
    expect(moneyToFiniteNumber("40.00")).toBe(40);
    expect(moneyToFiniteNumber("4000.00")).toBe(4000);
  });

  it("rejects cents hacks, grouping, and scientific notation", () => {
    expect(parseMoneyDecimal(40) === parseMoneyDecimal(4000)).toBe(false);
    expect(() => parseMoneyDecimal("40.00") && Number("40.00") * 100).not.toThrow();
    expect(Number(parseMoneyDecimal("40.00")) * 100).toBe(4000);
    expect(Number(parseMoneyDecimal("4000")) / 100).toBe(40);
    expect(() => parseMoneyDecimal("1e2")).toThrow(MoneyError);
    expect(() => parseMoneyDecimal("4,000")).toThrow(MoneyError);
    expect(() => parseMoneyDecimal("40.123456789")).toThrow(MoneyError);
    expect(() => parseMoneyDecimal("USD 40")).toThrow(MoneyError);
  });

  it("formats USD and JPY major units for people, not raw NUMERIC strings", () => {
    expect(formatMoney("40.00000000", "USD")).toBe("$40.00");
    expect(formatMoney("4000.00000000", "usd")).toBe("$4,000.00");
    expect(formatMoney(8000, "JPY")).toBe("¥8,000");
    expect(formatMoney(null, "USD")).toBe("—");
  });

  it("preserves currency and fails closed across currencies", () => {
    expect(normalizeCurrencyCode("usd")).toBe("USD");
    expect(assertSameCurrency("USD", "usd")).toBe("USD");
    expect(() => assertSameCurrency("USD", "JPY")).toThrow(/FX conversion is not supported/);
    expect(majorMoneyFields("40.00", "USD")).toEqual({
      amount: "40",
      currency: "USD",
      unit: MONEY_UNIT_MAJOR,
    });
  });
});
