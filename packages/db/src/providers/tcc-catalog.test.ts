import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  extractCreatorCallsFromContent,
  ingestSourceContentRecord,
  listSourceMentions,
  readMigrationSql,
  resolveSourceMention,
  seedTcgIdentityFixtures,
  withPlatformContext,
  type Database,
} from "../index.js";
import type { SourceContentRecordInput } from "../source/identity.js";
import {
  catalogConceptKey,
  catalogLanguage,
  catalogSetKey,
  catalogVariant,
  importTccCatalog,
  latestTccCatalogCheckpoint,
  TCC_CATALOG_PATH,
  TCC_CATALOG_RESWEEP_MS,
} from "./tcc-catalog.js";
import type { HttpTransport } from "./transport.js";

const BASE_URL = "https://tcc.example.test";
const T0 = new Date("2026-03-01T00:00:00Z");

async function setup(options: { fixtures?: boolean } = {}) {
  const client = new PGlite();
  await client.exec(await readMigrationSql());
  const db = drizzle(client) as unknown as Database;
  if (options.fixtures) await seedTcgIdentityFixtures(db);
  return { client, db };
}

function uuid(n: number) {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

type FeedCard = {
  id: string;
  name: string;
  card_number: string | null;
  rarity: string | null;
  variant: string | null;
  languages: string[];
  set: { id: string; set_code: string; name: string; release_date: string | null };
};

const TWM = { id: uuid(9001), set_code: "twm", name: "Twilight Masquerade", release_date: "2024-05-24" };

function card(n: number, input: Partial<FeedCard> = {}): FeedCard {
  return {
    id: uuid(n),
    name: `Card ${n}`,
    card_number: `${n}/200`,
    rarity: "Common",
    variant: "normal",
    languages: ["en"],
    set: TWM,
    ...input,
  };
}

/** A fake TCC catalog feed: keyset pages by id, next_after while a page is full. */
function fakeFeed(catalog: Partial<Record<string, unknown[]>>, options: { failOn?: number } = {}) {
  const requests: { url: URL; authorization?: string }[] = [];
  const transport: HttpTransport = {
    async fetch(url, init) {
      const parsed = new URL(url);
      requests.push({ url: parsed, authorization: init?.headers?.authorization });
      if (options.failOn === requests.length) {
        return { status: 503, headers: {}, bodyText: JSON.stringify({ ok: false, error: "catalog_unavailable" }) };
      }
      const game = parsed.searchParams.get("game")!;
      const after = parsed.searchParams.get("after");
      const limit = Number(parsed.searchParams.get("limit"));
      const rows = (catalog[game] ?? []).filter(
        (row) => !after || String((row as { id?: unknown }).id ?? "") > after,
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1) as { id?: string } | undefined;
      return {
        status: 200,
        headers: {},
        bodyText: JSON.stringify({
          ok: true,
          game,
          cards: page,
          next_after: page.length === limit && last?.id ? last.id : null,
        }),
      };
    },
  };
  return { transport, requests };
}

async function count(client: PGlite, table: string) {
  const { rows } = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0]!.n;
}

