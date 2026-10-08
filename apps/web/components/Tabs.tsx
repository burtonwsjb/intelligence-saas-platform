import Link from "next/link";

export function Tabs({
  label,
  tabs,
  active,
}: {
  label: string;
  tabs: { key: string; label: string; href: string }[];
  active: string;
}) {
  return (
    <nav className="tabs" aria-label={label}>
      {tabs.map((tab) => (
        <Link key={tab.key} href={tab.href} aria-current={tab.key === active ? "page" : undefined} scroll={false}>
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
