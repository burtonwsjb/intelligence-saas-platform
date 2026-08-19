import { describe, expect, it } from "vitest";
import { TcgMarketRecord } from "./tcg-market-contracts.js";

describe("TCG market Zod contracts", () => {
  it("requires currency, condition, and exact printing or external id fields", () => {
    expect(
      TcgMarketRecord.parse({
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
      }).currency,
    ).toBe("USD");
    expect(
      TcgMarketRecord.safeParse({
        provider: "fixture",
        provider_record_id: "sold_bad",
        event_type: "tcg.market.sold",
        market_type: "marketplace_sold",
        observed_at: "2026-01-01T00:00:00.000Z",
        currency: "usd",
        condition: "nm",
        price: 12.5,
      }).success,
    ).toBe(false);
    expect(
      TcgMarketRecord.safeParse({
        provider: "fixture",
        provider_record_id: "sold_neg",
        event_type: "tcg.market.sold",
        market_type: "marketplace_sold",
        observed_at: "2026-01-01T00:00:00.000Z",
        currency: "USD",
        condition: "nm",
        price: -1,
        printing: { game: "pokemon", set: "twm", collector_number: "214/167", language: "en", variant: "normal" },
      }).success,
    ).toBe(false);
  });
});
