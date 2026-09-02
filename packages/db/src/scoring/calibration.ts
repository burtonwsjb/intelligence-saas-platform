export type ScoreCalibrationExample = {
  printingId: string;
  asOf: string;
  languageCode: string;
  opportunity: number;
  risk: number;
  confidence: number;
  liquidity: number;
  recommendation: string;
  actualReturn?: number | null;
  realizedAt?: string | null;
};

export type ScoreCalibrationReport = {
  n: number;
  usableOutcomes: number;
  mae: number | null;
  directionalAccuracy: number | null;
  calibrated: false;
  reason: "insufficient_real_outcomes";
};

export function emptyScoreCalibrationReport(examples: ScoreCalibrationExample[]): ScoreCalibrationReport {
  const usable = examples.filter((row) => row.actualReturn != null && Number.isFinite(row.actualReturn));
  return {
    n: examples.length,
    usableOutcomes: usable.length,
    mae: null,
    directionalAccuracy: null,
    calibrated: false,
    reason: "insufficient_real_outcomes",
  };
}

export function historicalOutcomeInterface(input: {
  scoreId: string;
  asOf: Date;
  horizonDays: number;
}): { scoreId: string; outcomeWindowStart: Date; outcomeWindowEnd: Date; lookAhead: false } {
  return {
    scoreId: input.scoreId,
    outcomeWindowStart: input.asOf,
    outcomeWindowEnd: new Date(input.asOf.getTime() + input.horizonDays * 86_400_000),
    lookAhead: false,
  };
}
