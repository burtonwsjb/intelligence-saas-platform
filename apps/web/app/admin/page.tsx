import {
  collectSystemHealth,
  countCustomersByStage,
  describePlatformConfig,
  getWorkerResources,
  isWorkerResourceOwner,
  listFeatureFlags,
} from "@isp/db";
import { AdminCard, AdminHeader, Notice, StatusPill, toneFor } from "@/components/Admin";
import { ConfirmButton } from "@/components/ConfirmButton";
import { KpiTile } from "@/components/Dashboard";
import { Icon } from "@/components/Icon";
import {
  setFeatureFlagAction,
  setProviderPausedAction,
  triggerDiscoveryRunAction,
  triggerProviderSyncAction,
  updateWorkerResourcesAction,
} from "@/app/admin-actions";
import { getDb } from "@/lib/auth";
import { formatAge, providerText } from "@/lib/display";
import { requirePlatformOperator } from "@/lib/platform-admin";
import Link from "next/link";

export const dynamic = "force-dynamic";

const DONE_TEXT: Record<string, string> = {
  sync: "Sync queued. The worker picks it up on its next batch.",
  discovery: "Discovery run queued. New influencers show up under Discovery for review.",
  paused: "Source updated.",
  flag: "Feature switch saved.",
  worker: "Worker schedule saved.",
};

const FLAG_TEXT: Record<string, { label: string; body: string }> = {
  predictions_customer_visible: {
    label: "Show forecasts to customers",
    body: "Forecasts stay in shadow mode for everyone until this is on.",
  },
};

function flagText(key: string) {
  return FLAG_TEXT[key] ?? { label: key.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase()), body: "Platform feature switch." };
}

async function loadWorker(db: Parameters<typeof getWorkerResources>[0], userId: string) {
  try {
    const [resources, owner] = await Promise.all([getWorkerResources(db), isWorkerResourceOwner(db, userId)]);
    return { ...resources, owner };
  } catch {
    // Worker resource migration not applied on this database yet.
    return null;
  }
}

const STATUS_TEXT: Record<string, string> = {
  healthy: "All systems normal",
  degraded: "Running with problems",
  stale: "Worker is behind",
  missing: "Worker not reporting",
  failed: "Database or Redis down",
};

function heartbeatAge(iso: string | null): string {
  return iso ? formatAge(new Date(iso)) : "never";
}

