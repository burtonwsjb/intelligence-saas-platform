import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { databaseTargetFingerprint, inspectMaintenanceTarget } from './staging-target-check.mjs';

const direct = 'postgresql://neondb_owner:DO_NOT_LOG_PASSWORD@ep-staging-abc.us-east-1.aws.neon.tech/neondb?sslmode=require';
const pooled = 'postgres://app_admin:DIFFERENT_PASSWORD@ep-staging-abc-pooler.us-east-1.aws.neon.tech:5432/neondb?sslmode=require&channel_binding=require';
const fingerprint = databaseTargetFingerprint(direct);
const script = fileURLToPath(new URL('./staging-target-check.mjs', import.meta.url));

test('pooling and role changes preserve the same target identity', () => {
  assert.equal(databaseTargetFingerprint(pooled), fingerprint);
  assert.equal(inspectMaintenanceTarget(direct, fingerprint).matchesDeployedTarget, true);
});
test('matches the deployed diagnostic target.v1 serialization contract', () => {
  // Stable golden value produced by the deployed diagnostic algorithm.
  assert.equal(fingerprint, 'c342a25102325b6d');
});
test('branch endpoint, database and port differences cannot pass', () => {
  for (const raw of [direct.replace('ep-staging-abc', 'ep-backup-def'), direct.replace('/neondb?', '/otherdb?'), direct.replace('.tech/neondb', '.tech:5433/neondb')]) {
    const report = inspectMaintenanceTarget(raw, fingerprint);
    assert.equal(report.errorClass, 'target_mismatch');
    assert.equal(report.databaseContacted, false);
    assert.equal(report.matchesDeployedTarget, false);
  }
});
test('malformed and missing URLs fail without echoing their contents', () => {
  for (const raw of [undefined, '', 'DO_NOT_LOG_PASSWORD', 'DATABASE_MIGRATE_URL="'+direct+'"', 'https://db/neondb', 'postgresql:///neondb', 'postgresql://host/']) {
    const report = inspectMaintenanceTarget(raw, fingerprint);
    assert.equal(report.errorClass, 'invalid_connection_url');
    assert.ok(!JSON.stringify(report).includes('DO_NOT_LOG_PASSWORD'));
  }
});
test('routing override parameters fail closed', () => {
  for (const key of ['host', 'HOSTADDR', 'port', 'database', 'dbname', 'options']) {
    assert.equal(inspectMaintenanceTarget(direct+'&'+key+'=DO_NOT_LOG_TOKEN', fingerprint).errorClass, 'unsupported_routing_override');
  }
});
test('expected fingerprint must be exactly sixteen lowercase hex digits', () => {
  for (const expected of [undefined, '', 'DO_NOT_LOG_TOKEN', fingerprint+'a']) {
    assert.equal(inspectMaintenanceTarget(direct, expected).errorClass, 'invalid_expected_target');
    assert.ok(!JSON.stringify(inspectMaintenanceTarget(direct, expected)).includes('DO_NOT_LOG_TOKEN'));
  }
});
test('only Neon hostnames have the pooler marker normalized', () => {
  assert.notEqual(databaseTargetFingerprint('postgresql://user:pass@host-pooler.example/db'), databaseTargetFingerprint('postgresql://user:pass@host.example/db'));
});
test('database path escaping follows the runtime contract', () => {
  assert.equal(databaseTargetFingerprint(direct.replace('/neondb?', '/neon%64b?')), fingerprint);
});
test('CLI has safe output and nonzero mismatch exit without a database client', () => {
  for (const [expected, code] of [[fingerprint, 0], ['0000000000000000', 1]]) {
    const result = spawnSync(process.execPath, [script, '--expected-target', expected], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, DATABASE_MIGRATE_URL: direct },
    });
    assert.equal(result.status, code);
    const report = JSON.parse(result.stdout);
    assert.equal(report.databaseContacted, false);
    for (const secret of ['DO_NOT_LOG_PASSWORD', 'neondb_owner', 'ep-staging-abc', 'postgresql://']) {
      assert.ok(!(result.stdout+result.stderr).includes(secret));
    }
  }
});
test('CLI refuses extra arguments without contacting anything', () => {
  const result = spawnSync(process.execPath, [script, '--expected-target', fingerprint, '--apply'], { encoding: 'utf8', timeout: 5000, env: { ...process.env, DATABASE_MIGRATE_URL: direct } });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).errorClass, 'invalid_expected_target');
});
