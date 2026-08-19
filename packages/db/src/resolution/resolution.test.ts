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
import { nameSimilarity, primaryScript } from "./identity.js";

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
});