describe("TCG Card Central catalog mapping", () => {
  it("maps TCC languages, variants, set codes and names onto exact identity", () => {
    expect(catalogLanguage("pokemon", "en")).toBe("en");
    expect(catalogLanguage("pokemon", "ja")).toBe("ja");
    expect(catalogLanguage("yugioh", "es")).toBe("es");
    expect(catalogLanguage("one_piece", "ko")).toBe("ko");
    // Pokémon "zh" mixes Simplified and Traditional sources, so it is never guessed.
    expect(catalogLanguage("pokemon", "zh")).toBeNull();
    expect(catalogLanguage("one_piece", "zh")).toBe("zh-Hant");
    expect(catalogLanguage("dragon_ball", "zh")).toBe("zh-Hant");
    expect(catalogLanguage("pokemon", "fr")).toBeNull();

    expect(catalogVariant(null)).toBe("normal");
    expect(catalogVariant("normal")).toBe("normal");
    expect(catalogVariant("holo")).toBe("holofoil");
    expect(catalogVariant("Holofoil")).toBe("holofoil");
    expect(catalogVariant("reverse")).toBe("reverse_holo");
    expect(catalogVariant("Reverse Holo")).toBe("reverse_holo");
    expect(catalogVariant("p1")).toBe("parallel");
    expect(catalogVariant("parallel")).toBe("parallel");
    expect(catalogVariant("alternate_art")).toBe("alt_art");
    expect(catalogVariant("1st Edition")).toBe("first_edition");
    expect(catalogVariant("manga")).toBe("special_finish");
    expect(catalogVariant("something new")).toBe("normal");

    expect(catalogSetKey("TWM")).toBe("twm");
    expect(catalogSetKey("sv03.5")).toBe("sv03-5");
    expect(catalogSetKey("OP-01")).toBe("op-01");
    expect(catalogSetKey("!!!")).toBeNull();

    expect(catalogConceptKey("Greninja ex")).toBe("greninja-ex");
    expect(catalogConceptKey("Flabébé")).toBe("flabebe");
    expect(catalogConceptKey("Nidoran ♀")).not.toBe(catalogConceptKey("Nidoran ♂"));
    expect(catalogConceptKey("ゲッコウガex")).toMatch(/^ex-[0-9a-f]{16}$/);
    expect(catalogConceptKey("甲贺忍蛙")).toMatch(/^tcc-[0-9a-f]{16}$/);
  });
});