export default async function AdminControlCenter({ searchParams }: { searchParams: Promise<{ done?: string }> }) {
  const operator = await requirePlatformOperator();
  if (operator.denied) {
    return null;
  }
  const query = await searchParams;
  const db = operator.adminDb ?? getDb();
  const [health, stages, flags, worker] = await Promise.all([
    collectSystemHealth(db),
    operator.adminDb ? countCustomersByStage(operator.adminDb) : Promise.resolve([]),
    operator.adminDb ? listFeatureFlags(operator.adminDb) : Promise.resolve([]),
    operator.adminDb ? loadWorker(operator.adminDb, operator.session.user.id) : Promise.resolve(null),
  ]);
  const config = describePlatformConfig();
  const totalCustomers = stages.reduce((sum, row) => sum + Number(row.count), 0);
  const maxStage = Math.max(1, ...stages.map((row) => Number(row.count)));
  const settings = worker?.settings;
  const canToggleWorker = Boolean(worker?.owner && settings && settings.mode === "free_only");

  return (
    <>
      <AdminHeader
        icon="dashboard"
        title="Control center"
        description="Everything Sentiment is doing right now, with the buttons to steer it."
        actions={
          <StatusPill tone={toneFor(health.status)}>
            {STATUS_TEXT[health.status] ?? health.status}
          </StatusPill>
        }
      />

      {query.done && DONE_TEXT[query.done] ? <Notice tone="good">{DONE_TEXT[query.done]}</Notice> : null}
      {health.status !== "healthy" ? <Notice tone={toneFor(health.status)}>{health.guidance}</Notice> : null}

      <div className="kpi-row five">
        <KpiTile icon="customers" label="Customers" value={totalCustomers.toLocaleString("en-US")} note="All workspaces" href="/admin/customers" />
        <KpiTile icon="cards" label="Cards" value={health.catalogs.printings.toLocaleString("en-US")} note="Exact printings" />
        <KpiTile icon="creators" label="Influencers" value={health.catalogs.creators.toLocaleString("en-US")} note={`${health.catalogs.creatorCalls.toLocaleString("en-US")} calls recorded`} href="/admin/creators" />
        <KpiTile
          icon="quarantine"
          tone={health.catalogs.marketQuarantine + health.catalogs.intelligenceQuarantineOpen > 0 ? "sell" : "neutral"}
          label="Needs review"
          value={(health.catalogs.marketQuarantine + health.catalogs.intelligenceQuarantineOpen).toLocaleString("en-US")}
          note="Quarantined records"
          href="/admin/quarantine"
        />
        <KpiTile
          icon="health"
          tone={health.catalogs.failedJobs > 0 ? "sell" : "buy"}
          label="Failed jobs"
          value={health.catalogs.failedJobs.toLocaleString("en-US")}
          note="Outbox failures"
          href="/admin/health"
        />
      </div>

      <div className="dash-grid two">
        <AdminCard title="Quick actions" icon="rocket" description="Common jobs, one click each">
          <div className="action-list">
            <form className="action-row" action={triggerDiscoveryRunAction}>
              <input type="hidden" name="confirm" value="yes" />
              <input type="hidden" name="returnTo" value="/admin" />
              <span className="action-icon">
                <Icon name="discovery" />
              </span>
              <span className="action-text">
                <strong>Find new influencers</strong>
                <span className="action-fields">
                  <select name="providerKey" defaultValue="youtube" aria-label="Where to search">
                    <option value="youtube">YouTube</option>
                    <option value="reddit">Reddit</option>
                  </select>
                  <input name="query" defaultValue="Pokemon TCG investing" aria-label="Search words" />
                </span>
              </span>
              <ConfirmButton message="Queue a discovery run now? It uses the free API quota." pendingLabel="Queuing…">
                <Icon name="play" size={14} />
                Run
              </ConfirmButton>
            </form>
            <div className="action-row">
              <span className="action-icon">
                <Icon name="beta" />
              </span>
              <span className="action-text">
                <strong>Invite someone to the beta</strong>
                <span className="subtle">Make a one-time invite link</span>
              </span>
              <Link className="button secondary" href="/admin/beta#invite">
                <Icon name="plus" size={14} />
                Invite
              </Link>
            </div>
            <div className="action-row">
              <span className="action-icon">
                <Icon name="creators" />
              </span>
              <span className="action-text">
                <strong>Add an influencer</strong>
                <span className="subtle">Website, podcast or TikTok account</span>
              </span>
              <Link className="button secondary" href="/admin/sources#websites">
                <Icon name="plus" size={14} />
                Add
              </Link>
            </div>
            <div className="action-row">
              <span className="action-icon">
                <Icon name="quarantine" />
              </span>
              <span className="action-text">
                <strong>Review quarantined records</strong>
                <span className="subtle">Approve, retry or dismiss bad data</span>
              </span>
              <Link className="button secondary" href="/admin/quarantine">
                Review
              </Link>
            </div>
            <div className="action-row">
              <span className="action-icon">
                <Icon name="support" />
              </span>
              <span className="action-text">
                <strong>Open a support case</strong>
                <span className="subtle">Track a customer problem</span>
              </span>
              <Link className="button secondary" href="/admin/support">
                Open
              </Link>
            </div>
          </div>
        </AdminCard>

        <AdminCard
          title="Background worker"
          icon="refresh"
          description="Pulls prices, transcripts and calls, then rescores cards"
          actions={
            <Link className="text-link" href="/admin/health">
              Details
            </Link>
          }
        >
          <dl className="fact-grid">
            <div>
              <dt>Heartbeat</dt>
              <dd>
                <StatusPill tone={toneFor(health.operations.workerHeartbeatStatus)}>{health.operations.workerHeartbeatStatus}</StatusPill>
              </dd>
            </div>
            <div>
              <dt>Last seen</dt>
              <dd>{heartbeatAge(health.operations.workerHeartbeatAt)}</dd>
            </div>
            <div>
              <dt>Schedule</dt>
              <dd>{settings ? (settings.enabled ? `Every ${settings.interval_hours}h` : "Paused") : "Not set up"}</dd>
            </div>
            <div>
              <dt>Mode</dt>
              <dd>{settings ? (settings.mode === "free_only" ? "Free only" : "Metered Redis") : "—"}</dd>
            </div>
          </dl>
          {settings && canToggleWorker ? (
            <form className="worker-toggle" action={updateWorkerResourcesAction}>
              <input type="hidden" name="returnTo" value="/admin" />
              <input type="hidden" name="enabled" value={settings.enabled ? "false" : "true"} />
              <input type="hidden" name="mode" value={settings.mode} />
              <input type="hidden" name="intervalHours" value={String(settings.interval_hours)} />
              <input type="hidden" name="maxJobs" value={String(settings.max_jobs)} />
              <ConfirmButton
                className={settings.enabled ? "button danger" : "button success"}
                message={settings.enabled ? "Pause the scheduled worker? Prices and scores stop updating until you resume." : "Resume the scheduled worker?"}
                pendingLabel="Saving…"
              >
                <Icon name={settings.enabled ? "pause" : "play"} size={14} />
                {settings.enabled ? "Pause worker" : "Resume worker"}
              </ConfirmButton>
            </form>
          ) : settings && !worker?.owner ? (
            <p className="subtle">Only the original platform owner can pause or resume the worker.</p>
          ) : null}
          {worker && worker.runs.length > 0 ? (
            <>
              <h3 className="card-subhead">Recent batches</h3>
              <ul className="run-list">
                {worker.runs.slice(0, 4).map((run) => (
                  <li key={run.id}>
                    <StatusPill tone={toneFor(run.status)}>{run.status}</StatusPill>
                    <span className="subtle">{run.slot}</span>
                    <span className="run-counts">
                      {run.processed}/{run.attempted} done{run.failures > 0 ? ` · ${run.failures} failed` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </AdminCard>
      </div>

      <AdminCard
        title="Data sources"
        icon="sources"
        description="Where prices, videos and posts come from"
        actions={
          <Link className="text-link" href="/admin/sources">
            Manage sources
          </Link>
        }
      >
        {health.providers.length === 0 ? (
          <p className="signal-empty">No sources are registered yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Status</th>
                  <th scope="col">Mode</th>
                  <th scope="col">Last success</th>
                  <th scope="col">
                    <span className="visually-hidden">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {health.providers.map((row) => {
                  const state = !row.enabled ? "disabled" : row.paused ? "paused" : row.health;
                  return (
                    <tr key={row.provider}>
                      <td>
                        <strong>{providerText(row.provider)}</strong>
                        {row.lastErrorClass ? <span className="cell-note">Last error: {row.lastErrorClass}</span> : null}
                      </td>
                      <td>
                        <StatusPill tone={state === "disabled" ? "info" : toneFor(state)}>{state}</StatusPill>
                      </td>
                      <td>{row.mode}</td>
                      <td>{row.lastSuccessAt ? formatAge(new Date(row.lastSuccessAt)) : "never"}</td>
                      <td>
                        <div className="row-actions">
                          <form action={triggerProviderSyncAction}>
                            <input type="hidden" name="providerKey" value={row.provider} />
                            <input type="hidden" name="confirm" value="yes" />
                            <input type="hidden" name="returnTo" value="/admin" />
                            <ConfirmButton className="button small secondary" message={`Sync ${providerText(row.provider)} now?`} pendingLabel="Queuing…">
                              <Icon name="refresh" size={14} />
                              Sync now
                            </ConfirmButton>
                          </form>
                          <form action={setProviderPausedAction}>
                            <input type="hidden" name="providerKey" value={row.provider} />
                            <input type="hidden" name="paused" value={row.paused ? "false" : "true"} />
                            <input type="hidden" name="reason" value={row.paused ? "Resumed from the control center" : "Paused from the control center"} />
                            <input type="hidden" name="returnTo" value="/admin" />
                            <ConfirmButton
                              className="button small secondary"
                              message={row.paused ? `Resume ${providerText(row.provider)}?` : `Pause ${providerText(row.provider)}? It stops pulling new data.`}
                              pendingLabel="Saving…"
                            >
                              <Icon name={row.paused ? "play" : "pause"} size={14} />
                              {row.paused ? "Resume" : "Pause"}
                            </ConfirmButton>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </AdminCard>

      <div className="dash-grid two">
        <AdminCard title="Feature switches" icon="flag" description="Turn platform features on or off for everyone">
          {flags.length === 0 ? (
            <p className="signal-empty">Feature switches need the platform admin database role.</p>
          ) : (
            <ul className="switch-list">
              {flags.map((flag) => {
                const text = flagText(flag.flagKey);
                return (
                  <li key={flag.flagKey}>
                    <span className="switch-text">
                      <strong>{text.label}</strong>
                      <span className="subtle">{text.body}</span>
                    </span>
                    <form action={setFeatureFlagAction}>
                      <input type="hidden" name="key" value={flag.flagKey} />
                      <input type="hidden" name="enabled" value={flag.enabled ? "false" : "true"} />
                      <input type="hidden" name="returnTo" value="/admin" />
                      <button
                        type="submit"
                        className={`switch${flag.enabled ? " on" : ""}`}
                        role="switch"
                        aria-checked={flag.enabled}
                        aria-label={`${text.label}: ${flag.enabled ? "on" : "off"}`}
                      >
                        <span className="switch-knob" />
                      </button>
                    </form>
                  </li>
                );
              })}
            </ul>
          )}
        </AdminCard>

        <AdminCard
          title="Customers by stage"
          icon="customers"
          description="Where each workspace is in its lifecycle"
          actions={
            <Link className="text-link" href="/admin/customers">
              All customers
            </Link>
          }
        >
          {stages.length === 0 ? (
            <p className="signal-empty">Customer listings need the platform admin database role.</p>
          ) : (
            <ul className="bar-list">
              {stages.map((row) => (
                <li key={row.lifecycleStage}>
                  <span className="bar-label">{row.lifecycleStage.replaceAll("_", " ")}</span>
                  <span className="bar-track">
                    <span className="bar-fill" style={{ width: `${(Number(row.count) / maxStage) * 100}%` }} />
                  </span>
                  <strong>{Number(row.count).toLocaleString("en-US")}</strong>
                </li>
              ))}
            </ul>
          )}
        </AdminCard>
      </div>

      <p className="admin-footnote">
        Runtime {config.nodeEnv} · billing {config.billingMode} · email {config.emailMode} · signed in through{" "}
        {operator.access.source}. Every action here is audited, and secrets are never shown.{" "}
        <Link className="text-link" href="/admin/config">
          Configuration
        </Link>
      </p>
    </>
  );
}
