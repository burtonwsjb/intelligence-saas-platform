import { Badge, StatusBadge } from "@/components/Badge";
import { DEFAULT_EVALUATION_DAYS } from "@isp/db";

export const CALL_DIRECTION_TEXT: Record<string, string> = {
  bullish: "Said it would go up",
  bearish: "Said it would go down",
  neutral: "Neutral",
  hold: "Hold",
};

export function callDirectionText(direction: string): string {
  return CALL_DIRECTION_TEXT[direction] ?? direction.replaceAll("_", " ");
}

export function callHorizonText(horizonCode: string): string {
  return horizonCode !== "unspecified"
    ? `within ${horizonCode.replaceAll("_", " ")}`
    : `no deadline given, judged after ${DEFAULT_EVALUATION_DAYS} days`;
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
    return <Badge>Evaluated, no clear direction</Badge>;
  }
  if (outcomeStatus === "insufficient_data") return <Badge>Not enough price data</Badge>;
  if (outcomeStatus && outcomeStatus !== "pending") return <Badge>{outcomeStatus.replaceAll("_", " ")}</Badge>;
  return <Badge tone="info">Waiting for the market</Badge>;
}
