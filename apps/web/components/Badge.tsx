import type { ReactNode } from "react";

export function Badge({
  tone,
  children,
  title,
}: {
  tone?: "good" | "warn" | "bad" | "info" | "solid";
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`badge${tone ? ` ${tone}` : ""}`} title={title}>
      {children}
    </span>
  );
}

const TONE_ICON = { good: "●", warn: "▲", info: "○" } as const;

/** Status badge: the shape and the words carry the meaning, color only reinforces it. */
export function StatusBadge({ tone, label }: { tone: "good" | "warn" | "info"; label: string }) {
  return (
    <Badge tone={tone}>
      <span aria-hidden="true">{TONE_ICON[tone]}</span>
      {label}
    </Badge>
  );
}
