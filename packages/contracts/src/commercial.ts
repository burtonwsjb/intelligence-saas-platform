export const WEBHOOK_EVENT_TYPES = [
  "card.trending",
  "card.buy_signal",
  "card.sell_signal",
  "creator.call_detected",
  "creator.consensus_changed",
  "market.breakout",
  "opportunity.changed",
  "index.moved",
  "usage.warning",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export const COMMERCIAL_METER_KEYS = [
  "api.reads",
  "prices.read",
  "market_history.read",
  "prediction.read",
  "opportunity.read",
  "creator.read",
] as const;
