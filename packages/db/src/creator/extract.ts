import type { ExtractedCallCandidate } from "./identity.js";
import { CREATOR_EXTRACTOR_VERSION, CREATOR_LLM_EXTRACTOR_VERSION, validateExtractedCall } from "./identity.js";

export type CallExtractionInput = {
  text: string;
  mentionContext?: string | null;
  candidatePrice?: string | null;
  candidatePercent?: string | null;
  candidateTimeframe?: string | null;
};

const BULLISH = [
  /will go up/i,
  /going up/i,
  /i would buy/i,
  /\bbuy\b/i,
  /undervalued/i,
  /target\s*\$/i,
  /上がる/,
  /買う/,
];
const BEARISH = [/sell now/i, /\bsell\b/i, /overpriced/i, /going down/i, /will drop/i, /下がる/, /売る/];
const WATCH = [/keep an eye/i, /\bwatch\b/i];
const AVOID = [/\bavoid\b/i, /stay away/i];
const NON_CALL = [/i pulled/i, /this card exists/i, /price is \$/i, /just a pull/i];

function matches(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function inferHorizon(text: string, candidateTimeframe?: string | null): ExtractedCallCandidate["horizon_code"] {
  const blob = `${text} ${candidateTimeframe ?? ""}`.toLowerCase();
  if (/\b365\s*d\b|\b1\s*year\b|\ba year\b/.test(blob)) {
    return "365d";
  }
  if (/\b180\s*d\b|\b6\s*months?\b/.test(blob)) {
    return "180d";
  }
  if (/\b90\s*d\b|\b3\s*months?\b/.test(blob)) {
    return "90d";
  }
  if (/\b30\s*d\b|\b30\s*days?\b|\b1\s*month\b|\ba month\b/.test(blob)) {
    return "30d";
  }
  if (/\b7\s*d\b|\b7\s*days?\b|\ba week\b|\b1\s*week\b/.test(blob)) {
    return "7d";
  }
  if (/\b(\d+)\s*days?\b/.test(blob) || /\bin two weeks\b/.test(blob)) {
    return "custom";
  }
  return "unspecified";
}

function customDays(text: string, horizon: string): number | null {
  if (horizon !== "custom") {
    return null;
  }
  const days = text.match(/\b(\d+)\s*days?\b/i);
  if (days) {
    return Number(days[1]);
  }
  if (/two weeks/i.test(text)) {
    return 14;
  }
  return null;
}

function inferTargetPrice(text: string, candidatePrice?: string | null): number | null {
  if (candidatePrice) {
    const n = Number(candidatePrice);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  const match = text.match(/target\s*\$?\s*([0-9]+(?:\.[0-9]+)?)/i) ?? text.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
  return match ? Number(match[1]) : null;
}

function inferTargetPercent(text: string, candidatePercent?: string | null): number | null {
  if (candidatePercent) {
    const n = Number(candidatePercent);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*%/);
  return match ? Number(match[1]) : null;
}

function inferStatedConfidence(text: string): number | null {
  const match = text.match(/\b([0-9]{1,3})\s*%\s*(sure|confident)/i);
  if (!match) {
    return null;
  }
  const n = Number(match[1]) / 100;
  return n >= 0 && n <= 1 ? n : null;
}

export function extractCallDeterministic(input: CallExtractionInput): ExtractedCallCandidate | null {
  const text = input.text.trim();
  if (!text) {
    return null;
  }
  if (matches(NON_CALL, text) && !matches([...BULLISH, ...BEARISH, ...WATCH, ...AVOID], text)) {
    return null;
  }
  if (input.mentionContext === "pull" && !matches([...BULLISH, ...BEARISH], text)) {
    return null;
  }
  if (input.mentionContext === "price" && !matches([...BULLISH, ...BEARISH, ...WATCH, ...AVOID], text)) {
    return null;
  }
  let direction: ExtractedCallCandidate["direction"] | null = null;
  const evidence: string[] = [`extractor:${CREATOR_EXTRACTOR_VERSION}`];
  if (matches(BULLISH, text)) {
    direction = "bullish";
    evidence.push("buy_or_up_language");
  } else if (matches(BEARISH, text)) {
    direction = "bearish";
    evidence.push("sell_or_down_language");
  } else if (matches(AVOID, text)) {
    direction = "avoid";
    evidence.push("avoid_language");
  } else if (matches(WATCH, text)) {
    direction = "watch";
    evidence.push("watch_language");
  }
  if (!direction) {
    return null;
  }
  const horizon_code = inferHorizon(text, input.candidateTimeframe);
  if (horizon_code !== "unspecified") {
    evidence.push("explicit_horizon");
  }
  const target_price = inferTargetPrice(text, input.candidatePrice);
  const target_percent = inferTargetPercent(text, input.candidatePercent);
  if (target_price != null) {
    evidence.push("explicit_target_price");
  }
  if (target_percent != null) {
    evidence.push("explicit_target_percent");
  }
  return {
    is_call: true,
    direction,
    target_price,
    target_percent,
    horizon_code,
    horizon_custom_days: customDays(text, horizon_code),
    stated_confidence: inferStatedConfidence(text),
    extraction_confidence: 0.82,
    evidence,
  };
}

export type CreatorCallExtractor = {
  version: string;
  extract(input: CallExtractionInput): ExtractedCallCandidate | null | Promise<ExtractedCallCandidate | null>;
};

export class DeterministicCreatorCallExtractor implements CreatorCallExtractor {
  readonly version = CREATOR_EXTRACTOR_VERSION;
  extract(input: CallExtractionInput) {
    return extractCallDeterministic(input);
  }
}

export class FixtureLlmCreatorCallExtractor implements CreatorCallExtractor {
  readonly version = CREATOR_LLM_EXTRACTOR_VERSION;
  constructor(private readonly raw: unknown) {}
  extract(_input: CallExtractionInput) {
    return validateExtractedCall(this.raw);
  }
}
