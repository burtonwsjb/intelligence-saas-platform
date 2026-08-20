export const CONTENT_OUTPUT_TYPES = [
  "seo_article",
  "market_report",
  "card_analysis",
  "newsletter",
  "email",
  "social_post",
  "youtube_outline",
  "push_notification",
  "tenant_report",
] as const;
export type ContentOutputType = (typeof CONTENT_OUTPUT_TYPES)[number];

export const CONTENT_EVIDENCE_VERSION = "evidence.v1";
export const CONTENT_VALIDATOR_VERSION = "validate.v1";
export const LOCAL_GENERATOR_KEY = "local.template";
export const LOCAL_GENERATOR_VERSION = "content.local.v1";
export const FIXTURE_GENERATOR_KEY = "fixture";
export const MIN_INDEXABLE_CHARS = 400;

export const CONTENT_TEMPLATES: Record<
  ContentOutputType,
  { minSources: number; minSignals: number; minChars: number; allowThinStub: boolean }
> = {
  seo_article: { minSources: 2, minSignals: 1, minChars: MIN_INDEXABLE_CHARS, allowThinStub: true },
  market_report: { minSources: 2, minSignals: 1, minChars: MIN_INDEXABLE_CHARS, allowThinStub: true },
  card_analysis: { minSources: 2, minSignals: 1, minChars: MIN_INDEXABLE_CHARS, allowThinStub: true },
  newsletter: { minSources: 1, minSignals: 1, minChars: 200, allowThinStub: true },
  email: { minSources: 1, minSignals: 0, minChars: 120, allowThinStub: true },
  social_post: { minSources: 1, minSignals: 1, minChars: 80, allowThinStub: true },
  youtube_outline: { minSources: 1, minSignals: 1, minChars: 160, allowThinStub: true },
  push_notification: { minSources: 1, minSignals: 0, minChars: 40, allowThinStub: true },
  tenant_report: { minSources: 0, minSignals: 0, minChars: 40, allowThinStub: false },
};

export function isContentOutputType(value: string): value is ContentOutputType {
  return (CONTENT_OUTPUT_TYPES as readonly string[]).includes(value);
}

export function canonicalPrintingUrl(input: {
  gameKey: string;
  languageCode: string;
  canonicalPrintingKey: string;
}): string {
  return `/intelligence/${encodeURIComponent(input.gameKey)}/${encodeURIComponent(input.languageCode)}/${encodeURIComponent(input.canonicalPrintingKey)}`;
}

export function escapeContentHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
