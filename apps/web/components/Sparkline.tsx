import { sparklinePath } from "@isp/db";

export function Sparkline({ values, label }: { values: number[]; label: string }) {
  const d = sparklinePath(values, 120, 32);
  if (!d || values.length < 2) {
    return <span className="spark-empty">No {label} yet</span>;
  }
  return (
    <svg className="sparkline" viewBox="-2 -2 124 36" role="img" aria-label={label} preserveAspectRatio="none">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
