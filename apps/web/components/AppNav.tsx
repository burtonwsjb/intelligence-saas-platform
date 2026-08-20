import Link from "next/link";
import type { AppNavItem } from "@isp/db";

export function AppNav({ items, unread }: { items: AppNavItem[]; unread: number }) {
  return (
    <nav className="app-nav" aria-label="Application">
      {items.map((item) => (
        <Link key={item.key} href={item.href}>
          {item.label}
          {item.key === "overview" && unread > 0 ? ` (${unread})` : ""}
        </Link>
      ))}
    </nav>
  );
}
