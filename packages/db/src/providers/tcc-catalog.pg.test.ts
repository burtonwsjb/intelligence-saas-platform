import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import {
  applyMigrations,
  assertDisposableAdminUrl,
  bootstrapRoles,
  createDbConnection,
  DB_ROLES,
  replaceConnectionRole,
  requireDatabaseAdminUrl,
  testRolePasswords,
  withOrganizationContext,
  withPlatformContext,
} from "../index.js";
import { importTccCatalog } from "./tcc-catalog.js";
import type { HttpTransport } from "./transport.js";

// The worker role may add catalog rows as the system principal and nothing
// more: no updates, no deletes, no inserts from a tenant context, and the web
// role still cannot write the catalog at all.
describe("TCG Card Central catalog import on PostgreSQL", () => {
  const passwords = testRolePasswords();
  const name = `tcc_catalog_${randomUUID().replaceAll("-", "")}`;
  let root: ReturnType<typeof postgres>;
  let created = false;
  let target = "";
  let workerConn: ReturnType<typeof createDbConnection> | undefined;

  beforeAll(async () => {
    const adminUrl = requireDatabaseAdminUrl();
    assertDisposableAdminUrl(adminUrl);
    root = postgres(adminUrl, { max: 1, prepare: false, onnotice: () => undefined });
    await root.unsafe(`CREATE DATABASE "${name}"`);
    created = true;
    const url = new URL(adminUrl);
    url.pathname = `/${name}`;
    target = url.toString();
    await applyMigrations(target);
    await bootstrapRoles(target, passwords);
    const seed = postgres(target, { max: 1, prepare: false, onnotice: () => undefined });
    await seed.unsafe(`
      INSERT INTO "user" (id, name, email, email_verified) VALUES ('u_a', 'A', 'a@example.test', true);
      INSERT INTO organization (id, name, slug) VALUES ('o_a', 'A', 'o-a');
      INSERT INTO member (id, organization_id, user_id, role) VALUES ('m_a', 'o_a', 'u_a', 'owner');
      INSERT INTO tenant (organization_id, status, created_by_user_id) VALUES ('o_a', 'active', 'u_a');
    `);
    await seed.end({ timeout: 5 });
    workerConn = createDbConnection(replaceConnectionRole(target, DB_ROLES.worker, passwords.worker));
  }, 120_000);

  afterAll(async () => {
    await workerConn?.end();
    if (created) await root.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
    await root?.end({ timeout: 5 });
  });

  it("imports as app_worker under the system principal, insert-only", async () => {
    const worker = workerConn!.db;
    const cards = [
      {
        id: "00000000-0000-4000-8000-000000000001",
        name: "Greninja ex",
        card_number: "214/167",
        rarity: null,
        variant: "holo",
        languages: ["en", "ja"],
        set: { id: "00000000-0000-4000-8000-000000009001", set_code: "twm", name: "Twilight Masquerade", release_date: "2024-05-24" },
      },
    ];
    const transport: HttpTransport = {
      async fetch(url) {
        const game = new URL(url).searchParams.get("game");
        return {
          status: 200,
          headers: {},
          bodyText: JSON.stringify({ ok: true, game, cards: game === "pokemon" ? cards : [], next_after: null }),
        };
      },
    };
    const report = await withPlatformContext(worker, (db) =>
      importTccCatalog(db, { baseUrl: "https://tcc.example.test", token: "t", transport, exclusive: true }),
    );
    expect(report).toMatchObject({ status: "completed", printings: 2, sets: 1, rejected: 0 });

    // Catalog rows stay immutable for the worker.
    await expect(
      withPlatformContext(worker, (db) => db.execute(sql`UPDATE tcg_set SET name = 'Changed' WHERE canonical_set_key = 'twm'`)),
    ).rejects.toThrow();
    await expect(
      withPlatformContext(worker, (db) => db.execute(sql`DELETE FROM tcg_printing_identifier`)),
    ).rejects.toThrow();
    // A tenant context on the worker connection cannot add catalog rows.
    await expect(
      withOrganizationContext(worker, { organizationId: "o_a", userId: "u_a" }, (db) =>
        db.execute(sql`INSERT INTO tcg_set (id, game_key, canonical_set_key, name) VALUES ('set_x', 'pokemon', 'x', 'X')`),
      ),
    ).rejects.toThrow();

    // The web role still cannot write the catalog.
    const app = postgres(replaceConnectionRole(target, DB_ROLES.user, passwords.user), { max: 1, prepare: false });
    try {
      await expect(
        app`INSERT INTO tcg_set (id, game_key, canonical_set_key, name) VALUES ('set_y', 'pokemon', 'y', 'Y')`,
      ).rejects.toThrow();
    } finally {
      await app.end({ timeout: 5 });
    }
    const admin = postgres(target, { max: 1, prepare: false });
    try {
      const [row] = await admin`
        SELECT
          has_table_privilege('app_worker', 'tcg_printing', 'INSERT') AS can_insert,
          has_table_privilege('app_worker', 'tcg_printing', 'UPDATE') AS can_update,
          has_table_privilege('app_worker', 'tcg_printing', 'DELETE') AS can_delete,
          has_table_privilege('app_worker', 'tcg_card_name_alias', 'INSERT') AS can_insert_alias,
          has_table_privilege('app_user', 'tcg_printing', 'INSERT') AS user_can_insert
      `;
      expect(row).toEqual({
        can_insert: true,
        can_update: false,
        can_delete: false,
        can_insert_alias: false,
        user_can_insert: false,
      });
    } finally {
      await admin.end({ timeout: 5 });
    }
  });
});
