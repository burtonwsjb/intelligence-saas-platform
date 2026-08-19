import { describe, expect, it } from "vitest";
import {
  TcgCard,
  TcgGame,
  TcgLanguage,
  TcgPrinting,
  TcgPrintingIdentifier,
  TcgPrintingReference,
} from "./tcg-contracts.js";

describe("TCG Zod contracts", () => {
  it("requires language and variant on exact printing references", () => {
    expect(
      TcgPrintingReference.parse({
        game: "pokemon",
        set: "twm",
        collector_number: "214/167",
        language: "en",
        variant: "normal",
      }).language,
    ).toBe("en");
    expect(
      TcgPrintingReference.safeParse({
        game: "pokemon",
        set: "twm",
        collector_number: "214/167",
        variant: "normal",
      }).success,
    ).toBe(false);
    expect(
      TcgPrintingReference.safeParse({
        game: "pokemon",
        set: "twm",
        collector_number: "214/167",
        language: "jp",
        variant: "normal",
      }).success,
    ).toBe(false);
    expect(TcgLanguage.parse({ language_code: "ja", display_name: "Japanese", required: true }));
    expect(TcgLanguage.parse({ language_code: "zh-Hans", display_name: "Simplified Chinese", required: true }));
    expect(TcgLanguage.safeParse({ language_code: "zh", display_name: "Chinese", required: false }).success).toBe(
      false,
    );
    expect(
      TcgGame.parse({ game_key: "one_piece", display_name: "One Piece Card Game", status: "active" }).game_key,
    ).toBe("one_piece");
    expect(
      TcgCard.parse({
        id: "crd_1",
        game_key: "pokemon",
        concept_key: "greninja-ex",
        canonical_name: "Greninja ex",
        normalized_name: "Greninja ex",
        status: "active",
      }).concept_key,
    ).toBe("greninja-ex");
    expect(
      TcgPrinting.parse({
        id: "prn_1",
        card_id: "crd_1",
        set_id: "set_1",
        game_key: "pokemon",
        collector_number: "214/167",
        collector_number_normalized: "214/167",
        language: "en",
        variant_key: "holofoil",
        promo: false,
        canonical_printing_key: "tcg:pokemon:greninja-ex:twm:214/167:en:holofoil",
        status: "active",
      }).language,
    ).toBe("en");
    expect(
      TcgPrintingIdentifier.parse({
        id: "tid_1",
        printing_id: "prn_1",
        source_namespace: "tcg_card_central",
        identifier_type: "tcg_card_central_catalog_id",
        identifier_value: "tcc_twm_214_en_normal",
        normalized_value: "tcc_twm_214_en_normal",
      }).printing_id,
    ).toBe("prn_1");
  });
});
