import { describe, expect, it } from "vitest";
import {
  ENTITY_RESOLVER_VERSION,
  EntityResolutionContractError,
  mayBindPrinting,
  parseEntityResolutionState,
  parseResolutionConfidence,
} from "./resolution.js";

describe("entity resolution contracts", () => {
  it("keeps resolution confidence independent and only binds exact/high_confidence", () => {
    expect(ENTITY_RESOLVER_VERSION).toBe("resolver.v1");
    expect(mayBindPrinting("exact")).toBe(true);
    expect(mayBindPrinting("high_confidence")).toBe(true);
    expect(mayBindPrinting("probable")).toBe(false);
    expect(mayBindPrinting("ambiguous")).toBe(false);
    expect(mayBindPrinting("unresolved")).toBe(false);
    expect(parseEntityResolutionState("conflict")).toBe("conflict");
    expect(parseResolutionConfidence(0.85)).toBe(0.85);
    expect(parseResolutionConfidence(null)).toBeNull();
    expect(() => parseResolutionConfidence(1.2)).toThrow(EntityResolutionContractError);
  });
});
