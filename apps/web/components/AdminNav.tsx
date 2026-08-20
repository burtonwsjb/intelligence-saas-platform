import Link from "next/link";

const ITEMS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/customers", label: "Customers" },
  { href: "/admin/creators", label: "Creators" },
  { href: "/admin/indices", label: "Indices" },
  { href: "/admin/sources", label: "Sources" },
  { href: "/admin/predictions", label: "Predictions" },
  { href: "/admin/support", label: "Support" },
  { href: "/admin/health", label: "Health" },
  { href: "/admin/config", label: "Config" },
  { href: "/admin/audit", label: "Audit" },
] as const;

export function AdminNav() {
  return (
    <nav className="app-nav" aria-label="Platform admin">
      {ITEMS.map((item) => (
        <Link key={item.href} href={item.href}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
