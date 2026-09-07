import { afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { markPlatformOutboxFailed } from "./outbox.js";
import type { Database } from "../client.js";

const clients: PGlite[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); });
describe("atomic terminal outbox status guard", () => {
  it("updates only published records, once, without overwriting success or operator retry", async () => {
    const client = new PGlite(); clients.push(client);
    await client.exec(`CREATE TABLE platform_outbox (id text PRIMARY KEY, status text, failed_at timestamptz, last_error text);
      INSERT INTO platform_outbox(id,status) VALUES ('published','published'),('processed','processed'),('pending','pending'),('failed','failed');`);
    const db = drizzle(client) as unknown as Database;
    expect(await markPlatformOutboxFailed(db, "published", "undefined_table", { onlyIfPublished: true })).toBe(1);
    expect(await markPlatformOutboxFailed(db, "published", "unknown", { onlyIfPublished: true })).toBe(0);
    for (const id of ["processed", "pending", "failed", "missing"]) {
      expect(await markPlatformOutboxFailed(db, id, "unknown", { onlyIfPublished: true })).toBe(0);
    }
    expect((await client.query("SELECT id,status,last_error FROM platform_outbox ORDER BY id")).rows).toEqual([
      { id: "failed", status: "failed", last_error: null },
      { id: "pending", status: "pending", last_error: null },
      { id: "processed", status: "processed", last_error: null },
      { id: "published", status: "failed", last_error: "undefined_table" },
    ]);
  });
});
