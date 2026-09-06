import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "@isp/db";

const EXPECTED = {
  discovery_topic: ["id", "provider_key", "query", "strategy_key", "enabled", "priority", "last_run_at", "last_error_class", "metadata", "created_at", "updated_at"],
  discovery_run: ["id", "topic_id", "provider_key", "query", "trigger", "status", "videos_seen", "channels_seen", "creators_linked", "content_ingested", "quota_units", "error_class", "started_at", "completed_at", "metadata"],
  discovered_creator: ["id", "creator_id", "source_account_id", "provider_key", "external_account_id", "display_name", "first_topic_id", "last_topic_id", "topic_hits", "relevance_score", "relevance_state", "reach_views", "reach_subscribers", "discovery_provenance", "first_discovered_at", "last_discovered_at", "last_monitor_attempt_at", "last_monitor_success_at", "next_monitor_at", "monitor_error_class"],
  discovery_request_budget: ["provider_key", "bucket", "budget_day", "requests_used", "updated_at"],
  discovery_creator_topic: ["creator_id", "provider_key", "topic_key", "first_seen_at"],
} as const;
const SQL_STATES = new Set(["42P01", "42703", "42501", "28P01", "57014", "08006", "08001", "53300"]);
export type DiscoveryOperation = "topics" | "creators" | "runs";

class DiscoveryQueryError extends Error {
  constructor(readonly operation: DiscoveryOperation, cause: unknown) {
    super("Discovery query failed", { cause });
  }
}
export async function discoveryQuery<T>(operation: DiscoveryOperation, read: () => Promise<T>): Promise<T> {
  try { return await read(); } catch (error) { throw new DiscoveryQueryError(operation, error); }
}
export function discoveryFailure(error: unknown): { operation: DiscoveryOperation | "unknown"; sqlState: string; object: string | null } {
  let operation: DiscoveryOperation | "unknown" = "unknown";
  const seen = new Set<object>();
  let current = error;
  for (let i = 0; i < 8 && current && typeof current === "object" && !seen.has(current); i += 1) {
    seen.add(current);
    if (current instanceof DiscoveryQueryError) operation = current.operation;
    const item = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof item.code === "string" && SQL_STATES.has(item.code)) {
      // Match only repository-owned identifiers. Never return the SQL/message.
      const match = typeof item.message === "string" ? item.message.match(/(?:relation|column) "([A-Za-z0-9_.]+)" does not exist/) : null;
      const identifier = match?.[1]?.replace(/^public\./, "");
      const trusted = identifier && (Object.hasOwn(EXPECTED, identifier) || Object.values(EXPECTED).some((columns) => (columns as readonly string[]).includes(identifier)));
      return { operation, sqlState: item.code, object: trusted ? identifier : null };
    }
    current = item.cause;
  }
  return { operation, sqlState: "unknown", object: null };
}
function rows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === "object" && "rows" in result && Array.isArray(result.rows)) return result.rows;
  return [];
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
export function databaseTargetFingerprint(raw?: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) return null;
    const hostname = url.hostname.toLowerCase();
    const host = hostname.endsWith(".neon.tech") ? hostname.replace(/-pooler(?=\.)/, "") : hostname;
    return hash(JSON.stringify([host, url.port || "5432", decodeURIComponent(url.pathname)]));
  } catch { return null; }
}
export function runtimeContext(env: NodeJS.ProcessEnv = process.env) {
  const admin = databaseTargetFingerprint(env.DATABASE_ADMIN_URL);
  const app = databaseTargetFingerprint(env.APP_DATABASE_URL);
  const sha = env.VERCEL_GIT_COMMIT_SHA;
  return {
    deployment: sha && /^[a-f0-9]{40}$/i.test(sha) ? sha.slice(0, 12) : "unknown",
    adminTarget: admin, appTarget: app, adminAndAppSameTarget: admin && app ? admin === app : null,
  };
}
function bool(value: unknown): boolean { return value === true || value === "t"; }
export function summarizeRuntimeCatalog(context: Record<string, unknown> | undefined, inventory: Record<string, unknown>[]) {
  const role = typeof context?.role === "string" ? context.role : "unknown";
  return {
    role: ["app_admin", "app_user", "app_worker", "app_migrate", "neondb_owner"].includes(role) ? role : "other",
    databaseFingerprint: typeof context?.database_name === "string" ? hash(context.database_name) : null,
    migrationLedgerPresent: bool(context?.ledger_present),
    publicInSearchPath: bool(context?.public_in_path),
    tables: Object.entries(EXPECTED).map(([table, expected]) => {
      const row = inventory.find((candidate) => candidate.name === table);
      const columns = Array.isArray(row?.columns) ? row.columns : [];
      return {
        table, publicExists: bool(row?.public_exists), resolvesToPublic: bool(row?.resolves_to_public),
        selectAllowed: bool(row?.select_allowed),
        existsOutsidePublic: bool(row?.exists_outside_public),
        missingColumns: expected.filter((column) => !columns.includes(column)),
      };
    }),
  };
}
/** Called only after requireGrantedOperator(), on that exact admin connection.
 * All SQL is read-only, bounded and uses catalog metadata or safe aggregates.
 * This deliberately does not read migration hashes, secrets, payloads or rows
 * of customer/discovery content, and never deletes/retries any failed jobs. */
