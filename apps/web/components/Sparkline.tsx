import { sparklinePath } from "@isp/db";

export function Sparkline({ values, label }: { values: number[]; label: string }) {
  const d = sparklinePath(values);
  if (!d) {
    return <p className="muted">No {label} series yet.</p>;
  }
  return (
    <svg className="sparkline" viewBox="0 0 160 36" role="img" aria-label={label}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
