export const NOTIFICATION_CHANNELS = ["in_app", "email", "webhook"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_CATEGORIES = [
  "account",
  "billing",
  "security",
  "product",
  "market_alert",
  "creator_alert",
  "prediction",
  "opportunity",
  "usage",
  "marketing",
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const REQUIRED_NOTIFICATION_CATEGORIES = ["account", "security"] as const;

export const ALERT_RULE_TYPES = [
  "opportunity_score_threshold",
  "recommendation_change",
  "price_move",
  "creator_call",
  "creator_consensus",
  "prediction_created",
  "usage_threshold",
  "webhook_failure",
] as const;
export type AlertRuleType = (typeof ALERT_RULE_TYPES)[number];

export const NOTIFICATION_SEVERITIES = ["info", "warning", "critical"] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export const EMAIL_DELIVERY_STATUSES = ["queued", "sent", "failed", "suppressed"] as const;
export type EmailDeliveryStatus = (typeof EMAIL_DELIVERY_STATUSES)[number];

export const USAGE_WARNING_THRESHOLDS = [50, 80, 90, 100] as const;

export const IN_APP_BODY_MAX_CHARS = 500;

export function isNotificationChannel(value: string): value is NotificationChannel {
  return (NOTIFICATION_CHANNELS as readonly string[]).includes(value);
}

export function isNotificationCategory(value: string): value is NotificationCategory {
  return (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
}

export function isAlertRuleType(value: string): value is AlertRuleType {
  return (ALERT_RULE_TYPES as readonly string[]).includes(value);
}

export function isRequiredNotificationCategory(category: string): boolean {
  return (REQUIRED_NOTIFICATION_CATEGORIES as readonly string[]).includes(category);
}

export function defaultOptedIn(category: NotificationCategory, channel: NotificationChannel): boolean {
  if (category === "marketing") {
    return false;
  }
  if (category === "security" || category === "account") {
    return channel === "email" || channel === "in_app";
  }
  if (category === "billing" || category === "usage") {
    return channel === "email" || channel === "in_app";
  }
  return channel === "in_app";
}
