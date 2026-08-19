import { describe, expect, it } from "vitest";
import {
  computeTcgAskSoldSpread,
  isTcgMarketEventType,
  parseTcgCondition,
  parseTcgCurrency,
  parseTcgMarketRecord,
  TcgMarketContractError,
} from "./tcg-market.js";
import { isGenericEventType } from "./kernel.js";

describe("TCG market contracts", () => {
  it("keeps pack event types out of the generic registry and validates currency/condition", () => {
    expect(isTcgMarketEventType("tcg.market.sold")).toBe(true);
    expect(isGenericEventType("tcg.market.sold")).toBe(false);
    expect(parseTcgCurrency("USD")).toBe("USD");
    expect(parseTcgCurrency("JPY")).toBe("JPY");
    expect(() => parseTcgCurrency("usd")).toThrow(TcgMarketContractError);
    expect(() => parseTcgCurrency("US")).toThrow(TcgMarketContractError);
    expect(parseTcgCondition("nm")).toBe("nm");
    expect(parseTcgCondition("unknown")).toBe("unknown");
    expect(() => parseTcgCondition("mint")).toThrow(TcgMarketContractError);
    expect(
      computeTcgAskSoldSpread({ lowestAsk: 120, latestSold: 100 }),
    ).toEqual({
      spread_abs: 20,
      spread_ratio: 1.2,
      formula: "lowest_ask_minus_latest_sold",
      version: "spread.v1",
    });
    expect(computeTcgAskSoldSpread({ lowestAsk: 10, latestSold: 0 }).spread_abs).toBeNull();
    expect(
      parseTcgMarketRecord({
        provider: "fixture",
        provider_record_id: "sold_1",
        event_type: "tcg.market.sold",
        market_type: "marketplace_sold",
        observed_at: "2026-01-01T00:00:00.000Z",
        currency: "USD",
        condition: "nm",
        price: 12.5,
        printing: {
          game: "pokemon",
          set: "twm",
          collector_number: "214/167",
          language: "en",
          variant: "normal",
        },
      }).provider,
    ).toBe("fixture");
    expect(() =>
      parseTcgMarketRecord({
        provider: "fixture",
        provider_record_id: "sold_bad",
        event_type: "tcg.market.sold",
        market_type: "marketplace_sold",
        observed_at: "2026-01-01T00:00:00.000Z",
        currency: "USD",
        condition: "nm",
        price: -1,
        printing: { game: "pokemon", set: "twm", collector_number: "214/167", language: "en", variant: "normal" },
      }),
    ).toThrow(TcgMarketContractError);
  });
});
