import type { Redis } from "ioredis";
import { isHostedRuntime } from "@isp/shared";
import { getWorkerResources, type Database } from "@isp/db";

// Ephemeral capability, never an environment variable, credential, or durable
// bypass. It is issued only after reading the owner-controlled server setting.
const permittedEnvironments = new WeakMap<NodeJS.ProcessEnv, number>();
const permittedConnections = new WeakMap<NodeJS.ProcessEnv, Set<Redis>>();
/** Hosted runtimes use the metered provider. Local development and CI keep
 * their own Redis, so only staging and production need the owner's window. */
export function redisNeedsPermission(env: NodeJS.ProcessEnv = process.env): boolean {
  return isHostedRuntime(env);
}
export function redisIsPermitted(env: NodeJS.ProcessEnv = process.env): boolean {
  return !redisNeedsPermission(env) || (permittedEnvironments.get(env) ?? 0) > Date.now();
}
export function assertRedisPermission(env: NodeJS.ProcessEnv = process.env): void {
  if (!redisIsPermitted(env)) throw new Error("redis_blocked_free_only");
}
/** Track BullMQ's duplicated blocking client too. The window can disconnect all
 * sockets even when a normal queue drain times out. Local tests remain unwrapped. */
export function trackPermittedRedisConnection(env: NodeJS.ProcessEnv, client: Redis): Redis {
  if (!redisNeedsPermission(env)) return client;
  assertRedisPermission(env);
  const clients = permittedConnections.get(env);
  if (!clients) throw new Error("redis_window_missing");
  if (clients.has(client)) return client;
  clients.add(client);
  const duplicate = client.duplicate.bind(client);
  client.duplicate = (override) => {
    assertRedisPermission(env);
    return trackPermittedRedisConnection(env, duplicate(override));
  };
  return client;
}
/** All hosted Redis writers must be inside a short, explicitly approved window. */
export async function withMeteredRedisPermission<T>(db: Database, env: NodeJS.ProcessEnv, deadline: Date,
  operation: (permittedEnv: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const { settings } = await getWorkerResources(db);
  if (!settings.enabled || settings.mode !== "metered_redis") throw new Error("redis_blocked_free_only");
  if (!Number.isFinite(deadline.getTime()) || deadline.getTime() <= Date.now()
    || deadline.getTime() > Date.now() + 180_000) throw new Error("invalid_redis_window");
  const permitted = { ...env };
  permittedEnvironments.set(permitted, deadline.getTime());
  const clients = new Set<Redis>();
  permittedConnections.set(permitted, clients);
  const revoke = () => {
    permittedEnvironments.delete(permitted);
    for (const client of clients) client.disconnect(false);
  };
  const expiry = setTimeout(revoke, Math.max(0, deadline.getTime() - Date.now()));
  try { return await operation(permitted); }
  finally { clearTimeout(expiry); revoke(); permittedConnections.delete(permitted); }

}
