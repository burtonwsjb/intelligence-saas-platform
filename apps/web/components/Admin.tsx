import { Icon, type IconName } from "@/components/Icon";
import type { ReactNode } from "react";

export type Tone = "good" | "warn" | "bad" | "info";

const TONE_WORD: Record<string, Tone> = {
  healthy: "good",
  ok: "good",
  live: "good",
  enabled: "good",
  completed: "good",
  degraded: "warn",
  stale: "warn",
  paused: "warn",
  running: "info",
  fixture: "info",
  missing: "bad",
  failed: "bad",
  error: "bad",
  indeterminate: "warn",
};

export function toneFor(value: string | null | undefined): Tone {
  return (value && TONE_WORD[value.toLowerCase()]) || "info";
}

/** A colored dot plus a word: color never carries the meaning on its own. */
export function StatusPill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`status-pill ${tone}`}>
      <span className="status-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

/** Page header used across the operator console. */
export function AdminHeader({
  icon,
  title,
  description,
  actions,
}: {
  icon: IconName;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="admin-header">
      <span className="admin-header-icon" aria-hidden="true">
        <Icon name={icon} size={22} />
      </span>
      <div className="admin-header-text">
        <h1>{title}</h1>
        {description ? <p className="muted">{description}</p> : null}
      </div>
      {actions ? <div className="admin-header-actions">{actions}</div> : null}
    </header>
  );
}

/** A titled white card that groups one admin task. */
export function AdminCard({
  title,
  icon,
  description,
  actions,
  children,
  id,
}: {
  title: string;
  icon?: IconName;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
}) {
  return (
    <section className="dash-card admin-card" id={id} aria-label={title}>
      <div className="dash-card-head">
        <div className="admin-card-title">
          {icon ? (
            <span className="admin-card-icon" aria-hidden="true">
              <Icon name={icon} size={16} />
            </span>
          ) : null}
          <div>
            <h2>{title}</h2>
            {description ? <p className="subtle">{description}</p> : null}
          </div>
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Notice({ tone = "info", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role="status">
      {children}
    </div>
  );
}
