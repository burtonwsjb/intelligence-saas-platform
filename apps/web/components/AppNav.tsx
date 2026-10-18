"use client";

import { activeNavKey } from "@/lib/nav";
import type { AppNavItem } from "@isp/db";
import Link from "next/link";
import { usePathname } from "next/navigation";

const GROUP_LABEL = { primary: "Explore", developer: "Developer", account: "Account" } as const;

function NavLinks({ items, active, unread }: { items: AppNavItem[]; active: string | null; unread: number }) {
  return (
    <>
      {items.map((item) => (
        <Link
          key={item.key}
          href={item.href}
          className={`nav-link${item.parent ? " nav-sub" : ""}`}
          aria-current={item.key === active ? "page" : undefined}
        >
          <span>{item.label}</span>
          {item.key === "overview" && unread > 0 ? (
            <span className="nav-count" aria-label={`${unread} unread updates`}>
              {unread}
            </span>
          ) : null}
        </Link>
      ))}
    </>
  );
}

export function AppNav({
  items,
  unread,
  workspaceName,
}: {
  items: AppNavItem[];
  unread: number;
  workspaceName: string | null;
}) {
  const pathname = usePathname() ?? "/app";
  const active = activeNavKey(items, pathname);
  const primary = items.filter((item) => item.group === "primary");
  const secondary = (["developer", "account"] as const).map((group) => ({
    group,
    items: items.filter((item) => item.group === group),
  }));
  const secondaryActive = secondary.some((entry) => entry.items.some((item) => item.key === active));
  return (
    <nav className="app-nav" aria-label="Application">
      {workspaceName ? (
        <div className="nav-workspace">
          <span className="subtle">Workspace</span>
          <strong title={workspaceName}>{workspaceName}</strong>
        </div>
      ) : null}
      <div className="nav-group primary">
        <p className="nav-group-label">{GROUP_LABEL.primary}</p>
        <NavLinks items={primary} active={active} unread={unread} />
      </div>
      {secondary.map((entry) =>
        entry.items.length > 0 ? (
          <div className="nav-group secondary" key={entry.group}>
            <p className="nav-group-label">{GROUP_LABEL[entry.group]}</p>
            <NavLinks items={entry.items} active={active} unread={unread} />
          </div>
        ) : null,
      )}
      <details className="nav-more" open={secondaryActive}>
        <summary>More: developer tools and account</summary>
        {secondary.map((entry) =>
          entry.items.length > 0 ? (
            <div className="nav-group" key={entry.group}>
              <p className="nav-group-label">{GROUP_LABEL[entry.group]}</p>
              <NavLinks items={entry.items} active={active} unread={unread} />
            </div>
          ) : null,
        )}
      </details>
    </nav>
  );
}
