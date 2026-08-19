export function brierScore(probability: number, realized: 0 | 1) {
  return (probability - realized) ** 2;
}

export function meanAbsError(errors: number[]) {
  if (errors.length === 0) {
    return null;
  }
  return errors.reduce((sum, value) => sum + Math.abs(value), 0) / errors.length;
}

export function rootMeanSquare(errors: number[]) {
  if (errors.length === 0) {
    return null;
  }
  return Math.sqrt(errors.reduce((sum, value) => sum + value * value, 0) / errors.length);
}

export function meanAbsPercentError(pairs: { actual: number; predicted: number }[]) {
  const usable = pairs.filter((row) => Math.abs(row.actual) >= 1);
  if (usable.length === 0) {
    return null;
  }
  return usable.reduce((sum, row) => sum + Math.abs((row.predicted - row.actual) / row.actual), 0) / usable.length;
}

export function rangeCoverage(hits: boolean[]) {
  if (hits.length === 0) {
    return null;
  }
  return hits.filter(Boolean).length / hits.length;
}

export function directionAccuracy(rows: { predictedUp: boolean; actualUp: boolean }[]) {
  if (rows.length === 0) {
    return null;
  }
  return rows.filter((row) => row.predictedUp === row.actualUp).length / rows.length;
}

export function calibrationBuckets(rows: { p: number; y: 0 | 1 }[], size = 5) {
  const buckets = Array.from({ length: size }, (_, i) => ({
    from: i / size,
    to: (i + 1) / size,
    n: 0,
    mean_p: 0,
    mean_y: 0,
  }));
  for (const row of rows) {
    const idx = Math.min(size - 1, Math.floor(row.p * size));
    const bucket = buckets[idx]!;
    bucket.n += 1;
    bucket.mean_p += row.p;
    bucket.mean_y += row.y;
  }
  return buckets.map((bucket) => ({
    ...bucket,
    mean_p: bucket.n ? bucket.mean_p / bucket.n : null,
    mean_y: bucket.n ? bucket.mean_y / bucket.n : null,
  }));
}
