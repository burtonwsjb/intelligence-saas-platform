import { SENTIMENT_ANALYZER_VERSION } from "./catalog.js";

export type SourceSentimentAnalysis = {
  analyzer_version: string;
  direction: "bullish" | "bearish" | "neutral" | "unknown";
  strength: "none" | "weak" | "moderate" | "strong";
  confidence: number | null;
  subject: "card" | "set" | "market" | "creator" | "unknown";
  entity_kind: "concept" | "printing" | "set" | "game" | "creator" | "unknown";
  time_horizon: "unspecified" | "near" | "medium" | "long";
  market_relevance: "none" | "low" | "medium" | "high";
  excitement: "none" | "present";
  purchase_intent: "none" | "present";
  price_expectation: "none" | "up" | "down" | "unclear";
  creator_recommendation: "none" | "buy" | "sell" | "hold" | "watch" | "avoid";
  market_concern: "none" | "present";
  evidence: string[];
  coarse_sentiment: "positive" | "negative" | "neutral" | "mixed" | "unknown";
};

const BUY = /\b(buy|pick up|undervalued|load|scoop)\b|買う/;
const SELL = /\b(sell|dump|overpriced|exit)\b|売る/;
const HOLD = /\b(hold|holding)\b/;
const WATCH = /\b(watch|keep an eye)\b/;
const AVOID = /\b(avoid|stay away)\b/;
const UP = /\b(going up|will rise|moon|pump)\b|上がる/;
const DOWN = /\b(going down|will drop|crash|dump)\b|下がる/;
const EXCITE = /\b(hype|insane|crazy|fire|goat)\b|神/;
const CONCERN = /\b(fake|scam|manipulation|thin|illiquid)\b/;
const PRICE = /\$\s*\d|\bprice\b|円/;

export function analyzeSourceSentiment(input: {
  text?: string | null;
  mention_context?: string | null;
  candidate_direction?: string | null;
  has_printing_evidence?: boolean;
}): SourceSentimentAnalysis {
  const text = `${input.text ?? ""}`.trim();
  const evidence: string[] = [`analyzer:${SENTIMENT_ANALYZER_VERSION}`];
  let direction: SourceSentimentAnalysis["direction"] = "unknown";
  let recommendation: SourceSentimentAnalysis["creator_recommendation"] = "none";
  let priceExpectation: SourceSentimentAnalysis["price_expectation"] = "none";
  if (BUY.test(text) || input.candidate_direction === "bullish") {
    direction = "bullish";
    recommendation = "buy";
    evidence.push("buy_language");
  } else if (SELL.test(text) || input.candidate_direction === "bearish") {
    direction = "bearish";
    recommendation = "sell";
    evidence.push("sell_language");
  } else if (HOLD.test(text)) {
    direction = "neutral";
    recommendation = "hold";
    evidence.push("hold_language");
  } else if (WATCH.test(text)) {
    direction = "neutral";
    recommendation = "watch";
    evidence.push("watch_language");
  } else if (AVOID.test(text)) {
    direction = "bearish";
    recommendation = "avoid";
    evidence.push("avoid_language");
  }
  if (UP.test(text)) {
    priceExpectation = "up";
    if (direction === "unknown") {
      direction = "bullish";
    }
    evidence.push("price_up_language");
  } else if (DOWN.test(text)) {
    priceExpectation = "down";
    if (direction === "unknown") {
      direction = "bearish";
    }
    evidence.push("price_down_language");
  }
  const excitement = EXCITE.test(text) ? "present" : "none";
  if (excitement === "present") {
    evidence.push("excitement_language");
  }
  const marketConcern = CONCERN.test(text) ? "present" : "none";
  if (marketConcern === "present") {
    evidence.push("market_concern_language");
  }
  const purchaseIntent = recommendation === "buy" ? "present" : "none";
  const marketRelevance =
    recommendation !== "none" || priceExpectation !== "none" || PRICE.test(text)
      ? excitement === "present" && recommendation === "none"
        ? "low"
        : "high"
      : excitement === "present"
        ? "low"
        : "none";
  if (excitement === "present" && recommendation === "none") {
    evidence.push("excitement_is_not_a_buy_signal");
  }
  const strength =
    recommendation !== "none" && priceExpectation !== "none"
      ? "strong"
      : recommendation !== "none" || priceExpectation !== "none"
        ? "moderate"
        : excitement === "present"
          ? "weak"
          : "none";
  const coarse =
    direction === "bullish" ? "positive" : direction === "bearish" ? "negative" : direction === "neutral" ? "neutral" : "unknown";
  return {
    analyzer_version: SENTIMENT_ANALYZER_VERSION,
    direction,
    strength,
    confidence: strength === "none" ? null : strength === "strong" ? 0.72 : strength === "moderate" ? 0.55 : 0.35,
    subject: input.mention_context === "recommendation" ? "card" : "unknown",
    entity_kind: input.has_printing_evidence ? "printing" : "concept",
    time_horizon: /\b(week|7d)\b/i.test(text) ? "near" : /\b(month|90d|30d)\b/i.test(text) ? "medium" : /\b(year|365d)\b/i.test(text) ? "long" : "unspecified",
    market_relevance: marketRelevance,
    excitement,
    purchase_intent: purchaseIntent,
    price_expectation: priceExpectation,
    creator_recommendation: recommendation,
    market_concern: marketConcern,
    evidence,
    coarse_sentiment: coarse,
  };
}
