import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableColumns } from "drizzle-orm";
import {
  entity,
  observation,
  signal,
  featureSnapshot,
  decisionRecord,
} from "../schema/kernel.js";
import {
  getTcgGame,
  insertTcgPrinting,
  insertTcgPrintingIdentifier,
  insertTcgSet,
  listTcgGames,
  listTcgIdentifierConflicts,
  TcgIdentifierConflictError,
  TcgValidationError,
  ensureTcgPrintingEntity,
  member,
  organization,
  readMigrationSql,
  resolveTcgPrinting,
  seedTcgIdentityFixtures,
  tenant,
  user,
  withOrganizationContext,
  type Database,
} from "../index.js";

async function seedOrg(db: Database) {
  await db.insert(user).values({
    id: "user_tcg",
    name: "T",
    email: "t@example.com",
    emailVerified: true,
  });
  await db.insert(organization).values({ id: "org_tcg", name: "T", slug: "org-tcg" });
  await db.insert(member).values({
    id: "mem_tcg",
    organizationId: "org_tcg",
    userId: "user_tcg",
    role: "owner",
  });
  await db.insert(tenant).values({
    organizationId: "org_tcg",
    status: "active",
    createdByUserId: "user_tcg",
  });
}

describe("TCG catalog and resolution", () => {
  it("keeps TCG identity off generic kernel tables", () => {
    const forbidden = ["collectorNumber", "languageCode", "variantKey", "cardName", "setCode"];
    for (const table of [entity, observation, signal, featureSnapshot, decisionRecord]) {
      const columns = Object.keys(getTableColumns(table));
      for (const name of forbidden) {
        expect(columns).not.toContain(name);
      }
    }
  });

  it("separates languages, variants, sets, and maps TCC ids without silent rebind", async () => {
    const client = new PGlite();
    await client.exec(await readMigrationSql());
    const db = drizzle(client) as unknown as Database;
    await seedOrg(db);
    const games = await listTcgGames(db);
    expect(games.some((row) => row.gameKey === "pokemon")).toBe(true);
    expect(games.some((row) => row.gameKey === "one_piece")).toBe(true);
    expect((await getTcgGame(db, "pokemon"))?.displayName).toContain("Pokémon");
    expect((await getTcgGame(db, "one_piece"))?.displayName).toContain("One Piece");

    const firstSet = await insertTcgSet(db, {
      gameKey: "pokemon",
      canonicalSetKey: "twm",
      name: "Twilight Masquerade",
    });
    const replaySet = await insertTcgSet(db, {
      gameKey: "pokemon",
      canonicalSetKey: "twm",
      name: "Twilight Masquerade",
    });
    expect(firstSet.id).toBe(replaySet.id);

    const seeded = await seedTcgIdentityFixtures(db);
    expect(seeded.concepts.greninja.id).toBe(seeded.printings.greninjaEnNormal.cardId);
    expect(seeded.printings.greninjaEnNormal.id).not.toBe(seeded.printings.greninjaJaNormal.id);
    expect(seeded.printings.greninjaEnNormal.id).not.toBe(seeded.printings.greninjaZhNormal.id);
    expect(seeded.printings.greninjaJaNormal.id).not.toBe(seeded.printings.greninjaZhNormal.id);
    expect(seeded.printings.greninjaEnNormal.id).not.toBe(seeded.printings.greninjaEnHolo.id);
    expect(seeded.printings.greninjaEnHolo.id).not.toBe(seeded.printings.greninjaEnReverse.id);
    expect(seeded.printings.pikachuSv1.id).not.toBe(seeded.printings.pikachuSv2.id);
    expect(seeded.printings.charizardStandard.id).not.toBe(seeded.printings.charizardPromo.id);
    expect(seeded.printings.numbered.id).not.toBe(seeded.printings.numberedOtherSet.id);
    expect(seeded.printings.numbered.collectorNumber).toBe("174/172");
    expect(seeded.printings.trainerGallery.collectorNumber).toBe("TG05/TG30");
    expect(seeded.printings.padded.collectorNumber).toBe("031");
    expect(seeded.printings.luffyEn.collectorNumber).toBe("OP01-001");
    expect(seeded.printings.luffyEn.id).not.toBe(seeded.printings.luffyJa.id);

    await expect(
      insertTcgPrinting(db, {
        cardId: seeded.concepts.greninja.id,
        setId: seeded.sets.twm.id,
        gameKey: "pokemon",
        conceptKey: "greninja-ex",
        setKey: "twm",
        collectorNumber: "214/167",
        language: "jp",
        variantKey: "normal",
      }),
    ).rejects.toBeInstanceOf(TcgValidationError);

    const exact = await resolveTcgPrinting(db, {
      game: "pokemon",
      set: "twm",
      collector_number: "214/167",
      language: "en",
      variant: "normal",
    });
    expect(exact.status).toBe("exact");
    expect(exact.confidence).toBe(1);
    expect(exact.printingId).toBe(seeded.printings.greninjaEnNormal.id);

    const jaExact = await resolveTcgPrinting(db, {
      game: "pokemon",
      set: "twm",
      collector_number: "214/167",
      language: "ja",
      variant: "normal",
    });
    expect(jaExact.printingId).toBe(seeded.printings.greninjaJaNormal.id);

    const zhExact = await resolveTcgPrinting(db, {
      game: "pokemon",
      set: "twm",
      collector_number: "214/167",
      language: "zh-Hans",
      variant: "normal",
    });
    expect(zhExact.printingId).toBe(seeded.printings.greninjaZhNormal.id);

    const ambiguous = await resolveTcgPrinting(db, {
      game: "pokemon",
      set: "twm",
      collector_number: "214/167",
      language: "en",
    });
    expect(ambiguous.status).toBe("ambiguous");
    expect(ambiguous.confidence).toBeNull();
    expect(ambiguous.candidates.length).toBeGreaterThan(1);

    await expect(
      resolveTcgPrinting(db, {
        game: "pokemon",
        set: "twm",
        collector_number: "214/167",
      }),
    ).rejects.toBeInstanceOf(TcgValidationError);

    const missing = await resolveTcgPrinting(db, {
      game: "pokemon",
      set: "twm",
      collector_number: "999/999",
      language: "en",
      variant: "normal",
    });
    expect(missing.status).toBe("not_found");

    const byTcc = await resolveTcgPrinting(db, {
      external_id: {
        source_namespace: "tcg_card_central",
        identifier_type: "tcg_card_central_catalog_id",
        identifier_value: "tcc_twm_214_en_normal",
      },
    });
    expect(byTcc.printingId).toBe(seeded.printings.greninjaEnNormal.id);

    const sameBinding = await insertTcgPrintingIdentifier(db, {
      printingId: seeded.printings.greninjaEnNormal.id,
      sourceNamespace: "tcg_card_central",
      identifierType: "tcg_card_central_catalog_id",
      identifierValue: "tcc_twm_214_en_normal",
    });
    expect(sameBinding?.printingId).toBe(seeded.printings.greninjaEnNormal.id);

    await expect(
      insertTcgPrintingIdentifier(db, {
        printingId: seeded.printings.greninjaJaNormal.id,
        sourceNamespace: "tcg_card_central",
        identifierType: "tcg_card_central_catalog_id",
        identifierValue: "tcc_twm_214_en_normal",
      }),
    ).rejects.toBeInstanceOf(TcgIdentifierConflictError);
    const conflicts = await listTcgIdentifierConflicts(db);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.existingPrintingId).toBe(seeded.printings.greninjaEnNormal.id);
    expect(conflicts[0]?.attemptedPrintingId).toBe(seeded.printings.greninjaJaNormal.id);

    await withOrganizationContext(
      db,
      { organizationId: "org_tcg", userId: "user_tcg" },
      async (scoped) => {
        const first = await ensureTcgPrintingEntity(scoped, {
          organizationId: "org_tcg",
          printing: seeded.printings.greninjaEnNormal,
        });
        const replay = await ensureTcgPrintingEntity(scoped, {
          organizationId: "org_tcg",
          printing: seeded.printings.greninjaEnNormal,
        });
        expect(first.id).toBe(replay.id);
        expect(first.entityType).toBe("tcg_printing");
        expect(first.canonicalKey).toContain(seeded.printings.greninjaEnNormal.canonicalPrintingKey);
      },
    );
  });
});
