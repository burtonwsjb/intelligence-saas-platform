import { describe, expect, it } from "vitest";
import {
  donutSegments,
  formatChange,
  monogram,
  priceFreshness,
  recommendationText,
  timeSeriesGeometry,
} from "./display";

const day = 86_400_000;
const start = new Date("2026-09-01T00:00:00Z");

describe("display labels", () => {
  it("renders human-readable recommendation and change text", () => {
    expect(recommendationText("insufficient_data")).toBe("Not enough data");
    expect(recommendationText(null)).toBe("No recommendation");
    expect(formatChange(0.1234)).toEqual({ text: "+12.3%", direction: "up" });
    expect(formatChange(-0.05)).toEqual({ text: "−5.0%", direction: "down" });
    expect(formatChange(null)).toBeNull();
    expect(monogram("Charizard ex")).toBe("CE");
  });

  it("never calls a missing or old price fresh", () => {
    const now = new Date(start.getTime() + 30 * day);
    expect(priceFreshness(null, now).label).toBe("No sales data");
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
});
