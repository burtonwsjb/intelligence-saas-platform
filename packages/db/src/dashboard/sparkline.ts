export function sparklinePath(values: number[], width = 160, height = 36): string {
  const numeric = values.filter((value) => Number.isFinite(value));
  if (numeric.length === 0) {
    return "";
  }
  const min = Math.min(...numeric);
  const max = Math.max(...numeric);
  const span = max - min || 1;
  return numeric
    .map((value, index) => {
      const x = numeric.length === 1 ? 0 : (index / (numeric.length - 1)) * width;
      const y = height - ((value - min) / span) * height;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}
