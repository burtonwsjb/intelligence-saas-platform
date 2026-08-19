import { describe, expect, it } from "vitest";
import {
  canonicalPrintingKey,
  isTcgLanguageCode,
  normalizeCollectorNumber,
  parseTcgLanguage,
  parseTcgPrintingReference,
  parseTcgVariant,
  TcgContractError,
} from "./tcg.js";

describe("TCG contracts", () => {
  it("validates required languages and rejects aliases", () => {
    expect(isTcgLanguageCode("en")).toBe(true);
    expect(isTcgLanguageCode("ja")).toBe(true);
    expect(isTcgLanguageCode("zh-Hans")).toBe(true);
    expect(isTcgLanguageCode("zh-Hant")).toBe(true);
    expect(isTcgLanguageCode("Chinese")).toBe(false);
    expect(isTcgLanguageCode("jp")).toBe(false);
    expect(isTcgLanguageCode("zh")).toBe(false);
    expect(() => parseTcgLanguage("jp")).toThrow(TcgContractError);
    expect(() => parseTcgLanguage(undefined)).toThrow(TcgContractError);
  });

  it("preserves collector numbers and builds stable printing keys", () => {
    expect(normalizeCollectorNumber(" 174/172 ")).toBe("174/172");
    expect(normalizeCollectorNumber("TG05/TG30")).toBe("tg05/tg30");
    expect(normalizeCollectorNumber("OP01-001")).toBe("op01-001");
    expect(normalizeCollectorNumber("031")).toBe("031");
    expect(Number.isNaN(Number("174/172"))).toBe(true);
    const en = canonicalPrintingKey({
      gameKey: "pokemon",
      conceptKey: "greninja-ex",
      setKey: "twm",
      collectorNormalized: "214/167",
      language: "en",
      variantKey: "normal",
    });
    const ja = canonicalPrintingKey({
      gameKey: "pokemon",
      conceptKey: "greninja-ex",
      setKey: "twm",
      collectorNormalized: "214/167",
      language: "ja",
      variantKey: "normal",
    });
    expect(en).not.toBe(ja);
    expect(
      canonicalPrintingKey({
        gameKey: "pokemon",
        conceptKey: "greninja-ex",
        setKey: "twm",
        collectorNormalized: "214/167",
        language: "zh-Hans",
        variantKey: "normal",
      }),
    ).not.toBe(en);
    expect(
      canonicalPrintingKey({
        gameKey: "pokemon",
        conceptKey: "greninja-ex",
        setKey: "twm",
        collectorNormalized: "214/167",
        language: "en",
        variantKey: "reverse_holo",
      }),
    ).not.toBe(en);
    expect(
      parseTcgPrintingReference({
        game: "pokemon",
        set: "twm",
        collector_number: "214/167",
        language: "en",
        variant: "holofoil",
      }).language,
    ).toBe("en");
    expect(() => parseTcgVariant("shiny")).toThrow(TcgContractError);
  });
});
