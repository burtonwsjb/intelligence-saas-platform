import Link from "next/link";

export function ResultPager({
  page,
  pageCount,
  total,
  pageSize,
  hrefFor,
  sizes,
  hrefForSize,
  noun = "results",
}: {
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
  hrefFor: (page: number) => string;
  sizes?: readonly number[];
  hrefForSize?: (size: number) => string;
  noun?: string;
}) {
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);
  return (
    <nav className="pager" aria-label="Pagination">
      <span aria-live="polite">
        {total === 0 ? `No ${noun}` : `${first}–${last} of ${total.toLocaleString("en-US")} ${noun}`}
        {pageCount > 1 ? ` · page ${Math.min(page, pageCount)} of ${pageCount}` : ""}
      </span>
      {sizes && hrefForSize ? (
        <span className="page-size">
          <span className="subtle">Per page</span>
          <span className="segmented">
            {sizes.map((size) => (
              <Link key={size} href={hrefForSize(size)} aria-pressed={size === pageSize}>
                {size}
              </Link>
            ))}
          </span>
        </span>
      ) : null}
      <span className="pager-links">
        {page > 1 ? (
          <Link href={hrefFor(Math.min(page - 1, pageCount))} rel="prev">
            ← Previous
          </Link>
        ) : (
          <span className="disabled" aria-disabled="true">
            ← Previous
          </span>
        )}
        {page < pageCount ? (
          <Link href={hrefFor(page + 1)} rel="next">
            Next →
          </Link>
        ) : (
          <span className="disabled" aria-disabled="true">
            Next →
          </span>
        )}
      </span>
    </nav>
  );
}

/** Simple previous/next pager for panels whose total is not counted. */
export function MorePager({ page, hasMore, hrefFor }: { page: number; hasMore: boolean; hrefFor: (page: number) => string }) {
  if (page <= 1 && !hasMore) return null;
  return (
    <nav className="pager" aria-label="Pagination">
      <span>Page {page}</span>
      <span className="pager-links">
        {page > 1 ? <Link href={hrefFor(page - 1)}>← Newer</Link> : <span className="disabled">← Newer</span>}
        {hasMore ? <Link href={hrefFor(page + 1)}>Older →</Link> : <span className="disabled">Older →</span>}
      </span>
    </nav>
  );
}
