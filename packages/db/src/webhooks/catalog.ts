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

export const COMMERCIAL_CURSOR_VERSION = "cursor.v1" as const;
export const WEBHOOK_SIGNING_VERSION = "hmac-sha256.v1" as const;
export const WEBHOOK_RETRY_VERSION = "exp_backoff.v1" as const;
export const MAX_WEBHOOK_ATTEMPTS = 8;
export const WEBHOOK_DISABLE_AFTER_FAILURES = 8;
export const WEBHOOK_RESPONSE_EXCERPT_CHARS = 200;
