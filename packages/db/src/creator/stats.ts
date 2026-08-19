export function wilsonInterval(successes: number, n: number, z = 1.96) {
  if (n <= 0) {
    return { low: 0, center: 0, high: 1, raw: 0 };
  }
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return {
    low: Math.max(0, center - margin),
    center,
    high: Math.min(1, center + margin),
    raw: p,
  };
}

export function bayesMean(successes: number, n: number, alpha = 8, beta = 8) {
  return (successes + alpha) / (n + alpha + beta);
}

export function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

export function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function recencyWeight(ageDays: number, halfLifeDays = 180) {
  return Math.pow(0.5, ageDays / halfLifeDays);
}

export function priceTier(price: number | null): string {
  if (price == null) {
    return "unknown";
  }
  if (price < 25) {
    return "lt_25";
  }
  if (price < 100) {
    return "25_100";
  }
  if (price < 500) {
    return "100_500";
  }
  return "gte_500";
}

export function assignTrustState(input: {
  n: number;
  wilsonLow: number;
  excluded?: boolean;
}): "trusted" | "reliable" | "developing" | "low_confidence" | "unreliable" | "excluded" {
  if (input.excluded) {
    return "excluded";
  }
  if (input.n < 5) {
    return "low_confidence";
  }
  if (input.wilsonLow < 0.35 && input.n >= 8) {
    return "unreliable";
  }
  if (input.n < 20) {
    return "developing";
  }
  if (input.n >= 50 && input.wilsonLow >= 0.62) {
    return "trusted";
  }
  if (input.wilsonLow >= 0.5) {
    return "reliable";
  }
  return "developing";
}

export function authorityScore(input: { wilsonLow: number; n: number; avgReturn: number | null }) {
  const sample = input.n / (input.n + 20);
  const ret = input.avgReturn == null ? 0 : Math.max(-0.5, Math.min(0.5, input.avgReturn));
  const value = 100 * (0.85 * input.wilsonLow + 0.15 * (0.5 + ret)) * sample;
  return Math.max(0, Math.min(100, value));
}

export function authorityWeight(input: { n: number; trustState: string; wilsonLow: number }) {
  if (input.trustState === "excluded") {
    return 0;
  }
  if (input.trustState === "unreliable") {
    return 0.05 * (input.n / (input.n + 20));
  }
  const shrink = input.n / (input.n + 20);
  const trust =
    input.trustState === "trusted" ? 1 : input.trustState === "reliable" ? 0.8 : input.trustState === "developing" ? 0.45 : 0.2;
  return Number((shrink * trust * Math.max(input.wilsonLow, 0)).toFixed(6));
}
