import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  StagingSourceCommandError,
  collectLiveDatabaseIdentity,
  collectStagingDatabaseIdentities,
  fingerprintConnectionTarget,
  formatDatabaseIdentityReport,
  inspectDatabaseIdentity,
  readMigrationSql,
  sameDatabaseIdentity,
  upsertWorkerHeartbeat,
  withPlatformContext,
  type Database,
} from "../index.js";

describe("database identity fingerprints", () => {
  it("treats neon compute and pooler hosts on the same endpoint as the same database", () => {
    const worker = fingerprintConnectionTarget(
      "postgresql://app_worker:hunter2@ep-alpha-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require",
    );
    const admin = fingerprintConnectionTarget(
      "postgresql://app_admin:otherpass@ep-alpha.us-east-1.aws.neon.tech/neondb",
    );
    expect(sameDatabaseIdentity(worker, admin)).toBe(true);
    expect(worker.neon_endpoint).toBe("ep-alpha");
    expect(admin.host_kind).toBe("neon");
    expect(worker.host_kind).toBe("neon_pooler");
    expect(JSON.stringify(worker)).not.toMatch(/hunter2|otherpass|postgresql:\/\//);
  });

  it("detects a different neon endpoint or database name", () => {
    const left = fingerprintConnectionTarget("postgresql://app_worker@ep-alpha.us-east-1.aws.neon.tech/neondb");
    const otherBranch = fingerprintConnectionTarget(
      "postgresql://app_worker@ep-beta.us-east-1.aws.neon.tech/neondb",
    );
    const otherDb = fingerprintConnectionTarget("postgresql://app_worker@ep-alpha.us-east-1.aws.neon.tech/otherdb");
    expect(sameDatabaseIdentity(left, otherBranch)).toBe(false);
    expect(sameDatabaseIdentity(left, otherDb)).toBe(false);
  });

  it("refuses production and does not print secrets", async () => {
    await expect(collectStagingDatabaseIdentities({ ISP_ENV: "production" })).rejects.toThrow(
      StagingSourceCommandError,
    );
    const rows = await collectStagingDatabaseIdentities({ ISP_ENV: "staging" });
    const report = formatDatabaseIdentityReport(rows);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.configured === false)).toBe(true);
    expect(report).not.toMatch(/postgresql:\/\//);
    expect(report).not.toMatch(/password|hunter2|sslmode/i);
    expect(report).toContain("staging database identity");
    const cli = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../staging-db-identity.ts"),
      "utf8",
    );
    expect(cli).toMatch(/collectStagingDatabaseIdentities/);
    expect(cli).toMatch(/sanitizePlatformAdminCliMessage/);
    expect(cli).not.toMatch(/console\.(log|error).*process\.env/);
    expect(cli).not.toMatch(/DATABASE_ADMIN_URL\}/);
  });

  it("reports live heartbeat visibility without leaking connection strings", async () => {
    const client = new PGlite();
    await client.exec(await readMigrationSql());
    const db = drizzle(client) as unknown as Database;
    await withPlatformContext(db, (scoped) =>
      upsertWorkerHeartbeat(scoped, { queueDepth: 2, failedJobs: 1 }),
    );
    const live = await collectLiveDatabaseIdentity(db);
    const identity = await inspectDatabaseIdentity({
      label: "worker",
      url: "postgresql://app_worker:hunter2@127.0.0.1:5432/isp",
      db,
    });
    expect(live.worker_heartbeat_count).toBe(1);
    expect(live.newest_heartbeat_at).toBeTruthy();
    expect(live.schema_marker).toBe("phase24_worker_heartbeat");
    const report = formatDatabaseIdentityReport([identity]);
    expect(report).toContain("worker_heartbeat=1");
    expect(report).not.toMatch(/hunter2/);
    expect(report).not.toMatch(/postgresql:\/\//);
  });
});
