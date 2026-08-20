export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="empty-state">
      <p>
        <strong>{title}</strong>
      </p>
      <p className="muted">{body}</p>
    </div>
  );
}

export function LockedFeature({ title, body }: { title: string; body: string }) {
  return (
    <>
      <h1>{title}</h1>
      <p className="muted">{body}</p>
    </>
  );
}
