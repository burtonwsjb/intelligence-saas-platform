import Link from "next/link";

export function CompactStat({
  label,
  value,
  note,
  href,
}: {
  label: string;
  value: string | number;
  note?: string;
  href?: string;
}) {
  const body = (
    <>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {note ? <span className="stat-note">{note}</span> : null}
    </>
  );
  return href ? (
    <Link className="stat" href={href} style={{ textDecoration: "none" }}>
      {body}
    </Link>
  ) : (
    <div className="stat">{body}</div>
  );
}
