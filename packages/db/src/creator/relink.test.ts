import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import {
  evaluateCreatorCallOutcome,
  extractCreatorCallsFromContent,
  ingestSourceContentRecord,
  ingestTcgMarketRecord,
  readMigrationSql,
  relinkUnboundCalls,
  seedTcgIdentityFixtures,
  tcgMarketFixtureRecords,
  withPlatformContext,
  type Database,
} from "../index.js";
import { headlinePrintingOf } from "./authority.js";

async function setup() {
  const client = new PGlite();
  await client.exec(await readMigrationSql());
  const db = drizzle(client) as unknown as Database;
  const seeded = await seedTcgIdentityFixtures(db);
  for (const record of tcgMarketFixtureRecords()) {
    await ingestTcgMarketRecord(db, record);
  }
  return { db, seeded };
}

function cardOnlyPost(id: string, excerpt: string, title = "Opening packs every day") {
  return {
    provider: "youtube" as const,
    provider_record_id: id,
    event_type: "source.content.ingested" as const,
    account: { external_account_id: "yt_ch_relink", handle: "Relink", display_name: "Relink TCG" },
    content: {
      external_content_id: id,
      content_type: "video" as const,
      published_at: "2026-01-02T12:00:00.000Z",
      title,
      canonical_url: `https://youtube.com/watch?v=${id}`,
      language: "en",
      excerpt,
    },
    segments: [{ kind: "timestamp_range" as const, start_ref: "00:01:00", end_ref: "00:01:20", excerpt }],
    mentions: [{ raw_entity_text: "Greninja", mention_context: "recommendation", candidate_direction: "bullish", segment_index: 0 }],
  };
}

describe("grading calls that name a card but not its printing", () => {
  it("grades a card-only call on the card's headline printing and records which one", async () => {
    const { db, seeded } = await setup();
    const post = await ingestSourceContentRecord(
      db,
      cardOnlyPost("yt_day50", "Day 50 of opening packs. I would buy Greninja, this will go up in 30 days."),
    );
    const [extracted] = await extractCreatorCallsFromContent(db, post.contentId!);
    const call = extracted!.call!;
    expect(call.conceptId).toBe(seeded.concepts.greninja.id);
    // The card's English printings: the pricier one (95 at the post) is the
    // headline. Give it a closing price a month later.
    await db.execute(sql`
      INSERT INTO tcg_market_snapshot (id, printing_id, source_key, market_type, price_type, observed_at, currency, condition, price, source_record_id, fingerprint)
      VALUES ('relink_close', ${seeded.printings.greninjaEnHolo.id}, 'tcg_card_central', 'market_price', 'reference', '2026-01-31T00:00:00Z', 'USD', 'nm', 120, 'relink_close', 'relink_close')
    `);
    const outcome = await evaluateCreatorCallOutcome(db, call.id, new Date("2026-06-01T00:00:00.000Z"));
    expect(outcome?.evaluationStatus).toBe("evaluated");
    if (!call.printingId) {
      // Never a Japanese or Chinese printing for an English post.
      expect(headlinePrintingOf(outcome?.dataQuality)).toBe(seeded.printings.greninjaEnHolo.id);
    }
  });

  it("relinks an old unbound call by writing a revision, and marks title-only talk as general", async () => {
    const { db } = await setup();
    const post = await ingestSourceContentRecord(
      db,
      cardOnlyPost("yt_old", "Day 50 of opening packs. I would buy Greninja, this will go up in 30 days."),
    );
    const [extracted] = await extractCreatorCallsFromContent(db, post.contentId!);
    const original = extracted!.call!;
    // Make the call look like an older resolver left it unbound.
    await db.execute(sql`ALTER TABLE creator_call DISABLE TRIGGER creator_call_immutable`);
    await db.execute(sql`UPDATE creator_call SET printing_id = NULL, concept_id = NULL, resolution_status = 'unresolved' WHERE id = ${original.id}`);
    await db.execute(sql`ALTER TABLE creator_call ENABLE TRIGGER creator_call_immutable`);
    await db.execute(sql`ALTER TABLE entity_resolution_attempt DISABLE TRIGGER entity_resolution_attempt_immutable`);
    await db.execute(sql`UPDATE entity_resolution_attempt SET resolver_version = 'resolver.v1' WHERE mention_id = ${original.mentionId}`);
    await db.execute(sql`ALTER TABLE entity_resolution_attempt ENABLE TRIGGER entity_resolution_attempt_immutable`);
    await db.execute(sql`UPDATE creator_call_outcome SET evaluation_status = 'insufficient_data', data_quality = 'missing_identity_price_or_horizon' WHERE call_id = ${original.id}`);

    const report = await relinkUnboundCalls(db, { now: new Date("2026-06-01T00:00:00.000Z") });
    expect(report.considered).toBe(1);
    expect(report.bound + report.cardOnly).toBe(1);
    const revisions = await withPlatformContext(db, async (tx) =>
      (await tx.execute(sql`SELECT id, concept_id FROM creator_call WHERE revises_call_id = ${original.id}`)) as unknown,
    );
    const rows = Array.isArray(revisions) ? revisions : (revisions as { rows: unknown[] }).rows;
    expect(rows).toHaveLength(1);

    // A second run finds nothing left to relink.
    const again = await relinkUnboundCalls(db, { now: new Date("2026-06-01T00:00:00.000Z") });
    expect(again.considered).toBe(0);
  });
});
