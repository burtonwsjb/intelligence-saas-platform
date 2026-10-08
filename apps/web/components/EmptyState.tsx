import type { ReactNode } from "react";

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <p>
        <strong>{title}</strong>
      </p>
      <p className="muted">{body}</p>
      {action ? <p>{action}</p> : null}
    </div>
  );
}

export function LockedFeature({ title, body }: { title: string; body: string }) {
  return (
    <>
      <h1>{title}</h1>
      <div className="empty-state">
        <p>
          <strong>Not available on this workspace</strong>
        </p>
        <p className="muted">{body}</p>
      </div>
    </>
  );
}
