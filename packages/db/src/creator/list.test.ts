import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../client.js";
import { readMigrationSql } from "../migrations.js";
import { recordCreatorTrust } from "./authority.js";
import {
  CreatorHandleError,
  listHiddenCreatorIds,
  listTenantCreatorList,
  parseCreatorHandle,
  promoteFollowedCreators,
  removeFromCreatorList,
  requestCreatorFollow,
  resolvePendingCreatorFollows,
  setCreatorPreference,
} from "./list.js";
import type { HttpResponse, HttpTransport } from "../providers/transport.js";

const ok = (json: unknown): HttpResponse => ({ status: 200, headers: {}, bodyText: JSON.stringify(json) });
const youtubeEnv = { ISP_ENV: "test", PROVIDER_YOUTUBE_MODE: "live", YOUTUBE_API_KEY: "unit-test-secret" };
const CHANNEL = "UCabcdefghijklmnopqrstuv";

describe("parsing what people paste", () => {
  it("accepts channel and profile links, handles and IDs", () => {
    expect(parseCreatorHandle("https://www.youtube.com/@PokeRev")).toEqual({ platform: "youtube", handle: "@pokerev" });
    expect(parseCreatorHandle("youtube.com/channel/UCabcdefghijklmnopqrstuv")).toEqual({ platform: "youtube", handle: CHANNEL });
    expect(parseCreatorHandle("https://m.youtube.com/@poke.rev/videos")).toEqual({ platform: "youtube", handle: "@poke.rev" });
    expect(parseCreatorHandle("https://old.reddit.com/user/Card_Guy/")).toEqual({ platform: "reddit", handle: "Card_Guy" });
    expect(parseCreatorHandle("u/card_guy")).toEqual({ platform: "reddit", handle: "card_guy" });
    expect(parseCreatorHandle("card_guy", "reddit")).toEqual({ platform: "reddit", handle: "card_guy" });
    expect(parseCreatorHandle("pokerev", "youtube")).toEqual({ platform: "youtube", handle: "@pokerev" });
  });

  it("rejects links it cannot resolve without a search", () => {
    expect(() => parseCreatorHandle("https://youtube.com/c/OldCustomName")).toThrow(CreatorHandleError);
    expect(() => parseCreatorHandle("https://twitter.com/someone")).toThrow(CreatorHandleError);
    expect(() => parseCreatorHandle("https://reddit.com/r/PokemonTCG")).toThrow(CreatorHandleError);
    expect(() => parseCreatorHandle("")).toThrow(CreatorHandleError);
  });
});

