import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Matches databaseTargetFingerprint in apps/web/lib/discovery-runtime.ts.
// Passwords, roles and TLS options are not part of target identity. A Neon
// pooler and direct endpoint intentionally compare equal, as do a Supabase
// project's direct host and its Supavisor pooler (session or transaction port;
// the project ref comes from the `<role>.<ref>` pooler username). This is
// configured endpoint identity, not proof of branch contents or of backup creation.
// Kept in step with describeDatabaseTarget in packages/shared/src/db-host.ts.
function targetHostAndPort(url) {
  const hostname = url.hostname.toLowerCase();
  if (hostname.endsWith('.neon.tech')) return { host: hostname.replace(/-pooler(?=\.)/, ''), port: url.port || '5432' };
  const direct = hostname.match(/^db\.([a-z0-9]{20})\.supabase\.co$/);
  if (direct) return { host: `supabase:${direct[1]}`, port: '5432' };
  if (hostname.endsWith('.pooler.supabase.com')) {
    const user = decodeURIComponent(url.username).toLowerCase();
    const ref = user.includes('.') ? user.slice(user.lastIndexOf('.') + 1) : '';
    if (/^[a-z0-9]{20}$/.test(ref)) return { host: `supabase:${ref}`, port: '5432' };
  }
  return { host: hostname, port: url.port || '5432' };
}

export function databaseTargetFingerprint(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) return null;
    const { host, port } = targetHostAndPort(url);
    return createHash('sha256')
      .update(JSON.stringify([host, port, decodeURIComponent(url.pathname)]))
      .digest('hex').slice(0, 16);
  } catch { return null; }
}

export function inspectMaintenanceTarget(raw, expectedTarget) {
  const expectedValid = typeof expectedTarget === 'string' && /^[a-f0-9]{16}$/.test(expectedTarget);
  const actual = databaseTargetFingerprint(raw);
  let routingOverride = false;
  if (actual) {
    // Reject URL parameters that might override the authority/path parsed above.
    // Supported Neon and Supabase URLs need only TLS/channel-binding options here.
    const url = new URL(raw);
    const forbidden = new Set(['host', 'hostname', 'hostaddr', 'port', 'database', 'dbname', 'options']);
    routingOverride = [...url.searchParams.keys()].some((key) => forbidden.has(key.toLowerCase()));
  }
  const errorClass = !expectedValid ? 'invalid_expected_target'
    : !actual ? 'invalid_connection_url'
    : routingOverride ? 'unsupported_routing_override'
    : actual !== expectedTarget ? 'target_mismatch' : null;
  return {
    event: 'db.maintenance_target',
    expectedTarget: expectedValid ? expectedTarget : null,
    maintenanceTarget: actual,
    matchesDeployedTarget: errorClass === null,
    databaseContacted: false,
    errorClass,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const expected = args.length === 2 && args[0] === '--expected-target' ? args[1] : undefined;
  const report = inspectMaintenanceTarget(process.env.DATABASE_MIGRATE_URL, expected);
  console.log(JSON.stringify(report));
  if (!report.matchesDeployedTarget) {
    process.exitCode = 1;
  }
}
