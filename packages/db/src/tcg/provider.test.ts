import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxProviderFromFixtures } from "./provider.js";

describe("Sandbox TCG Card Central provider", () => {
  const provider = sandboxProviderFromFixtures(
    [
      {
        id: "prn_en",
        game: "pokemon",
        set: "twm",
        collector_number: "214/167",
        language: "en",
        variant: "normal",
        canonical_printing_key: "tcg:pokemon:greninja-ex:twm:214/167:en:normal",
        tccId: "tcc_en",
      },
      {
        id: "prn_holo",
        game: "pokemon",
        set: "twm",
        collector_number: "214/167",
        language: "en",
        variant: "holofoil",
        canonical_printing_key: "tcg:pokemon:greninja-ex:twm:214/167:en:holofoil",
        tccId: "tcc_holo",
      },
    ],
    [{ id: "set_twm", game: "pokemon", canonical_set_key: "twm", name: "Twilight Masquerade" }],
  );

  it("looks up fixtures without network", async () => {
    expect(await provider.healthCheck()).toEqual({ ok: true, mode: "sandbox_fixture" });
    expect((await provider.getPrintingByExternalId("tcc_en"))?.id).toBe("prn_en");
    expect(await provider.getPrintingByExternalId("missing")).toBeNull();
    const exact = await provider.resolvePrinting({
      game: "pokemon",
      set: "twm",
      collector_number: "214/167",
      language: "en",
      variant: "normal",
    });
    expect(exact.status).toBe("exact");
    expect(exact.confidence).toBe(1);
    const ambiguous = await provider.resolvePrinting({
      game: "pokemon",
      set: "twm",
      collector_number: "214/167",
      language: "en",
    });
    expect(ambiguous.status).toBe("ambiguous");
    expect(ambiguous.confidence).toBeNull();
    const missing = await provider.resolvePrinting({
      game: "pokemon",
      set: "twm",
      collector_number: "000/000",
      language: "en",
      variant: "normal",
    });
    expect(missing.status).toBe("not_found");
    expect(await provider.getSet({ game: "pokemon", set: "twm" })).not.toBeNull();
    await expect(
      provider.resolvePrinting({
        game: "pokemon",
        set: "twm",
        collector_number: "214/167",
      }),
    ).rejects.toThrow(/Language is required/);
  });

  it("does not call TCG Card Central or use fetch", () => {
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "provider.ts"), "utf8");
    expect(src).not.toMatch(/https?:\/\/tcgcardcentral\.com/i);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/https?:\/\//);
  });
});