describe("TCG Card Central catalog import", () => {
  it("pages through every game and imports one printing per supported language", async () => {
    const { client, db } = await setup();
    const op01 = { id: uuid(9101), set_code: "OP01", name: "Romance Dawn", release_date: "2022-12-02" };
    const fb01 = { id: uuid(9201), set_code: "FB01", name: "Awakened Pulse", release_date: null };
    const lob = { id: uuid(9301), set_code: "LOB", name: "Legend of Blue Eyes White Dragon", release_date: "2002-03-08" };
    const feed = fakeFeed({
      pokemon: [
        card(1, { name: "Greninja ex", card_number: "214/167", variant: "holo", languages: ["en", "ja"] }),
        card(2, { name: "Pikachu", card_number: "001", variant: "reverse", languages: ["en"] }),
        card(3, { name: "Pikachu", card_number: "002", languages: ["zh"] }),
      ],
      onepiece: [card(11, { name: "Monkey.D.Luffy", card_number: "OP01-001", variant: "p1", languages: ["en", "zh"], set: op01 })],
      dragonball: [card(21, { name: "Son Goku", card_number: "FB01-001", variant: "alternate_art", languages: ["ja"], set: fb01 })],
      yugioh: [card(31, { name: "Blue-Eyes White Dragon", card_number: "LOB-001", variant: null, languages: ["en", "es"], set: lob })],
    });

    const report = await importTccCatalog(db, {
      baseUrl: `${BASE_URL}/`,
      token: "fixture-token",
      transport: feed.transport,
      now: T0,
      pageSize: 2,
    });

    // Pokémon needs two pages (2 + 1 cards); each other game one page.
    expect(feed.requests.map((row) => [row.url.searchParams.get("game"), row.url.searchParams.get("after")])).toEqual([
      ["pokemon", null],
      ["pokemon", uuid(2)],
      ["onepiece", null],
      ["dragonball", null],
      ["yugioh", null],
    ]);
    expect(feed.requests[0]!.url.pathname).toBe(TCC_CATALOG_PATH);
    expect(feed.requests[0]!.url.searchParams.get("limit")).toBe("2");
    expect(feed.requests.every((row) => row.authorization === "Bearer fixture-token")).toBe(true);
    expect(report).toMatchObject({
      status: "completed",
      requests: 5,
      cards: 6,
      printings: 8,
      sets: 4,
      unsupportedLanguage: 1,
      malformed: 0,
      collisions: 0,
      sweepComplete: true,
    });

    const { rows } = await client.query<{
      game_key: string;
      set_key: string;
      name: string;
      collector_number: string;
      language_code: string;
      variant_key: string;
      identifier: string;
    }>(`
      SELECT p.game_key, s.canonical_set_key AS set_key, c.canonical_name AS name, p.collector_number,
             p.language_code, p.variant_key, i.identifier_value AS identifier
      FROM tcg_printing p
      JOIN tcg_set s ON s.id = p.set_id
      JOIN tcg_card_concept c ON c.id = p.card_id
      JOIN tcg_printing_identifier i ON i.printing_id = p.id AND i.identifier_type = 'tcg_card_central_catalog_id'
      ORDER BY i.identifier_value
    `);
    expect(rows).toEqual([
      { game_key: "pokemon", set_key: "twm", name: "Greninja ex", collector_number: "214/167", language_code: "en", variant_key: "holofoil", identifier: `${uuid(1)}:en` },
      { game_key: "pokemon", set_key: "twm", name: "Greninja ex", collector_number: "214/167", language_code: "ja", variant_key: "holofoil", identifier: `${uuid(1)}:ja` },
      { game_key: "pokemon", set_key: "twm", name: "Pikachu", collector_number: "001", language_code: "en", variant_key: "reverse_holo", identifier: `${uuid(2)}:en` },
      { game_key: "one_piece", set_key: "op01", name: "Monkey.D.Luffy", collector_number: "OP01-001", language_code: "en", variant_key: "parallel", identifier: `${uuid(11)}:en` },
      { game_key: "one_piece", set_key: "op01", name: "Monkey.D.Luffy", collector_number: "OP01-001", language_code: "zh-Hant", variant_key: "parallel", identifier: `${uuid(11)}:zh-Hant` },
      { game_key: "dragon_ball", set_key: "fb01", name: "Son Goku", collector_number: "FB01-001", language_code: "ja", variant_key: "alt_art", identifier: `${uuid(21)}:ja` },
      { game_key: "yugioh", set_key: "lob", name: "Blue-Eyes White Dragon", collector_number: "LOB-001", language_code: "en", variant_key: "normal", identifier: `${uuid(31)}:en` },
      { game_key: "yugioh", set_key: "lob", name: "Blue-Eyes White Dragon", collector_number: "LOB-001", language_code: "es", variant_key: "normal", identifier: `${uuid(31)}:es` },
    ]);
    // The Pokémon "zh" card has no printing at all.
    expect(await count(client, "tcg_printing")).toBe(8);
    const { rows: sets } = await client.query<{ canonical_set_key: string; release_date: string | null; language_scope: string }>(
      `SELECT canonical_set_key, release_date::text, language_scope FROM tcg_set ORDER BY canonical_set_key`,
    );
    expect(sets).toEqual([
      { canonical_set_key: "fb01", release_date: null, language_scope: "ja" },
      { canonical_set_key: "lob", release_date: "2002-03-08", language_scope: "multi" },
      { canonical_set_key: "op01", release_date: "2022-12-02", language_scope: "multi" },
      { canonical_set_key: "twm", release_date: "2024-05-24", language_scope: "multi" },
    ]);
    // The run is recorded with every game's cursor.
    const checkpoint = await latestTccCatalogCheckpoint(db);
    expect(checkpoint?.sweep_completed_at).toBe(T0.toISOString());
    expect(checkpoint?.games.pokemon).toEqual({ after: uuid(2), done: true });
  });

  it("bounds requests per run, resumes from the stored cursor and re-sweeps once a day", async () => {
    const { client, db } = await setup();
    const feed = fakeFeed({ pokemon: [card(1), card(2), card(3)], onepiece: [card(11)] });
    const run = (now: Date) =>
      importTccCatalog(db, { baseUrl: BASE_URL, token: "t", transport: feed.transport, now, pageSize: 1, maxRequests: 2 });

    const first = await run(T0);
    expect(first).toMatchObject({ status: "completed", requests: 2, printings: 2, sweepComplete: false });
    expect(feed.requests.map((row) => row.url.searchParams.get("after"))).toEqual([null, uuid(1)]);

    // The next run continues after card 2, finishes Pokémon (an empty last page) and starts One Piece.
    const second = await run(new Date(T0.getTime() + 60_000));
    expect(second).toMatchObject({ requests: 2, printings: 1, sweepComplete: false });
    expect(feed.requests.slice(2).map((row) => [row.url.searchParams.get("game"), row.url.searchParams.get("after")])).toEqual([
      ["pokemon", uuid(2)],
      ["pokemon", uuid(3)],
    ]);
    const third = await run(new Date(T0.getTime() + 120_000));
    const fourth = await run(new Date(T0.getTime() + 180_000));
    expect(third.sweepComplete || fourth.sweepComplete).toBe(true);
    expect(await count(client, "tcg_printing")).toBe(4);

    // A full pass is not repeated within a day...
    const requestsSoFar = feed.requests.length;
    const finishedAt = new Date((await latestTccCatalogCheckpoint(db))!.sweep_completed_at!);
    const early = await run(new Date(finishedAt.getTime() + TCC_CATALOG_RESWEEP_MS - 1));
    expect(early).toMatchObject({ status: "skipped", reason: "up_to_date", requests: 0 });
    expect(feed.requests).toHaveLength(requestsSoFar);

    // ...after that a new pass starts from the beginning.
    const later = await run(new Date(finishedAt.getTime() + TCC_CATALOG_RESWEEP_MS));
    expect(later.requests).toBe(2);
    expect(feed.requests[requestsSoFar]!.url.searchParams.get("after")).toBeNull();
    expect(later).toMatchObject({ printings: 0, alreadyImported: 2 });
  });

  it("is idempotent: a second pass adds nothing and never changes existing rows", async () => {
    const { client, db } = await setup({ fixtures: true });
    const catalog = {
      pokemon: [
        // Same identity as the fixture Greninja ex (twm 214/167 en normal), under a different set name.
        card(1, { name: "Greninja ex", card_number: "214/167", variant: null, set: { ...TWM, name: "SV06: Twilight Masquerade" } }),
        card(2, { name: "Pikachu", card_number: "050", languages: ["en", "ja"] }),
      ],
    };
    const feed = fakeFeed(catalog);
    const tables = ["tcg_set", "tcg_card_concept", "tcg_printing", "tcg_printing_identifier", "tcg_identifier_conflict"];

    const first = await importTccCatalog(db, { baseUrl: BASE_URL, token: "t", transport: feed.transport, now: T0 });
    expect(first).toMatchObject({ printings: 3, sets: 0, collisions: 0, conflicts: 0 });
    const before = await Promise.all(tables.map((table) => count(client, table)));
    const { rows: setBefore } = await client.query(`SELECT * FROM tcg_set ORDER BY id`);

    const again = await importTccCatalog(db, {
      baseUrl: BASE_URL,
      token: "t",
      transport: feed.transport,
      now: new Date(T0.getTime() + TCC_CATALOG_RESWEEP_MS + 1),
    });
    expect(again).toMatchObject({ status: "completed", printings: 0, alreadyImported: 3, sets: 0 });
    expect(await Promise.all(tables.map((table) => count(client, table)))).toEqual(before);
    const { rows: setAfter } = await client.query(`SELECT * FROM tcg_set ORDER BY id`);
    expect(setAfter).toEqual(setBefore);
    // The fixture printing kept its name and set, and now also carries the TCC id.
    const { rows } = await client.query<{ identifier_value: string }>(`
      SELECT i.identifier_value FROM tcg_printing_identifier i
      JOIN tcg_printing p ON p.id = i.printing_id
      WHERE p.canonical_printing_key = 'tcg:pokemon:greninja-ex:twm:214/167:en:normal'
      ORDER BY i.identifier_value
    `);
    expect(rows.map((row) => row.identifier_value)).toEqual([`${uuid(1)}:en`, "tcc_twm_214_en_normal"]);
    const { rows: names } = await client.query<{ name: string }>(`SELECT name FROM tcg_set WHERE canonical_set_key = 'twm'`);
    expect(names[0]!.name).toBe("Twilight Masquerade");
  });

  it("skips and counts malformed rows and identity collisions without failing the run", async () => {
    const { client, db } = await setup();
    const feed = fakeFeed({
      pokemon: [
        card(1, { name: "Charizard ex", card_number: "006/198" }),
        // An unknown variant becomes "normal" and would be the same printing as card 1: never merged.
        card(2, { name: "Charizard ex", card_number: "006/198", variant: "mystery finish" }),
        // A different card on the same set, number, language and variant: not merged either.
        card(3, { name: "Charizard", card_number: "006/198" }),
        card(4, { name: "" }),
        card(5, { card_number: null }),
        card(6, { set: { ...TWM, set_code: "!!!" } }),
        card(7, { languages: "en" as unknown as string[] }),
        { ...card(8), id: "not-a-uuid" },
        { ...card(9), set: null },
        card(10, { name: "Pikachu", card_number: "025/198", set: { ...TWM, release_date: "2024-13-45" } }),
      ],
    });
    const report = await importTccCatalog(db, { baseUrl: BASE_URL, token: "t", transport: feed.transport, now: T0 });
    expect(report).toMatchObject({ status: "completed", cards: 10, printings: 2, malformed: 6, collisions: 2, rejected: 0 });
    expect(await count(client, "tcg_printing")).toBe(2);
  });

  it("keeps the progress of pages read before a failed request", async () => {
    const { db } = await setup();
    const feed = fakeFeed({ pokemon: [card(1), card(2), card(3)] }, { failOn: 2 });
    const failed = await importTccCatalog(db, { baseUrl: BASE_URL, token: "t", transport: feed.transport, now: T0, pageSize: 1 });
    expect(failed).toMatchObject({ status: "failed", reason: "upstream_5xx", requests: 2, printings: 1 });
    expect((await latestTccCatalogCheckpoint(db))?.games.pokemon).toEqual({ after: uuid(1), done: false });

    const resumed = await importTccCatalog(db, { baseUrl: BASE_URL, token: "t", transport: feed.transport, now: T0, pageSize: 1 });
    expect(resumed.status).toBe("completed");
    expect(feed.requests[2]!.url.searchParams.get("after")).toBe(uuid(1));
  });

  it("refuses a payload that does not match the request", async () => {
    const { db } = await setup();
    const transport: HttpTransport = {
      async fetch() {
        return { status: 200, headers: {}, bodyText: JSON.stringify({ ok: true, game: "yugioh", cards: [], next_after: null }) };
      },
    };
    const report = await importTccCatalog(db, { baseUrl: BASE_URL, token: "t", transport, now: T0 });
    expect(report).toMatchObject({ status: "failed", reason: "invalid_payload", requests: 1, printings: 0 });
  });

  it("skips while the operator has paused TCG Card Central", async () => {
    const { client, db } = await setup();
    const feed = fakeFeed({ pokemon: [card(1)] });
    await client.exec(`UPDATE provider_runtime SET paused = true WHERE provider_key = 'tcg_card_central'`);
    const paused = await importTccCatalog(db, { baseUrl: BASE_URL, token: "t", transport: feed.transport, now: T0 });
    expect(paused).toMatchObject({ status: "skipped", reason: "paused", requests: 0 });
    await client.exec(`UPDATE provider_runtime SET paused = false WHERE provider_key = 'tcg_card_central'`);

    // As the worker runs it: system principal, transaction-scoped lock.
    const imported = await withPlatformContext(db, (scoped) =>
      importTccCatalog(scoped, { baseUrl: BASE_URL, token: "t", transport: feed.transport, now: T0, exclusive: true }),
    );
    expect(imported).toMatchObject({ status: "completed", printings: 1 });
    // One page per game.
    expect(feed.requests).toHaveLength(4);
  });

  it("accepts catalog inserts only from the system principal", async () => {
    const { client } = await setup();
    const insert = `INSERT INTO tcg_set (id, game_key, canonical_set_key, name) VALUES ('set_x', 'pokemon', 'x', 'X')`;
    await expect(
      client.transaction(async (tx) => {
        await tx.query(`SELECT set_config('app.current_principal_type', 'user', true)`);
        await tx.query(insert);
      }),
    ).rejects.toThrow(/system principal/);
    await client.transaction(async (tx) => {
      await tx.query(`SELECT set_config('app.current_principal_type', 'system', true)`);
      await tx.query(insert);
    });
    expect(await count(client, "tcg_set")).toBe(1);
    await expect(client.query(`UPDATE tcg_set SET name = 'Y' WHERE id = 'set_x'`)).rejects.toThrow(/immutable/);
  });

  it("lets a creator post naming an imported card resolve to that printing", async () => {
    const { client, db } = await setup();
    const feed = fakeFeed({
      pokemon: [
        card(1, { name: "Greninja ex", card_number: "214/167", rarity: "Special Illustration Rare", variant: "holo" }),
        card(2, { name: "Pikachu", card_number: "025/167" }),
      ],
    });
    await importTccCatalog(db, { baseUrl: BASE_URL, token: "t", transport: feed.transport, now: T0 });

    const title = "Greninja ex 214/167 Twilight Masquerade, buying now";
    const post: SourceContentRecordInput = {
      provider: "youtube",
      provider_record_id: "yt_tcc_greninja",
      event_type: "source.content.ingested",
      account: {
        external_account_id: "yt_ch_tcc",
        handle: "CatalogTCG",
        display_name: "Catalog TCG",
        canonical_url: "https://youtube.com/@catalogtcg",
      },
      content: {
        external_content_id: "yt_tcc_greninja",
        content_type: "video",
        published_at: "2026-03-02T12:00:00.000Z",
        title,
        summary: "Buy it before it goes up.",
        canonical_url: "https://youtube.com/watch?v=yt_tcc_greninja",
        language: "en",
      },
      // What the YouTube normalizer sends: the title as the mention.
      mentions: [{ raw_entity_text: title, mention_context: "other" }],
    };
    const ingested = await ingestSourceContentRecord(db, post);
    const [mention] = await listSourceMentions(db, ingested.contentId!);
    const resolved = await resolveSourceMention(db, mention!.id);
    const { rows } = await client.query<{ id: string }>(
      `SELECT printing_id AS id FROM tcg_printing_identifier WHERE identifier_value = $1`,
      [`${uuid(1)}:en`],
    );
    expect(resolved.attempt.status).toBe("exact");
    expect(resolved.attempt.chosenPrintingId).toBe(rows[0]!.id);
    expect(resolved.attempt.inputSignals).toMatchObject({ set: "twm", collector_number: "214/167" });

    const [call] = await extractCreatorCallsFromContent(db, ingested.contentId!);
    expect(call).toMatchObject({ status: "processed" });
    expect((call as { call?: { printingId: string | null } }).call?.printingId).toBe(rows[0]!.id);
  });

  it("imports a full page in a few statements rather than several per card", async () => {
    const { client } = await setup();
    const cards = Array.from({ length: 1000 }, (_, i) =>
      card(i + 1, { languages: i % 2 ? ["en", "ja"] : ["en"], set: i < 500 ? TWM : { ...TWM, id: uuid(9002), set_code: "sfa", name: "Shrouded Fable" } }),
    );
    const feed = fakeFeed({ pokemon: cards });
    // Count every statement, including those run inside transactions and savepoints.
    let statements = 0;
    const counted = <T extends { query: (...args: never[]) => unknown }>(target: T) =>
      new Proxy(target, {
        get(object, property, receiver) {
          const value = Reflect.get(object, property, receiver);
          if (property === "query") {
            return (...args: never[]) => {
              statements += 1;
              return (value as (...a: never[]) => unknown).apply(object, args);
            };
          }
          if (property === "transaction") {
            return (callback: (tx: T) => unknown) =>
              (value as (cb: (tx: T) => unknown) => unknown).call(object, (tx: T) => callback(counted(tx)));
          }
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
    const countedDb = drizzle(counted(client)) as unknown as Database;
    const report = await importTccCatalog(countedDb, {
      baseUrl: BASE_URL,
      token: "t",
      transport: feed.transport,
      now: T0,
      maxRequests: 1,
    });
    expect(report).toMatchObject({ status: "completed", cards: 1000, printings: 1500, sets: 2, collisions: 0, rejected: 0 });
    expect(await count(client, "tcg_printing")).toBe(1500);
    expect(statements).toBeLessThan(40);
  });
});
