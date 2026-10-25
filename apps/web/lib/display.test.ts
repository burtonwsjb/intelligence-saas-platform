import { describe, expect, it } from "vitest";
import {
  donutSegments,
  formatChange,
  gameText,
  languageText,
  monogram,
  plural,
  priceFreshness,
  providerText,
  recommendationText,
  socialText,
  timeSeriesGeometry,
  verdictStep,
} from "./display";
import { formatMoney } from "@isp/shared";

const day = 86_400_000;
const start = new Date("2026-09-01T00:00:00Z");

describe("display labels", () => {
  it("renders human-readable recommendation and change text", () => {
    expect(recommendationText("insufficient_data")).toBe("No reading yet");
    expect(recommendationText(null)).toBe("No recommendation");
    expect(formatChange(0.1234)).toEqual({ text: "+12.3%", direction: "up" });
    expect(formatChange(-0.05)).toEqual({ text: "−5.0%", direction: "down" });
    expect(formatChange(null)).toBeNull();
    expect(monogram("Charizard ex")).toBe("CE");
  });

  it("never calls a missing or old price fresh", () => {
    const now = new Date(start.getTime() + 30 * day);
    expect(priceFreshness(null, now).label).toBe("No price data");
    expect(priceFreshness(new Date(now.getTime() - 2 * 3_600_000), now).tone).toBe("good");
    expect(priceFreshness(start, now).tone).toBe("warn");
  });
});

describe("chart geometry", () => {
  it("positions points by time so gaps stay visible", () => {
    const geometry = timeSeriesGeometry(
      [
        { observedAt: new Date(start.getTime() + 10 * day), amount: 12 },
        { observedAt: start, amount: 10 },
        { observedAt: new Date(start.getTime() + 1 * day), amount: 11 },
      ],
      { width: 200, height: 100, padding: { left: 0, right: 0, top: 0, bottom: 0 } },
    )!;
    expect(geometry.points.map((point) => point.amount)).toEqual([10, 11, 12]);
    expect(geometry.points[0]!.x).toBe(0);
    expect(geometry.points[1]!.x).toBe(20);
    expect(geometry.points[2]!.x).toBe(200);
    expect(geometry.points[2]!.y).toBeLessThan(geometry.points[0]!.y);
  });

  it("draws nothing without data", () => {
    expect(timeSeriesGeometry([])).toBeNull();
    expect(donutSegments([{ key: "positive", value: 0 }])).toEqual([]);
  });

  it("splits donut shares by value and skips empty categories", () => {
    const segments = donutSegments([
      { key: "positive", value: 3 },
      { key: "neutral", value: 0 },
      { key: "negative", value: 1 },
    ]);
    expect(segments.map((segment) => segment.key)).toEqual(["positive", "negative"]);
    expect(segments[0]!.share).toBeCloseTo(0.75);
    expect(donutSegments([{ key: "positive", value: 2 }])).toHaveLength(1);
  });

  it("names games, providers and counts in plain words", () => {
    expect(gameText("one_piece")).toBe("One Piece");
    expect(gameText("yugioh")).toBe("Yu-Gi-Oh!");
    expect(gameText("new_game")).toBe("New Game");
    expect(providerText("tcg_card_central")).toBe("TCG Card Central");
    expect(languageText("multi")).toBe("Multiple languages");
    expect(plural(1, "printing")).toBe("1 printing");
    expect(plural(1200, "printing")).toBe("1,200 printings");
  });

  it("places recommendations on the five-step buy/sell scale", () => {
    expect(verdictStep("strong_sell")).toBe(0);
    expect(verdictStep("reduce")).toBe(1);
    expect(verdictStep("watch")).toBe(2);
    expect(verdictStep("strong_buy")).toBe(4);
    expect(verdictStep("insufficient_data")).toBeNull();
    expect(verdictStep(null)).toBeNull();
  });
});

describe("card list wording", () => {
  it("formats interpolated chart ticks as money once they are fixed to 8 decimals", () => {
    const geometry = timeSeriesGeometry([
      { observedAt: new Date("2026-10-01T00:00:00Z"), amount: 36.11 },
      { observedAt: new Date("2026-10-15T00:00:00Z"), amount: 41.07 },
      { observedAt: new Date("2026-10-22T00:00:00Z"), amount: 33.29 },
    ])!;
    for (const tick of geometry.yTicks) {
      expect(formatMoney(tick.value.toFixed(8), "USD")).toMatch(/^\$\d+\.\d{2}$/);
    }
  });

  it("reads one or two posts as an early lean, not a verdict", () => {
    const summary = {
      label: "too_few" as const,
      classified: 2,
      weighted: { positive: 0.1, negative: 0.05, neutral: 0, mixed: 0 },
    };
    expect(socialText(summary)).toBe("leans positive (2 posts)");
    expect(socialText({ ...summary, label: "no_evidence", classified: 0 })).toBe("No social evidence");
  });
});
