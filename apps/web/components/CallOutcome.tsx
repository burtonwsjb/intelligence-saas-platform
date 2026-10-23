import { Badge, StatusBadge } from "@/components/Badge";
import { DEFAULT_EVALUATION_DAYS } from "@isp/db";

export const CALL_DIRECTION_TEXT: Record<string, string> = {
  bullish: "Said it would go up",
  bearish: "Said it would go down",
  neutral: "Hold",
  hold: "Hold",
  avoid: "Said to avoid it",
  watch: "Watching it",
};

export function callDirectionText(direction: string): string {
  return CALL_DIRECTION_TEXT[direction] ?? direction.replaceAll("_", " ");
}

export function callHorizonText(horizonCode: string): string {
  if (horizonCode === "unspecified") return `no deadline given, judged after ${DEFAULT_EVALUATION_DAYS} days`;
  if (horizonCode === "custom") return "by a date the creator gave";
  const match = horizonCode.match(/^(\d+)([dwmy])$/);
  if (!match) return `within ${horizonCode.replaceAll("_", " ")}`;
  const n = Number(match[1]);
  const unit = { d: "day", w: "week", m: "month", y: "year" }[match[2] as "d" | "w" | "m" | "y"];
  return `within ${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** How a call turned out: came true, did not, still waiting, or why it cannot be judged. */
export function CallOutcomeBadge({
  identified,
  outcomeStatus,
  directionalCorrect,
  unidentifiedLabel = "Card not identified",
}: {
  identified: boolean;
  outcomeStatus: string | null;
  directionalCorrect: string | null;
  unidentifiedLabel?: string;
}) {
  if (!identified) return <Badge>{unidentifiedLabel}</Badge>;
  if (outcomeStatus === "evaluated") {
    if (directionalCorrect === "correct") return <StatusBadge tone="good" label="Came true" />;
    if (directionalCorrect === "incorrect") return <StatusBadge tone="warn" label="Did not come true" />;
    if (directionalCorrect === "flat") return <StatusBadge tone="warn" label="Price stayed flat" />;
    return <Badge>Evaluated, no clear direction</Badge>;
  }
  if (outcomeStatus === "insufficient_data") return <Badge>Not enough price data</Badge>;
  if (outcomeStatus && outcomeStatus !== "pending") {
    const text = outcomeStatus.replaceAll("_", " ");
    return <Badge>{text.charAt(0).toUpperCase() + text.slice(1)}</Badge>;
  }
  return <Badge tone="info">Waiting for the market</Badge>;
}