describe("workspace influencer list", () => {
  let client: PGlite;
  let db: Database;
  const org = "org_list_a";
  const user = "user_list_a";

  beforeAll(async () => {
    client = new PGlite();
    await client.exec(await readMigrationSql());
    db = drizzle(client) as unknown as Database;
    await client.exec(`
      INSERT INTO "user" (id, name, email) VALUES ('${user}', 'A', 'a@example.test');
      INSERT INTO organization (id, name, slug) VALUES ('${org}', 'A', 'list-a');
      UPDATE provider_runtime SET mode='live', enabled=true, paused=false, credential_status='present' WHERE provider_key='youtube';
    `);
  }, 30_000);
  afterAll(async () => {
    await client?.close();
  });

  const youtube = (respond: (u: URL) => HttpResponse): HttpTransport => ({
    fetch: vi.fn(async (url: string) => respond(new URL(url))),
  });

  it("queues an unknown handle, resolves it with one data request and starts monitoring", async () => {
    const queued = await requestCreatorFollow(db, { organizationId: org, userId: user, input: "youtube.com/@PokeRev" });
    expect(queued.status).toBe("pending");
    const again = await requestCreatorFollow(db, { organizationId: org, userId: user, input: "@pokerev", platform: "youtube" });
    expect(again).toMatchObject({ id: queued.id, created: false });

    const http = youtube((u) => {
      expect(u.pathname).toBe("/youtube/v3/channels");
      expect(u.searchParams.get("forHandle")).toBe("@pokerev");
      return ok({ items: [{ id: CHANNEL, snippet: { title: "Poke Rev", customUrl: "@pokerev" } }] });
    });
    const report = await resolvePendingCreatorFollows(db, { providerKey: "youtube", env: youtubeEnv, transport: http });
    expect(report).toMatchObject({ status: "completed", resolved: 1, requests: 1 });
    expect(http.fetch).toHaveBeenCalledTimes(1);

    const [row] = await listTenantCreatorList(db);
    expect(row).toMatchObject({ status: "resolved", preference: "follow", creatorName: "Poke Rev" });
    const monitored = await client.query<{ relevance_state: string; discovery_provenance: Record<string, unknown> }>(
      `SELECT relevance_state, discovery_provenance FROM discovered_creator WHERE external_account_id = $1`,
      [CHANNEL],
    );
    expect(monitored.rows[0]?.relevance_state).toBe("monitored");
    expect(monitored.rows[0]?.discovery_provenance.followed_by_workspace).toBe(true);
    // Following never creates authority or trust evidence.
    const slices = await client.query(`SELECT 1 FROM creator_authority_slice WHERE creator_id = $1`, [row!.creatorId]);
    expect(slices.rows).toHaveLength(0);

    // A channel ID the platform already knows resolves without any request.
    await removeFromCreatorList(db, row!.id);
    const direct = await requestCreatorFollow(db, { organizationId: org, userId: user, input: `youtube.com/channel/${CHANNEL}` });
    expect(direct.status).toBe("resolved");
  });

  it("marks a handle YouTube does not know as not found and lets the person retry", async () => {
    const queued = await requestCreatorFollow(db, { organizationId: org, userId: user, input: "@nobodyhere", platform: "youtube" });
    const report = await resolvePendingCreatorFollows(db, {
      providerKey: "youtube",
      env: youtubeEnv,
      transport: youtube(() => ok({ items: [] })),
    });
    expect(report.notFound).toBe(1);
    const row = (await listTenantCreatorList(db)).find((item) => item.id === queued.id);
    expect(row?.status).toBe("not_found");
    const retried = await requestCreatorFollow(db, { organizationId: org, userId: user, input: "@nobodyhere", platform: "youtube" });
    expect(retried.status).toBe("pending");
    await removeFromCreatorList(db, queued.id);
  });

  it("never overrides an operator exclusion", async () => {
    const queued = await requestCreatorFollow(db, { organizationId: org, userId: user, input: "@excludedone", platform: "youtube" });
    const excludedChannel = "UCzzzzzzzzzzzzzzzzzzzzzz";
    await client.exec(`
      INSERT INTO source_account (id, source_type, external_account_id, display_name, first_seen_at, last_seen_at)
      VALUES ('sac_excluded', 'youtube', '${excludedChannel}', 'Excluded', now(), now());
      INSERT INTO creator (id, display_name) VALUES ('cr_excluded', 'Excluded');
      INSERT INTO creator_source_account (id, creator_id, source_account_id) VALUES ('csa_excluded', 'cr_excluded', 'sac_excluded');
    `);
    await recordCreatorTrust(db, { creatorId: "cr_excluded", trustState: "excluded", reason: "operator test" });
    const report = await resolvePendingCreatorFollows(db, {
      providerKey: "youtube",
      env: youtubeEnv,
      transport: youtube(() => ok({ items: [{ id: excludedChannel, snippet: { title: "Excluded" } }] })),
    });
    expect(report.blocked).toBe(1);
    const row = (await listTenantCreatorList(db)).find((item) => item.id === queued.id);
    expect(row).toMatchObject({ status: "blocked", creatorId: null });
    const monitored = await client.query(`SELECT 1 FROM discovered_creator WHERE external_account_id = $1`, [excludedChannel]);
    expect(monitored.rows).toHaveLength(0);
  });

  it("hides a creator for this workspace only and keeps followed ones monitored", async () => {
    const [followed] = (await listTenantCreatorList(db)).filter((row) => row.status === "resolved");
    await setCreatorPreference(db, { organizationId: org, userId: user, creatorId: followed!.creatorId!, preference: "hide" });
    expect(await listHiddenCreatorIds(db)).toEqual([followed!.creatorId]);
    await setCreatorPreference(db, { organizationId: org, userId: user, creatorId: followed!.creatorId!, preference: "follow" });
    expect(await listHiddenCreatorIds(db)).toEqual([]);

    await client.query(`UPDATE discovered_creator SET relevance_state = 'candidate' WHERE external_account_id = $1`, [CHANNEL]);
    expect(await promoteFollowedCreators(db, "youtube")).toBe(1);
    const state = await client.query<{ relevance_state: string }>(
      `SELECT relevance_state FROM discovered_creator WHERE external_account_id = $1`,
      [CHANNEL],
    );
    expect(state.rows[0]?.relevance_state).toBe("monitored");
  });

  it("does nothing while the provider is not live", async () => {
    const report = await resolvePendingCreatorFollows(db, { providerKey: "reddit", env: { ISP_ENV: "test" } });
    expect(report).toMatchObject({ status: "skipped", requests: 0 });
  });
});
