import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  applyResolutionReview,
  ingestSourceContentRecord,
  listResolutionHistory,
  listSourceMentions,
  readMigrationSql,
  resolveEntity,
  resolveSourceMention,
  seedTcgIdentityFixtures,
  sourceIntelligenceFixtures,
  TCC_ID_TYPE,
  TCC_NAMESPACE,
  type Database,
} from "../index.js";
import { FUZZY_PROBABLE_THRESHOLD, nameSimilarity, normalizeMatchText, primaryScript } from "./identity.js";
import { findNameConcepts, withoutNonCollectorNumbers } from "./resolve.js";
import { inferSetFromText } from "./signals.js";
import { insertTcgCardConcept, insertTcgCardNameAlias } from "../tcg/catalog.js";

describe("entity resolution", () => {
  async function setup() {
    const client = new PGlite();
    await client.exec(await readMigrationSql());
    const db = drizzle(client) as unknown as Database;
    const seeded = await seedTcgIdentityFixtures(db);
    return { db, seeded };
  }

  it("resolves exact provider ids and structured printings first", async () => {
    const { db, seeded } = await setup();
    const byId = await resolveEntity(db, {
      subjectType: "provider_reference",
      subjectId: "ext_en",
      signals: {
        external_id: {
          source_namespace: TCC_NAMESPACE,
          identifier_type: TCC_ID_TYPE,
          identifier_value: "tcc_twm_214_en_normal",
        },
      },
    });
    expect(byId.attempt.status).toBe("exact");
    expect(byId.attempt.chosenPrintingId).toBe(seeded.printings.greninjaEnNormal.id);
    expect(byId.attempt.resolverVersion).toBe("resolver.v1");
    expect(byId.candidates[0]?.evidence).toContain("external_id_exact");

    const structured = await resolveEntity(db, {
      subjectType: "manual",
      subjectId: "struct_en",
      signals: {
        game: "pokemon",
        set: "twm",
        collector_number: "214/167",
        language: "en",
        variant: "normal",
      },
    });
    expect(structured.attempt.status).toBe("exact");
    expect(structured.attempt.chosenPrintingId).toBe(seeded.printings.greninjaEnNormal.id);
    expect(structured.attempt.confidence).toBe("1.0000");
  });

  it("keeps same name/number across sets and languages ambiguous", async () => {
    const { db, seeded } = await setup();
    const sameName = await resolveEntity(db, {
      subjectType: "manual",
      subjectId: "pikachu_name",
      signals: { game: "pokemon", card_name: "Pikachu" },
    });
    expect(sameName.attempt.status).toBe("ambiguous");
    expect(sameName.attempt.chosenPrintingId).toBeNull();
    expect(sameName.attempt.chosenConceptId).toBe(seeded.concepts.pikachu.id);

    const sameNumber = await resolveEntity(db, {
      subjectType: "manual",
      subjectId: "num_174",
      signals: { game: "pokemon", collector_number: "174/172", language: "en", variant: "normal" },
    });
    expect(sameNumber.attempt.status).toBe("ambiguous");
    expect(sameNumber.attempt.chosenPrintingId).toBeNull();

    const enJa = await resolveEntity(db, {
      subjectType: "manual",
      subjectId: "greninja_nolang",
      signals: {
        game: "pokemon",
        set: "Twilight Masquerade",
        collector_number: "214",
        card_name: "Greninja",
      },
    });
    expect(enJa.attempt.status).toBe("ambiguous");
    expect(enJa.candidates.some((row) => row.printingId === seeded.printings.greninjaEnNormal.id)).toBe(true);
    expect(enJa.candidates.some((row) => row.printingId === seeded.printings.greninjaJaNormal.id)).toBe(true);

    const enZh = await resolveEntity(db, {
      subjectType: "manual",
      subjectId: "greninja_zh",
      signals: {
        game: "pokemon",
        set: "twm",
        collector_number: "214/167",
        card_name: "Greninja",
      },
    });
    expect(enZh.candidates.some((row) => row.printingId === seeded.printings.greninjaZhNormal.id)).toBe(true);
    expect(enZh.attempt.chosenPrintingId).toBeNull();
  });

  it("never defaults language or variant and does not transliterate Japanese", async () => {
    const { db, seeded } = await setup();
    const variant = await resolveEntity(db, {
      subjectType: "manual",
      subjectId: "variant_gap",
      signals: {
        game: "pokemon",
        set: "twm",
        collector_number: "214/167",
        language: "en",
      },
    });
    expect(variant.attempt.status).toBe("ambiguous");
    expect(variant.attempt.chosenPrintingId).toBeNull();

    const ja = await resolveEntity(db, {
      subjectType: "manual",
      subjectId: "ja_name",
      signals: {
        game: "pokemon",
        card_name: "ゲッコウガ",
        collector_number: "214",
        set: "twm",
      },
    });
    expect(ja.attempt.status).toBe("ambiguous");
    expect(ja.attempt.chosenPrintingId).toBeNull();
    expect(ja.attempt.chosenConceptId).toBe(seeded.concepts.greninja.id);

    const jaExact = await resolveEntity(db, {
      subjectType: "manual",
      subjectId: "ja_exact",
      signals: {
        game: "pokemon",
        set: "twm",
        collector_number: "214/167",
        language: "ja",
        variant: "normal",
      },
    });
    expect(jaExact.attempt.chosenPrintingId).toBe(seeded.printings.greninjaJaNormal.id);
    expect(jaExact.attempt.chosenPrintingId).not.toBe(seeded.printings.greninjaEnNormal.id);

    expect(primaryScript("ゲッコウガ")).toBe("cjk");
    expect(nameSimilarity("ゲッコウガ", "Greninja")).toBe(0);
  });

  it("uses context clues without overriding canonical language/variant requirements", async () => {
    const { db, seeded } = await setup();
    const contextual = await resolveEntity(db, {
      subjectType: "manual",
      subjectId: "ctx",
      signals: {
        context_text: "Twilight Masquerade Greninja 214",
        content_language: "en",
      },
    });
    expect(contextual.attempt.status).toBe("ambiguous");
    expect(contextual.attempt.inputSignals).toMatchObject({ set: "twm", collector_number: "214" });
    expect(contextual.attempt.inputSignals).not.toMatchObject({ language: "en" });
    expect(contextual.candidates.some((row) => row.evidence.includes("context_clue"))).toBe(true);
    expect(contextual.attempt.chosenConceptId).toBe(seeded.concepts.greninja.id);

    const japaneseContext = await resolveEntity(db, {
      subjectType: "manual",
      subjectId: "ctx_ja",
      signals: { context_text: "Japanese Twilight Masquerade Greninja 214" },
    });
    expect(japaneseContext.attempt.status).toBe("exact");
    expect(japaneseContext.attempt.chosenPrintingId).toBe(seeded.printings.greninjaJaNormal.id);
  });

  it("ranks typo names as candidates without exact binding", async () => {
    const { db, seeded } = await setup();
    const typo = await resolveEntity(db, {
      subjectType: "manual",
      subjectId: "typo",
      signals: { game: "pokemon", card_name: "Grennja" },
    });
    expect(typo.attempt.status).toBe("probable");
    expect(typo.attempt.chosenPrintingId).toBeNull();
    expect(typo.attempt.chosenConceptId).toBe(seeded.concepts.greninja.id);
    expect(typo.candidates.some((row) => row.evidence.includes("name_similarity"))).toBe(true);

    const typoExactFields = await resolveEntity(db, {
      subjectType: "manual",
      subjectId: "typo_full",
      signals: {
        game: "pokemon",
        set: "twm",
        collector_number: "214/167",
        language: "en",
        variant: "normal",
        card_name: "Grennja",
      },
    });
    expect(typoExactFields.attempt.status).toBe("exact");
    expect(typoExactFields.attempt.chosenPrintingId).toBe(seeded.printings.greninjaEnNormal.id);

    const high = await resolveEntity(db, {
      subjectType: "manual",
      subjectId: "typo_high",
      signals: {
        set: "twm",
        collector_number: "214/167",
        language: "en",
        variant: "normal",
        card_name: "Grennja",
      },
    });
    expect(high.attempt.status).toBe("high_confidence");
    expect(high.attempt.chosenPrintingId).toBe(seeded.printings.greninjaEnNormal.id);
  });

  it("preserves incomplete, conflicting, ranked, reviewed, and historical attempts", async () => {
    const { db, seeded } = await setup();
    const incomplete = await resolveEntity(db, {
      subjectType: "manual",
      subjectId: "empty",
      signals: {},
    });
    expect(incomplete.attempt.status).toBe("unresolved");
    expect(incomplete.attempt.chosenPrintingId).toBeNull();

    const conflict = await resolveEntity(db, {
      subjectType: "manual",
      subjectId: "conflict",
      signals: {
        language: "en",
        external_id: {
          source_namespace: TCC_NAMESPACE,
          identifier_type: TCC_ID_TYPE,
          identifier_value: "tcc_twm_214_ja_normal",
        },
      },
    });
    expect(conflict.attempt.status).toBe("conflict");
    expect(conflict.attempt.chosenPrintingId).toBeNull();

    const ranked = await resolveEntity(db, {
      subjectType: "manual",
      subjectId: "rank",
      signals: { game: "pokemon", card_name: "Greninja", set: "twm", collector_number: "214", language: "en" },
    });
    expect(ranked.candidates[0]?.rank).toBe(1);
    expect(ranked.candidates.length).toBeGreaterThan(1);
    expect(Number(ranked.candidates[0]?.score)).toBeGreaterThanOrEqual(Number(ranked.candidates[1]?.score ?? 0));

    const first = await resolveEntity(db, {
      subjectType: "manual",
      subjectId: "hist",
      signals: { card_name: "Greninja" },
    });
    const second = await resolveEntity(db, {
      subjectType: "manual",
      subjectId: "hist",
      signals: {
        game: "pokemon",
        set: "twm",
        collector_number: "214/167",
        language: "en",
        variant: "normal",
      },
    });
    const history = await listResolutionHistory(db, "manual", "hist");
    expect(history).toHaveLength(2);
    expect(history.some((row) => row.id === first.attempt.id)).toBe(true);
    expect(second.attempt.id).not.toBe(first.attempt.id);
    expect(first.attempt.status).toBe("ambiguous");
    expect(second.attempt.status).toBe("exact");

    const reviewed = await applyResolutionReview(db, {
      sourceAttemptId: first.attempt.id,
      action: "accept_candidate",
      candidateId: first.candidates.find((row) => row.printingId === seeded.printings.greninjaEnNormal.id)?.id,
    });
    expect(reviewed.attempt.status).toBe("exact");
    expect(reviewed.attempt.reviewState).toBe("accepted");
    expect(reviewed.attempt.chosenPrintingId).toBe(seeded.printings.greninjaEnNormal.id);
    const afterReview = await listResolutionHistory(db, "manual", "hist");
    expect(afterReview.length).toBeGreaterThanOrEqual(3);
    expect(afterReview.some((row) => row.id === first.attempt.id && row.status === "ambiguous")).toBe(true);
  });

  it("resolves source mentions without mutating them and keeps content language as a hint", async () => {
    const { db, seeded } = await setup();
    const ingested = await ingestSourceContentRecord(db, sourceIntelligenceFixtures()[0]!);
    const mentions = await listSourceMentions(db, ingested.contentId!);
    expect(mentions[0]?.metadata).toMatchObject({ resolution_status: "unresolved" });
    const resolved = await resolveSourceMention(db, mentions[0]!.id);
    expect(resolved.attempt.status).toBe("ambiguous");
    expect(resolved.attempt.mentionId).toBe(mentions[0]!.id);
    expect(resolved.attempt.chosenConceptId).toBe(seeded.concepts.greninja.id);
    expect(resolved.attempt.inputSignals).toMatchObject({ content_language: "en" });
    expect(resolved.attempt.chosenPrintingId).toBeNull();
    const again = await listSourceMentions(db, ingested.contentId!);
    expect(again[0]?.metadata).toMatchObject({ resolution_status: "unresolved" });
    expect(again[0]?.id).toBe(mentions[0]!.id);
  });

  it("infers the longest set name, and set keys only as whole words", () => {
    const sets = [
      { canonicalSetKey: "sv1", name: "Scarlet & Violet" },
      { canonicalSetKey: "svp", name: "Scarlet & Violet Promos" },
      { canonicalSetKey: "core", name: "Core Set" },
      { canonicalSetKey: "op01", name: "Romance Dawn" },
    ];
    expect(inferSetFromText("Scarlet & Violet Promos Pikachu", sets)).toBe("svp");
    expect(inferSetFromText("Scarlet & Violet Pikachu", sets)).toBe("sv1");
    expect(inferSetFromText("the core of my collection", sets)).toBeUndefined();
    expect(inferSetFromText("CORE Charizard", sets)).toBe("core");
    expect(inferSetFromText("op01 Luffy", sets)).toBe("op01");
    expect(inferSetFromText("top012 Luffy", sets)).toBeUndefined();
  });

  it("finds name candidates in SQL exactly as scoring every catalog name would", async () => {
    const client = new PGlite();
    await client.exec(await readMigrationSql());
    const db = drizzle(client) as unknown as Database;
    const names = [
      "Greninja ex", "Greninja", "Pikachu", "Pikachu V", "Pikachu VMAX", "Charizard ex", "Charizard",
      "Blue-Eyes White Dragon", "Blue-Eyes Ultimate Dragon", "Dark Magician", "Monkey.D.Luffy",
      "Roronoa Zoro", "Son Goku", "Mew ex", "Mewtwo", "Nidoran ♀", "Nidoran ♂", "Flabébé", "Professor's Research",
      "Elemental HERO Shining Phoenix Enforcer", "N's Zoroark ex", "Iono", "Boss's Orders",
    ];
    const ids = new Map<string, string>();
    for (const [index, name] of names.entries()) {
      const concept = await insertTcgCardConcept(db, { gameKey: "pokemon", conceptKey: `c${index}`, canonicalName: name });
      ids.set(concept.id, name);
    }
    const aliased = await insertTcgCardConcept(db, { gameKey: "pokemon", conceptKey: "alias", canonicalName: "Greninja ex JP" });
    await insertTcgCardNameAlias(db, { cardId: aliased.id, language: "ja", name: "ゲッコウガex" });
    const queries = [
      "Grennja", "greninja", "GRENINJA EX", "pikachu", "Pikachu VMAX!!", "Charzard", "charizard ex 214",
      "Blue Eyes White Dragon", "blue-eyes", "Dark Magican", "Luffy", "monkey d luffy", "Zoro", "goku", "mew",
      "Nidoran", "Flabebe", "Professors Research", "ゲッコウガex", "ゲッコウガ", "🔥 Iono 🔥", "Iono🔥",
      "i would buy english twilight masquerade greninja 214 normal", "Boss Orders", "N Zoroark", "x",
    ];
    for (const query of queries) {
      const expected = new Set<string>();
      for (const [id, name] of ids) {
        if (normalizeMatchText(query) === normalizeMatchText(name) || nameSimilarity(query, name) >= FUZZY_PROBABLE_THRESHOLD) {
          expected.add(id);
        }
      }
      if (nameSimilarity(query, "Greninja ex JP") >= FUZZY_PROBABLE_THRESHOLD || nameSimilarity(query, "ゲッコウガex") >= FUZZY_PROBABLE_THRESHOLD) {
        expected.add(aliased.id);
      }
      expect(new Set(await findNameConcepts(db, query, "pokemon")), query).toEqual(expected);
    }
  });

  it("reads the set from the segment a mention was found in, ignoring prices and years there", async () => {
    const { db, seeded } = await setup();
    const ingested = await ingestSourceContentRecord(db, {
      provider: "youtube",
      provider_record_id: "seg_ctx_video",
      event_type: "source.content.ingested",
      account: { external_account_id: "seg_ctx_channel" },
      content: {
        external_content_id: "seg_ctx_video",
        content_type: "video",
        published_at: "2026-09-01T00:00:00Z",
        title: "Pikachu pickup",
        canonical_url: "https://www.youtube.com/watch?v=seg_ctx_video",
        license_status: "bounded_excerpt",
        retention_policy: "bounded_excerpt",
      },
      segments: [
        { kind: "timestamp_range", start_ref: "t=60", end_ref: "t=120", excerpt: "it was $40 in 2024, Pikachu 025 from Paldea Evolved" },
      ],
      mentions: [{ raw_entity_text: "Pikachu 025", segment_index: 0 }],
    });
    const [mention] = await listSourceMentions(db, ingested.contentId!);
    const resolved = await resolveSourceMention(db, mention!.id);
    expect(resolved.attempt.inputSignals).toMatchObject({ set: "sv2", collector_number: "025", card_name: "Pikachu 025" });
    expect(resolved.attempt.status).toBe("exact");
    expect(resolved.attempt.chosenPrintingId).toBe(seeded.printings.pikachuSv2.id);
  });

  it("blanks prices, percentages and years in segment context", () => {
    expect(withoutNonCollectorNumbers("worth $1,200 or 20% more in 2024, 15 dollars, #199")).toBe("worth or more in , , #199");
  });
});
