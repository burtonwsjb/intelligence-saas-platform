/**
 * Causal technical indicators over a daily close series, oldest first. The
 * value at index i reads only closes at indices <= i, so the same arrays serve
 * the latest reading and the look-ahead-free backtest. Warm-up indices are null.
 */

export type Series = readonly number[];
export type Line = (number | null)[];

/** Simple moving average over `period` closes. */
export function sma(values: Series, period: number): Line {
  const out: Line = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** Exponential moving average seeded with the SMA of the first `period` values. */
export function ema(values: Line | Series, period: number): Line {
  const out: Line = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev: number | null = null;
  let seedSum = 0;
  let seedCount = 0;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value == null) continue;
    if (prev == null) {
      seedSum += value;
      seedCount += 1;
      if (seedCount === period) {
        prev = seedSum / period;
        out[i] = prev;
      }
      continue;
    }
    prev = value * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's RSI. Flat series (no gains or losses) read 50. */
export function rsi(values: Series, period = 14): Line {
  const out: Line = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = values[i]! - values[i - 1]!;
    if (change > 0) gain += change;
    else loss -= change;
  }
  gain /= period;
  loss /= period;
  const value = () => (gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  out[period] = value();
  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i]! - values[i - 1]!;
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = value();
  }
  return out;
}

/** MACD line (EMA fast - EMA slow) and its signal EMA. */
export function macd(values: Series, fast = 12, slow = 26, signal = 9): { line: Line; signal: Line } {
  const fastLine = ema(values, fast);
  const slowLine = ema(values, slow);
  const line: Line = values.map((_, i) => (fastLine[i] != null && slowLine[i] != null ? fastLine[i]! - slowLine[i]! : null));
  return { line, signal: ema(line, signal) };
}

/** Bollinger bands: SMA(period) +/- width standard deviations (population). */
export function bollinger(values: Series, period = 20, width = 2): { middle: Line; upper: Line; lower: Line } {
  const middle = sma(values, period);
  const upper: Line = new Array(values.length).fill(null);
  const lower: Line = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i += 1) {
    const mean = middle[i]!;
    let squares = 0;
    for (let j = i - period + 1; j <= i; j += 1) squares += (values[j]! - mean) ** 2;
    const sd = Math.sqrt(squares / period);
    upper[i] = mean + width * sd;
    lower[i] = mean - width * sd;
  }
  return { middle, upper, lower };
}

/**
 * Pivot highs and lows: index i is a pivot high when its close is above every
 * close of the `span` days before it and at least every close of the `span`
 * days after it (so the first day of a flat top counts once). A pivot is only
 * known `span` days after it happens, so a reading at day t may use pivots at
 * i <= t - span.
 */
export function pivots(values: Series, span: number): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = span; i < values.length - span; i += 1) {
    const v = values[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = i - span; j < i; j += 1) {
      if (values[j]! >= v) isHigh = false;
      if (values[j]! <= v) isLow = false;
    }
    for (let j = i + 1; j <= i + span; j += 1) {
      if (values[j]! > v) isHigh = false;
      if (values[j]! < v) isLow = false;
    }
    if (isHigh) highs.push(i);
    if (isLow) lows.push(i);
  }
  return { highs, lows };
}
