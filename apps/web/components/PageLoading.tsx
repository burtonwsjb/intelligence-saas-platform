/**
 * Shown the moment a signed-in link is clicked, while the server builds the
 * next page. Without it a click on a slow page looks like it did nothing.
 */
export function PageLoading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="page-loading" role="status" aria-live="polite" aria-busy="true">
      <div className="page-loading-bar" aria-hidden="true" />
      <span className="visually-hidden">{label}…</span>
      <div className="page-loading-header" aria-hidden="true">
        <span className="skeleton skeleton-eyebrow" />
        <span className="skeleton skeleton-title" />
        <span className="skeleton skeleton-line" />
      </div>
      <div className="page-loading-grid" aria-hidden="true">
        {[0, 1, 2, 3].map((index) => (
          <span key={index} className="skeleton skeleton-tile" />
        ))}
      </div>
      <span className="skeleton skeleton-panel" aria-hidden="true" />
    </div>
  );
}
