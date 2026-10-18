// Hosted Postgres providers encode one database behind several hostnames.
// Neon: `ep-x` (direct) and `ep-x-pooler` (PgBouncer) are one endpoint.
// Supabase: `db.<ref>.supabase.co` (direct, IPv6 by default) and the shared
// Supavisor pooler `aws-0-<region>.pooler.supabase.com` (user `<role>.<ref>`,
// port 5432 session / 6543 transaction) are one project. The pooler hostname is
// shared by every project in a region, so the project ref comes from the
// username. Without a ref the pooler URL is not identifiable and is left as-is.

export type HostedDbProvider = "neon" | "supabase" | null;

export type DatabaseTarget = {
  provider: HostedDbProvider;
  pooled: boolean;
  /** Neon endpoint id or Supabase project ref; null for other hosts. */
  instance: string | null;
  /** Host used for identity: pooler/direct variants collapse to one value. */
  host: string;
  /** Port used for identity: Supabase direct/session/transaction collapse to 5432. */
  port: string;
};

const SUPABASE_REF = /^[a-z0-9]{20}$/;

export function isNeonHostname(hostname: string): boolean {
  return /\.neon\.tech$/i.test(hostname);
}

export function isSupabaseHostname(hostname: string): boolean {
  return /\.supabase\.(co|com)$/i.test(hostname);
}

export function isHostedDatabaseHostname(hostname: string): boolean {
  return isNeonHostname(hostname) || isSupabaseHostname(hostname);
}

/** Parses an already-validated URL. Never returns credentials. */
export function describeDatabaseTarget(url: URL): DatabaseTarget {
  const hostname = url.hostname.toLowerCase();
  const port = url.port || "5432";
  if (isNeonHostname(hostname)) {
    const first = hostname.split(".")[0] ?? "";
    const pooled = first.endsWith("-pooler");
    return {
      provider: "neon",
      pooled,
      instance: first.replace(/-pooler$/, ""),
      host: hostname.replace(/-pooler(?=\.)/, ""),
      port,
    };
  }
  if (isSupabaseHostname(hostname)) {
    const direct = hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/);
    if (direct?.[1] && SUPABASE_REF.test(direct[1])) {
      return { provider: "supabase", pooled: false, instance: direct[1], host: `supabase:${direct[1]}`, port: "5432" };
    }
    if (hostname.endsWith(".pooler.supabase.com")) {
      const user = decodeURIComponent(url.username).toLowerCase();
      const ref = user.includes(".") ? user.slice(user.lastIndexOf(".") + 1) : "";
      if (SUPABASE_REF.test(ref)) {
        return { provider: "supabase", pooled: true, instance: ref, host: `supabase:${ref}`, port: "5432" };
      }
      return { provider: "supabase", pooled: true, instance: null, host: hostname, port };
    }
    return { provider: "supabase", pooled: false, instance: null, host: hostname, port };
  }
  return { provider: null, pooled: false, instance: null, host: hostname, port };
}
