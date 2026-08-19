import { describe, expect, it } from "vitest";
import {
  CREATOR_EXTRACTOR_VERSION,
  CreatorContractError,
  mayBindCallPrinting,
  parseCreatorCallDirection,
  parseCreatorCallHorizon,
} from "./creator.js";

describe("creator call contracts", () => {
  it("bounds directions/horizons and only binds exact or high_confidence printings", () => {
    expect(CREATOR_EXTRACTOR_VERSION).toBe("creator.extract.v1");
    expect(parseCreatorCallDirection("bullish")).toBe("bullish");
    expect(parseCreatorCallHorizon("unspecified")).toBe("unspecified");
    expect(mayBindCallPrinting("exact")).toBe(true);
    expect(mayBindCallPrinting("ambiguous")).toBe(false);
    expect(() => parseCreatorCallDirection("long")).toThrow(CreatorContractError);
  });
});
