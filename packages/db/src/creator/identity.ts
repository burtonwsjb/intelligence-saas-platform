import { createHash } from "node:crypto";

export const CREATOR_CALL_DIRECTIONS = [
  "bullish",
  "bearish",
  "neutral",
  "watch",
  "avoid",
  "unknown",
] as const;
export type CreatorCallDirection = (typeof CREATOR_CALL_DIRECTIONS)[number];

export const CREATOR_CALL_HORIZONS = ["7d", "30d", "90d", "180d", "365d", "custom", "unspecified"] as const;
export type CreatorCallHorizon = (typeof CREATOR_CALL_HORIZONS)[number];

export const CREATOR_EXTRACTOR_VERSION = "creator.extract.v1";
export const CREATOR_PRICE_AT_CALL_VERSION = "price_at_call.v1";
export const CREATOR_LLM_EXTRACTOR_VERSION = "creator.llm.fixture.v1";

export class CreatorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CreatorValidationError";
  }
}

export type ExtractedCallCandidate = {
  is_call: boolean;
  direction: CreatorCallDirection;
  target_price: number | null;
  target_percent: number | null;
  horizon_code: CreatorCallHorizon;
  horizon_custom_days: number | null;
  stated_confidence: number | null;
  extraction_confidence: number;
  evidence: string[];
};

export function fingerprintCreatorCall(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

export function stableCreatorId(parts: string[]): string {
  return `crt_${createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 32)}`;
}

export function parseDirection(value: unknown): CreatorCallDirection {
  if (typeof value !== "string" || !(CREATOR_CALL_DIRECTIONS as readonly string[]).includes(value)) {
    throw new CreatorValidationError("call direction is invalid.");
  }
  return value as CreatorCallDirection;
}

export function parseHorizon(value: unknown): CreatorCallHorizon {
  if (typeof value !== "string" || !(CREATOR_CALL_HORIZONS as readonly string[]).includes(value)) {
    throw new CreatorValidationError("call horizon is invalid.");
  }
  return value as CreatorCallHorizon;
}

export function mayBindCallPrinting(status: string): boolean {
  return status === "exact" || status === "high_confidence";
}

export function validateExtractedCall(raw: unknown): ExtractedCallCandidate | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  if (value.is_call !== true) {
    return null;
  }
  try {
    const direction = parseDirection(value.direction);
    const horizon_code = value.horizon_code == null ? "unspecified" : parseHorizon(value.horizon_code);
    const target_price =
      value.target_price == null || value.target_price === "" ? null : Number(value.target_price);
    const target_percent =
      value.target_percent == null || value.target_percent === "" ? null : Number(value.target_percent);
    const stated =
      value.stated_confidence == null || value.stated_confidence === ""
        ? null
        : Number(value.stated_confidence);
    const extraction_confidence = Number(value.extraction_confidence ?? 0.7);
    if (target_price != null && !Number.isFinite(target_price)) {
      return null;
    }
    if (target_percent != null && !Number.isFinite(target_percent)) {
      return null;
    }
    if (stated != null && (stated < 0 || stated > 1)) {
      return null;
    }
    if (!Number.isFinite(extraction_confidence) || extraction_confidence < 0 || extraction_confidence > 1) {
      return null;
    }
    return {
      is_call: true,
      direction,
      target_price,
      target_percent,
      horizon_code,
      horizon_custom_days:
        horizon_code === "custom" && value.horizon_custom_days != null
          ? Number(value.horizon_custom_days)
          : null,
      stated_confidence: stated,
      extraction_confidence,
      evidence: Array.isArray(value.evidence) ? value.evidence.map(String) : ["untrusted_model_candidate"],
    };
  } catch {
    return null;
  }
}
