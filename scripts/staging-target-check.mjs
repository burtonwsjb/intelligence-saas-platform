import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// Matches databaseTargetFingerprint in apps/web/lib/discovery-runtime.ts.
// Passwords, roles and TLS options are not part of target identity. A Neon
// pooler and direct endpoint intentionally compare equal. This is configured
// endpoint identity, not proof of branch contents or of backup creation.
export function databaseTargetFingerprint(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const url = new URL(raw);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2) return null;
    const hostname = url.hostname.toLowerCase();
    const host = hostname.endsWith('.neon.tech') ? hostname.replace(/-pooler(?=\.)/, '') : hostname;
    return createHash('sha256')
      .update(JSON.stringify([host, url.port || '5432', decodeURIComponent(url.pathname)]))
      .digest('hex').slice(0, 16);
  } catch { return null; }
}

export function inspectMaintenanceTarget(raw, expectedTarget) {
  const expectedValid = typeof expectedTarget === 'string' && /^[a-f0-9]{16}$/.test(expectedTarget);
  const actual = databaseTargetFingerprint(raw);
  let routingOverride = false;
  if (actual) {
    // Reject URL parameters that might override the authority/path parsed above.
    // Supported Neon URLs need only TLS/channel-binding options here.
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
