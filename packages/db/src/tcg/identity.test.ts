import { describe, expect, it } from "vitest";
import {
  canonicalPrintingKey,
  isTcgLanguageCode,
  kernelCanonicalKeyForPrinting,
  normalizeCollectorNumber,
  normalizeTcgName,
  parseTcgLanguage,
  parseTcgVariant,
  TcgValidationError,
} from "./identity.js";

describe("TCG identity helpers", () => {
  it("validates required BCP 47 languages and rejects aliases", () => {
    expect(isTcgLanguageCode("en")).toBe(true);
    expect(isTcgLanguageCode("ja")).toBe(true);
    expect(isTcgLanguageCode("zh-Hans")).toBe(true);
    expect(isTcgLanguageCode("zh-Hant")).toBe(true);
    expect(isTcgLanguageCode("ko")).toBe(true);
    expect(() => parseTcgLanguage("jp")).toThrow(TcgValidationError);
    expect(() => parseTcgLanguage("zh")).toThrow(TcgValidationError);
    expect(() => parseTcgLanguage("Chinese")).toThrow(TcgValidationError);
    expect(() => parseTcgLanguage(undefined)).toThrow(TcgValidationError);
    expect(() => parseTcgLanguage("")).toThrow(TcgValidationError);
  });

  it("preserves collector number semantics and only applies safe normalization", () => {
    expect(normalizeCollectorNumber("174/172")).toBe("174/172");
    expect(normalizeCollectorNumber("TG05/TG30")).toBe("tg05/tg30");
    expect(normalizeCollectorNumber("031")).toBe("031");
    expect(normalizeCollectorNumber("P-001")).toBe("p-001");
    expect(normalizeCollectorNumber("OP01-001")).toBe("op01-001");
    expect(normalizeCollectorNumber(" 214/167 ")).toBe("214/167");
    expect(Number("174/172")).toBeNaN();
  });

  it("builds deterministic canonical keys that separate language, set, and variant", () => {
    const base = {
      gameKey: "pokemon",
      conceptKey: "greninja-ex",
      setKey: "twm",
      collectorNormalized: "214/167",
    };
    const en = canonicalPrintingKey({ ...base, language: "en", variantKey: "normal" });
    const ja = canonicalPrintingKey({ ...base, language: "ja", variantKey: "normal" });
    const zh = canonicalPrintingKey({ ...base, language: "zh-Hans", variantKey: "normal" });
    const holo = canonicalPrintingKey({ ...base, language: "en", variantKey: "holofoil" });
    const reverse = canonicalPrintingKey({ ...base, language: "en", variantKey: "reverse_holo" });
    const otherSet = canonicalPrintingKey({
      ...base,
      setKey: "sv1",
      language: "en",
      variantKey: "normal",
    });
    expect(en).toBe("tcg:pokemon:greninja-ex:twm:214/167:en:normal");
    expect(en).toBe(canonicalPrintingKey({ ...base, language: "en", variantKey: "normal" }));
    expect(en).not.toBe(ja);
    expect(en).not.toBe(zh);
    expect(ja).not.toBe(zh);
    expect(en).not.toBe(holo);
    expect(holo).not.toBe(reverse);
    expect(en).not.toBe(otherSet);
    expect(en.includes("Greninja")).toBe(false);
    expect(kernelCanonicalKeyForPrinting(en)).toBe(
      "tcg_printing:tcg:canonical_printing_key:tcg:pokemon:greninja-ex:twm:214/167:en:normal",
    );
    expect(() => parseTcgVariant("shiny")).toThrow(TcgValidationError);
    expect(normalizeTcgName("  リザードン  ")).toBe("リザードン");
    expect(normalizeTcgName("Farfetch’d")).toBe("Farfetch’d");
  });
});
