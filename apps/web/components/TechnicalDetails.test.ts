import { describe, expect, it } from "vitest";
import { explanationText } from "./TechnicalDetails.js";

describe("explanationText", () => {
  it("prefers human text over raw JSON", () => {
    expect(explanationText({ code: "volume_momentum", text: "Volume is accelerating." })).toBe(
      "Volume is accelerating.",
    );
    expect(explanationText("plain")).toBe("plain");
    expect(explanationText({ code: "x" })).toBe("See technical details.");
  });
});
