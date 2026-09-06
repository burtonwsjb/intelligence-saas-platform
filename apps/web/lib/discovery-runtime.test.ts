import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "@isp/db";
import { collectDiscoveryRuntimeDiagnostics, databaseTargetFingerprint, discoveryFailure, discoveryQuery, runtimeContext, summarizeRuntimeCatalog } from "./discovery-runtime";

// Reuse the repository's existing disposable database test dependency.
const { PGlite } = createRequire(new URL("../../../packages/db/package.json", import.meta.url))("@electric-sql/pglite");
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((close) => close())); });

async function fixture() {
  const client = new PGlite();
  cleanups.push(() => client.close());
  await client.exec(`
    CREATE TABLE public.platform_outbox(id text,job_type text,status text,last_error text,failed_at timestamptz);
    INSERT INTO public.platform_outbox VALUES ('kept','provider.sync.v1','failed','42P01','2026-09-06T00:00:00Z');
    INSERT INTO public.platform_outbox VALUES ('hidden','secret_payload','failed','postgresql://secret@host/db',now());
  `);
  return { client, db: drizzle(client) as unknown as Database };
}

describe("deployed discovery diagnostics", () => {
  it("carries the failing operation and a whitelisted SQLSTATE without exposing messages", async () => {
    const cause = Object.assign(new Error('relation "discovery_run" does not exist'), { code: "42P01" });
    const error = await discoveryQuery("runs", async () => { throw new Error("Failed query contains secret", { cause }); }).catch((e: unknown) => e);
    expect(discoveryFailure(error)).toEqual({ operation: "runs", sqlState: "42P01", object: "discovery_run" });
    expect(JSON.stringify(discoveryFailure(error))).not.toContain("secret");
  });
  it("does not emit unrecognized identifiers, arbitrary error codes or cyclic errors", () => {
    expect(discoveryFailure({code:"42703", message:'column "secret" does not exist'}).object).toBeNull();
    const cyclic: {code: string; cause?: unknown} = {code:"postgresql://credential"}; cyclic.cause = cyclic;
    expect(discoveryFailure(cyclic)).toEqual({ operation:"unknown",sqlState:"unknown",object:null });
  });
  it("fingerprints a target consistently across pooled/direct connections without passwords or options", () => {
    const a = "postgresql://owner:secret@ep-check-pooler.us.neon.tech/db?sslmode=require";
    const b = "postgresql://app_admin:other@ep-check.us.neon.tech/db";
    expect(databaseTargetFingerprint(a)).toBe(databaseTargetFingerprint(b));
    expect(databaseTargetFingerprint(b)).not.toBe(databaseTargetFingerprint(b.replace("ep-check", "ep-backup")));
    expect(runtimeContext({DATABASE_ADMIN_URL:a,APP_DATABASE_URL:b,VERCEL_GIT_COMMIT_SHA:"secret"})).toMatchObject({adminAndAppSameTarget:true,deployment:"unknown"});
    expect(JSON.stringify(runtimeContext({DATABASE_ADMIN_URL:a}))).not.toMatch(/secret|ep-check|owner/);
  });
  it("distinguishes a present public table from runtime visibility and missing columns", () => {
    const report = summarizeRuntimeCatalog({role:"app_admin",ledger_present:true,public_in_path:false}, [{
      name:"discovered_creator",public_exists:true,resolves_to_public:false,select_allowed:true,exists_outside_public:true,
      columns:["id","secret_column"]
    }]);
    expect(report.tables.find((x) => x.table === "discovered_creator")).toMatchObject({publicExists:true,resolvesToPublic:false,existsOutsidePublic:true});
    expect(report.tables[2]?.missingColumns).toContain("last_monitor_success_at");
    expect(JSON.stringify(report)).not.toContain("secret_column");
  });
  it("executes real SQL against missing discovery tables without writing or clearing failed jobs", async () => {
    const {client,db} = await fixture();
    const report = await collectDiscoveryRuntimeDiagnostics(db,{});
    expect(report).toMatchObject({migrationLedgerPresent:false,publicInSearchPath:true,failureSampleLimit:50});
    expect("tables" in report && report.tables.every((row) => !row.publicExists)).toBe(true);
    expect(JSON.stringify(report)).toContain("undefined_table");
    expect(JSON.stringify(report)).not.toMatch(/secret_payload|postgresql:|credential/);
    expect((await client.query("SELECT count(*)::int AS n FROM platform_outbox")).rows).toEqual([{n:2}]);
    expect((await client.query("SELECT to_regclass('public._isp_migration_history') AS name")).rows).toEqual([{name:null}]);
  },30000);
  it("identifies objects created outside public without printing custom schema names", async () => {
    const {client,db} = await fixture();
    await client.exec("CREATE SCHEMA private_probe; CREATE TABLE private_probe.discovery_topic(id text)");
    const report = await collectDiscoveryRuntimeDiagnostics(db,{});
    expect("tables" in report && report.tables[0]).toMatchObject({publicExists:false,existsOutsidePublic:true});
    expect(JSON.stringify(report)).not.toContain("private_probe");
  },30000);
  it("shows a present ledger and runtime SELECT denial without escalating privileges", async () => {
    const {client,db} = await fixture();
    await client.exec(`CREATE TABLE public._isp_migration_history(name text); CREATE TABLE public.discovery_topic(id text);
      CREATE ROLE app_admin; GRANT USAGE ON SCHEMA public TO app_admin; GRANT SELECT ON platform_outbox TO app_admin; SET ROLE app_admin;`);
    const report = await collectDiscoveryRuntimeDiagnostics(db,{});
    expect(report).toMatchObject({role:"app_admin",migrationLedgerPresent:true});
    expect("tables" in report && report.tables[0]).toMatchObject({publicExists:true,selectAllowed:false});
    expect((await client.query("SELECT has_table_privilege('app_admin','public.discovery_topic','SELECT') AS allowed")).rows).toEqual([{allowed:false}]);
  },30000);
  it("checks the complete migrated application schema, including all monitor columns", async () => {
    const client = new PGlite();
    cleanups.push(() => client.close());
    const directory = new URL("../../../packages/db/drizzle/", import.meta.url);
    const files = (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
    await client.exec((await Promise.all(files.map((name) => readFile(new URL(name, directory), "utf8")))).join("\n"));
    const report = await collectDiscoveryRuntimeDiagnostics(drizzle(client) as unknown as Database, {});
    expect("tables" in report).toBe(true);
    if ("tables" in report) {
      for (const table of report.tables) {
        expect(table).toMatchObject({publicExists:true,resolvesToPublic:true,selectAllowed:true,missingColumns:[]});
      }
    }
  },30000);
  it("detects search-path invisibility even when the public relation exists", async () => {
    const {client,db} = await fixture();
    await client.exec("CREATE TABLE public.discovery_topic(id text); SET search_path = pg_catalog");
    const report = await collectDiscoveryRuntimeDiagnostics(db, {});
    expect(report).toMatchObject({publicInSearchPath:false});
    expect("tables" in report && report.tables[0]).toMatchObject({publicExists:true,resolvesToPublic:false,selectAllowed:true});
    expect((await client.query("SELECT current_setting('search_path') AS path")).rows).toEqual([{path:"pg_catalog"}]);
  },30000);
  it("keeps diagnostics behind operator authorization and does not expose the original error", async () => {
    const page = await readFile(new URL("../app/admin/discovery/page.tsx", import.meta.url), "utf8");
    expect(page.indexOf("await requireGrantedOperator()")).toBeLessThan(page.indexOf("await collectDiscoveryRuntimeDiagnostics(db)"));
    expect(page).not.toMatch(/console\.(?:error|log)\(error|JSON\.stringify\(error|error\.message/);
  });
  it("returns a safe diagnostic failure instead of leaking a secondary database error", async () => {
    const db = {transaction: async () => { throw Object.assign(new Error("postgresql://secret"),{code:"42501"}); }} as unknown as Database;
    expect(await collectDiscoveryRuntimeDiagnostics(db,{})).toMatchObject({catalogError:"42501"});
  });
});
