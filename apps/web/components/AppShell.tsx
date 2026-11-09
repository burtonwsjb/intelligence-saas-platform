"use client";

import { signOutAction } from "@/app/actions";
import { BrandMark, Icon, type IconName } from "@/components/Icon";
import { activeNavKey } from "@/lib/nav";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";

export type ShellNavItem = { key: string; href: string; label: string; icon: IconName; count?: number; sub?: boolean };
export type ShellNavSection = { label: string | null; items: ShellNavItem[] };

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1]![0] : "")).toUpperCase();
}

/**
 * The signed-in frame for both the customer app and the operator console:
 * a dark sidebar with grouped, icon-led navigation, a sticky top bar with
 * card search, and a drawer on phones.
 */
export function AppShell({
  context,
  sections,
  user,
  workspaceName,
  isOperator,
  unread = 0,
  children,
}: {
  context: "app" | "admin";
  sections: ShellNavSection[];
  user: { name: string; email: string };
  workspaceName?: string | null;
  isOperator: boolean;
  unread?: number;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? "/app";
  const [open, setOpen] = useState(false);
  const all = sections.flatMap((section) => section.items);
  const active = activeNavKey(all, pathname);

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <div className={`app-frame ${context === "admin" ? "is-admin" : ""}`} data-drawer={open ? "open" : "closed"}>
      <aside className="sidebar" aria-label={context === "admin" ? "Admin navigation" : "Application navigation"}>
        <div className="sidebar-top">
          <Link className="sidebar-brand" href={context === "admin" ? "/admin" : "/app"}>
            <BrandMark size={30} />
            <span>
              Sentiment
              {context === "admin" ? <em className="sidebar-brand-tag">Admin</em> : null}
            </span>
          </Link>
          <button className="sidebar-close" type="button" onClick={() => setOpen(false)} aria-label="Close menu">
            <Icon name="close" />
          </button>
        </div>

        {context === "app" && workspaceName ? (
          <div className="sidebar-workspace">
            <span className="sidebar-workspace-avatar" aria-hidden="true">
              {initials(workspaceName)}
            </span>
            <span className="sidebar-workspace-text">
              <small>Workspace</small>
              <strong title={workspaceName}>{workspaceName}</strong>
            </span>
          </div>
        ) : null}

        <nav className="sidebar-nav">
          {sections.map((section, index) =>
            section.items.length === 0 ? null : (
              <div className="sidebar-section" key={section.label ?? index}>
                {section.label ? <p className="sidebar-section-label">{section.label}</p> : null}
                {section.items.map((item) => (
                  <Link
                    key={item.key}
                    href={item.href}
                    className={`sidebar-link${item.sub ? " is-sub" : ""}`}
                    aria-current={item.key === active ? "page" : undefined}
                  >
                    <Icon name={item.icon} />
                    <span className="sidebar-link-label">{item.label}</span>
                    {item.count && item.count > 0 ? (
                      <span className="sidebar-count" aria-label={`${item.count} unread`}>
                        {item.count > 99 ? "99+" : item.count}
                      </span>
                    ) : null}
                  </Link>
                ))}
              </div>
            ),
          )}
        </nav>

        <div className="sidebar-bottom">
          {isOperator ? (
            context === "admin" ? (
              <Link className="sidebar-switch" href="/app">
                <Icon name="dashboard" />
                <span>Back to the app</span>
              </Link>
            ) : (
              <Link className="sidebar-switch" href="/admin">
                <Icon name="shield" />
                <span>Admin console</span>
              </Link>
            )
          ) : null}
          <div className="sidebar-user">
            <span className="sidebar-avatar" aria-hidden="true">
              {initials(user.name || user.email)}
            </span>
            <span className="sidebar-user-text">
              <strong>{user.name || "Signed in"}</strong>
              <small title={user.email}>{user.email}</small>
            </span>
            <form action={signOutAction}>
              <button className="sidebar-signout" type="submit" title="Sign out" aria-label="Sign out">
                <Icon name="logout" />
              </button>
            </form>
          </div>
        </div>
      </aside>
      <button className="sidebar-scrim" type="button" aria-label="Close menu" tabIndex={-1} onClick={() => setOpen(false)} />

      <div className="app-main">
        <header className="topbar">
          <button className="topbar-menu" type="button" onClick={() => setOpen(true)} aria-label="Open menu">
            <Icon name="menu" size={20} />
          </button>
          <Link className="topbar-brand" href={context === "admin" ? "/admin" : "/app"}>
            <BrandMark size={26} />
          </Link>
          <form className="topbar-search" action="/app/cards" role="search">
            <Icon name="search" />
            <label className="visually-hidden" htmlFor="topbar-q">
              Search cards
            </label>
            <input id="topbar-q" name="q" type="search" placeholder="Search cards, sets or numbers" autoComplete="off" />
          </form>
          <div className="topbar-actions">
            {context === "app" ? (
              <Link className="topbar-icon" href="/app" aria-label={`${unread} unread updates`} title="Updates">
                <Icon name="bell" />
                {unread > 0 ? <span className="topbar-dot" /> : null}
              </Link>
            ) : (
              <span className="topbar-pill">
                <Icon name="shield" size={14} />
                Operator
              </span>
            )}
          </div>
        </header>
        <div className="app-content">{children}</div>
        <footer className="app-footer">
          <nav aria-label="Legal">
            <Link href="/terms">Terms</Link>
            <Link href="/privacy">Privacy</Link>
            <Link href="/acceptable-use">Acceptable use</Link>
            <Link href="/api-terms">API terms</Link>
          </nav>
          <p>
            Card images and names belong to their owners, including The Pokémon Company, Nintendo, Bandai, Shueisha,
            Toei Animation and Konami. Sentiment is not affiliated with or endorsed by them.
          </p>
        </footer>
      </div>
    </div>
  );
}
