import type { Database } from "../client.js";
import {
  insertTcgCardConcept,
  insertTcgCardNameAlias,
  insertTcgPrinting,
  insertTcgPrintingIdentifier,
  insertTcgSet,
} from "./catalog.js";

export const TCC_NAMESPACE = "tcg_card_central";
export const TCC_ID_TYPE = "tcg_card_central_catalog_id";

export async function seedTcgIdentityFixtures(db: Database) {
  const twm = await insertTcgSet(db, {
    gameKey: "pokemon",
    canonicalSetKey: "twm",
    name: "Twilight Masquerade",
    languageScope: "multi",
  });
  const sv1 = await insertTcgSet(db, {
    gameKey: "pokemon",
    canonicalSetKey: "sv1",
    name: "Scarlet & Violet",
    languageScope: "multi",
  });
  const sv2 = await insertTcgSet(db, {
    gameKey: "pokemon",
    canonicalSetKey: "sv2",
    name: "Paldea Evolved",
    languageScope: "multi",
  });
  const promo = await insertTcgSet(db, {
    gameKey: "pokemon",
    canonicalSetKey: "svp",
    name: "Scarlet & Violet Promos",
    languageScope: "en",
  });
  const op01 = await insertTcgSet(db, {
    gameKey: "one_piece",
    canonicalSetKey: "op01",
    name: "Romance Dawn",
    languageScope: "multi",
  });

  const greninja = await insertTcgCardConcept(db, {
    gameKey: "pokemon",
    conceptKey: "greninja-ex",
    canonicalName: "Greninja ex",
  });
  const pikachu = await insertTcgCardConcept(db, {
    gameKey: "pokemon",
    conceptKey: "pikachu",
    canonicalName: "Pikachu",
  });
  const charizard = await insertTcgCardConcept(db, {
    gameKey: "pokemon",
    conceptKey: "charizard-ex",
    canonicalName: "Charizard ex",
  });
  const luffy = await insertTcgCardConcept(db, {
    gameKey: "one_piece",
    conceptKey: "monkey-d-luffy",
    canonicalName: "Monkey D. Luffy",
  });

  await insertTcgCardNameAlias(db, { cardId: greninja.id, language: "en", name: "Greninja ex" });
  await insertTcgCardNameAlias(db, { cardId: greninja.id, language: "en", name: "Greninja" });
  await insertTcgCardNameAlias(db, { cardId: greninja.id, language: "ja", name: "ゲッコウガex" });
  await insertTcgCardNameAlias(db, { cardId: greninja.id, language: "ja", name: "ゲッコウガ" });
  await insertTcgCardNameAlias(db, { cardId: greninja.id, language: "zh-Hans", name: "甲贺忍蛙ex" });
  await insertTcgCardNameAlias(db, { cardId: greninja.id, language: "zh-Hans", name: "甲贺忍蛙" });
  await insertTcgCardNameAlias(db, { cardId: pikachu.id, language: "en", name: "Pikachu" });
  await insertTcgCardNameAlias(db, { cardId: charizard.id, language: "en", name: "Charizard ex" });
  await insertTcgCardNameAlias(db, { cardId: charizard.id, language: "en", name: "Charizard" });
  await insertTcgCardNameAlias(db, { cardId: luffy.id, language: "en", name: "Monkey D. Luffy" });
  await insertTcgCardNameAlias(db, { cardId: luffy.id, language: "ja", name: "モンキー・D・ルフィ" });

  const print = async (
    card: { id: string; conceptKey: string },
    set: { id: string; canonicalSetKey: string },
    gameKey: string,
    collectorNumber: string,
    language: string,
    variantKey: string,
    extra?: { promo?: boolean; rarity?: string; tccId?: string },
  ) => {
    const row = await insertTcgPrinting(db, {
      cardId: card.id,
      setId: set.id,
      gameKey,
      conceptKey: card.conceptKey,
      setKey: set.canonicalSetKey,
      collectorNumber,
      language,
      variantKey,
      promo: extra?.promo,
      rarity: extra?.rarity,
    });
    if (extra?.tccId) {
      await insertTcgPrintingIdentifier(db, {
        printingId: row.id,
        sourceNamespace: TCC_NAMESPACE,
        identifierType: TCC_ID_TYPE,
        identifierValue: extra.tccId,
      });
    }
    return row;
  };

  const greninjaEnNormal = await print(greninja, twm, "pokemon", "214/167", "en", "normal", {
    tccId: "tcc_twm_214_en_normal",
  });
  const greninjaJaNormal = await print(greninja, twm, "pokemon", "214/167", "ja", "normal", {
    tccId: "tcc_twm_214_ja_normal",
  });
  const greninjaZhNormal = await print(greninja, twm, "pokemon", "214/167", "zh-Hans", "normal", {
    tccId: "tcc_twm_214_zhhans_normal",
  });
  const greninjaEnHolo = await print(greninja, twm, "pokemon", "214/167", "en", "holofoil", {
    tccId: "tcc_twm_214_en_holo",
  });
  const greninjaEnReverse = await print(greninja, twm, "pokemon", "214/167", "en", "reverse_holo");
  const pikachuSv1 = await print(pikachu, sv1, "pokemon", "025/198", "en", "normal", {
    tccId: "tcc_sv1_025_en_normal",
  });
  const pikachuSv2 = await print(pikachu, sv2, "pokemon", "025/193", "en", "normal");
  const charizardStandard = await print(charizard, sv1, "pokemon", "006/198", "en", "normal");
  const charizardPromo = await print(charizard, promo, "pokemon", "P-001", "en", "promo", {
    promo: true,
    tccId: "tcc_svp_p001_en_promo",
  });
  const numbered = await print(charizard, sv1, "pokemon", "174/172", "en", "normal");
  const numberedOtherSet = await print(charizard, promo, "pokemon", "174/172", "en", "normal");
  const trainerGallery = await print(pikachu, sv1, "pokemon", "TG05/TG30", "en", "alt_art");
  const padded = await print(pikachu, promo, "pokemon", "031", "en", "normal");
  const luffyEn = await print(luffy, op01, "one_piece", "OP01-001", "en", "normal", {
    tccId: "tcc_op01_001_en_normal",
  });
  const luffyJa = await print(luffy, op01, "one_piece", "OP01-001", "ja", "normal", {
    tccId: "tcc_op01_001_ja_normal",
  });

  return {
    sets: { twm, sv1, sv2, promo, op01 },
    concepts: { greninja, pikachu, charizard, luffy },
    printings: {
      greninjaEnNormal,
      greninjaJaNormal,
      greninjaZhNormal,
      greninjaEnHolo,
      greninjaEnReverse,
      pikachuSv1,
      pikachuSv2,
      charizardStandard,
      charizardPromo,
      numbered,
      numberedOtherSet,
      trainerGallery,
      padded,
      luffyEn,
      luffyJa,
    },
  };
}
