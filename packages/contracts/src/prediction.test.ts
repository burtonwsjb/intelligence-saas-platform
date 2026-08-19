import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREDICTION_VISIBILITY,
  PREDICTION_HORIZONS,
  PREDICTION_MODEL_KEY,
  PREDICTION_MODEL_VERSION,
  PREDICTION_VISIBILITY,
} from "./prediction.js";

describe("prediction contracts", () => {
  it("versions the statistical baseline and defaults to shadow visibility", () => {
    expect(PREDICTION_HORIZONS).toEqual(["7d", "30d", "90d", "180d", "365d"]);
    expect(PREDICTION_MODEL_KEY).toBe("stats.baseline");
    expect(PREDICTION_MODEL_VERSION).toBe("stats.baseline.v1");
    expect(DEFAULT_PREDICTION_VISIBILITY).toBe("shadow");
    expect(PREDICTION_VISIBILITY).toContain("shadow");
    expect(PREDICTION_VISIBILITY).not.toContain("public");
  });
});