export async function collectDiscoveryRuntimeDiagnostics(db: Database, env: NodeJS.ProcessEnv = process.env) {
  const context = runtimeContext(env);
  let catalog;
  try {
    catalog = await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout = '3000ms'`);
      const [identity] = rows(await tx.execute(sql`
        SELECT current_user AS role, current_database() AS database_name,
          to_regclass('public._isp_migration_history') IS NOT NULL AS ledger_present,
          'public' = ANY(current_schemas(false)) AS public_in_path`));
      const inventory = rows(await tx.execute(sql`
        WITH expected(name) AS (VALUES ${sql.join(Object.keys(EXPECTED).map((name) => sql`(${name}::text)`), sql`, `)})
        SELECT e.name, c.oid IS NOT NULL AS public_exists,
          COALESCE(to_regclass(format('%I',e.name)) = c.oid, false) AS resolves_to_public,
          COALESCE(has_table_privilege(c.oid, 'SELECT'), false) AS select_allowed,
          EXISTS(SELECT 1 FROM pg_class x JOIN pg_namespace n ON n.oid=x.relnamespace
            WHERE x.relname=e.name AND n.nspname <> 'public' AND n.nspname NOT LIKE 'pg_%') AS exists_outside_public,
          ARRAY(SELECT a.attname::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped) AS columns
        FROM expected e LEFT JOIN pg_namespace n ON n.nspname='public'
        LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=e.name`));
      return summarizeRuntimeCatalog(identity, inventory);
    });
  } catch (error) { return { ...context, catalogError: discoveryFailure(error).sqlState }; }

  // Database outbox failures are distinct from BullMQ's retained failed set.
  // Even error text is classified in SQL, never selected or rendered verbatim.
  let failures;
  try {
    failures = await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout = '3000ms'`);
      const result = rows(await tx.execute(sql`
        WITH recent AS (
          SELECT job_type, last_error, failed_at FROM public.platform_outbox
          WHERE status='failed' ORDER BY failed_at DESC NULLS LAST, id DESC LIMIT 50
        ) SELECT
          CASE WHEN job_type IN ('provider.sync.v1','source.intelligence.normalize.v1','tcg.market.normalize.v1','creator.extract.v1','intelligence.recompute.v1') THEN job_type ELSE 'other' END AS job_type,
          CASE WHEN last_error IN ('42P01','undefined_table') THEN 'undefined_table'
            WHEN last_error IN ('42703','undefined_column') THEN 'undefined_column'
            WHEN last_error IN ('42501','permission_denied') THEN 'permission_denied'
            WHEN last_error IN ('timeout','ETIMEDOUT') THEN 'timeout'
            WHEN last_error='overlap' THEN 'overlap'
            ELSE 'unknown' END AS error_class,
          count(*)::int AS count, max(failed_at) AS latest_at
        FROM recent GROUP BY 1,2 ORDER BY 1,2`));
      return result.map((row) => ({
        jobType: row.job_type, errorClass: row.error_class, count: row.count,
        latestAt: row.latest_at instanceof Date ? row.latest_at.toISOString() : row.latest_at,
      }));
    });
  } catch (error) { failures = { sqlState: discoveryFailure(error).sqlState }; }
  return { ...context, ...catalog, recentPlatformFailures: failures, failureSampleLimit: 50 };
}
