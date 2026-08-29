import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { isLocalHostname } from "@isp/shared";
import type { Database } from "../client.js";
import { providerRuntime, workerHeartbeat } from "../schema/provider.js";

export type ConnectionTargetFingerprint = {
  configured: boolean;
  host_kind: "neon" | "neon_pooler" | "local" | "other" | "invalid" | "missing";
  host_fingerprint: string | null;
  neon_endpoint: string | null;
  database_name: string | null;
};

export type LiveDatabaseIdentity = {
  current_database: string | null;
  current_user: string | null;
  session_user: string | null;
  search_path: string | null;
  schema_marker: "phase24_worker_heartbeat" | "missing_worker_heartbeat";
  provider_runtime_count: number;
  worker_heartbeat_count: number;
  newest_heartbeat_at: string | null;
};

export type DatabaseIdentity = ConnectionTargetFingerprint &
  Partial<LiveDatabaseIdentity> & {
    label: string;
    reachable: boolean;
  };

function firstRow(result: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(result)) {
    return result[0] as Record<string, unknown> | undefined;
  }
  if (result && typeof result === "object" && "rows" in result) {
    return (result as { rows: Record<string, unknown>[] }).rows[0];
  }
  return undefined;
}

function asText(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

export function fingerprintConnectionTarget(url: string | undefined | null): ConnectionTargetFingerprint {
  const trimmed = url?.trim();
  if (!trimmed) {
    return {
      configured: false,
      host_kind: "missing",
      host_fingerprint: null,
      neon_endpoint: null,
      database_name: null,
    };
  }
  try {
    const parsed = new URL(trimmed);
    const hostname = parsed.hostname.toLowerCase();
    const first = hostname.split(".")[0] ?? "";
    const neon = hostname.endsWith(".neon.tech");
    const pooled = neon && first.endsWith("-pooler");
    const neonEndpoint = neon ? first.replace(/-pooler$/i, "") : null;
    const databaseName = decodeURIComponent((parsed.pathname.replace(/^\//, "").split("/")[0] ?? "").trim());
    return {
      configured: true,
      host_kind: neon ? (pooled ? "neon_pooler" : "neon") : isLocalHostname(trimmed) ? "local" : "other",
      host_fingerprint: createHash("sha256").update(hostname).digest("hex").slice(0, 16),
      neon_endpoint: neonEndpoint,
      database_name: databaseName || null,
    };
  } catch {
    return {
      configured: true,
      host_kind: "invalid",
      host_fingerprint: "invalid",
      neon_endpoint: null,
      database_name: null,
    };
  }
}

export function sameDatabaseIdentity(
  left: Pick<ConnectionTargetFingerprint, "neon_endpoint" | "host_fingerprint" | "database_name">,
  right: Pick<ConnectionTargetFingerprint, "neon_endpoint" | "host_fingerprint" | "database_name">,
): boolean {
  const leftDb = left.database_name;
  const rightDb = right.database_name;
  if (!leftDb || !rightDb || leftDb !== rightDb) {
    return false;
  }
  if (left.neon_endpoint && right.neon_endpoint) {
    return left.neon_endpoint === right.neon_endpoint;
  }
  return Boolean(left.host_fingerprint && left.host_fingerprint === right.host_fingerprint);
}

export async function collectLiveDatabaseIdentity(db: Database): Promise<LiveDatabaseIdentity> {
  const session = firstRow(
    await db.execute(sql`
      select
        current_database() as current_database,
        current_user as current_user,
        session_user as session_user,
        current_setting('search_path') as search_path
    `),
  );
  const heartbeatPresent = firstRow(
    await db.execute(sql`select to_regclass('public.worker_heartbeat') is not null as present`),
  );
  const [providers] = await db.select({ n: sql<number>`count(*)::int` }).from(providerRuntime);
  const [heartbeats] = await db
    .select({
      n: sql<number>`count(*)::int`,
      newest: sql<Date | null>`max(${workerHeartbeat.lastSeenAt})`,
    })
    .from(workerHeartbeat);
  return {
    current_database: asText(session?.current_database),
    current_user: asText(session?.current_user),
    session_user: asText(session?.session_user),
    search_path: asText(session?.search_path),
    schema_marker:
      heartbeatPresent?.present === true || heartbeatPresent?.present === "t"
        ? "phase24_worker_heartbeat"
        : "missing_worker_heartbeat",
    provider_runtime_count: Number(providers?.n ?? 0),
    worker_heartbeat_count: Number(heartbeats?.n ?? 0),
    newest_heartbeat_at:
      heartbeats?.newest instanceof Date ? heartbeats.newest.toISOString() : asText(heartbeats?.newest),
  };
}

export async function inspectDatabaseIdentity(input: {
  label: string;
  url?: string | null;
  db?: Database;
}): Promise<DatabaseIdentity> {
  const target = fingerprintConnectionTarget(input.url);
  if (!target.configured || !input.db) {
    return {
      label: input.label,
      reachable: false,
      ...target,
    };
  }
  const live = await collectLiveDatabaseIdentity(input.db);
  return {
    label: input.label,
    reachable: true,
    ...target,
    ...live,
    database_name: live.current_database ?? target.database_name,
  };
}

export function formatDatabaseIdentityReport(identities: DatabaseIdentity[]): string {
  const byLabel = Object.fromEntries(identities.map((row) => [row.label, row]));
  const admin = byLabel.admin;
  const app = byLabel.app;
  const worker = byLabel.worker;
  const lines = ["staging database identity"];
  for (const row of identities) {
    lines.push(
      [
        `${row.label}:`,
        `configured=${row.configured ? "yes" : "no"}`,
        `reachable=${row.reachable ? "yes" : "no"}`,
        `host_kind=${row.host_kind}`,
        `host_fingerprint=${row.host_fingerprint ?? "-"}`,
        `neon_endpoint=${row.neon_endpoint ?? "-"}`,
        `database=${row.database_name ?? row.current_database ?? "-"}`,
        `user=${row.current_user ?? "-"}`,
        `schema=${row.schema_marker ?? "-"}`,
        `provider_runtime=${row.provider_runtime_count ?? "-"}`,
        `worker_heartbeat=${row.worker_heartbeat_count ?? "-"}`,
        `newest_heartbeat=${row.newest_heartbeat_at ?? "-"}`,
      ].join(" "),
    );
  }
  if (admin && app) {
    lines.push(`same_admin_app: ${sameDatabaseIdentity(admin, app) ? "yes" : "no"}`);
  }
  if (admin && worker) {
    lines.push(`same_admin_worker: ${sameDatabaseIdentity(admin, worker) ? "yes" : "no"}`);
  }
  if (app && worker) {
    lines.push(`same_app_worker: ${sameDatabaseIdentity(app, worker) ? "yes" : "no"}`);
  }
  return lines.join("\n");
}
