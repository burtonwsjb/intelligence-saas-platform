import { meanAbsPercentError } from "./metrics.js";

export function assertPredictionsRemainShadow(rows: Array<{ visibility?: string | null }>): void {
  if (rows.some((row) => row.visibility && row.visibility !== "shadow")) {
    throw new Error("customer_prediction_publication_forbidden");
  }
}

export function comparePredictionModelRuns(input: {
  current: { modelVersion: string; mae: number | null; n: number };
  candidate: { modelVersion: string; mae: number | null; n: number };
}) {
  return {
    currentVersion: input.current.modelVersion,
    candidateVersion: input.candidate.modelVersion,
    maeDelta:
      input.current.mae != null && input.candidate.mae != null ? input.candidate.mae - input.current.mae : null,
    sampleCurrent: input.current.n,
    sampleCandidate: input.candidate.n,
    calibrated: false,
    customerVisible: false,
  };
}

export function mapeForPricePairs(pairs: { actual: number; predicted: number }[]) {
  return meanAbsPercentError(pairs);
}
