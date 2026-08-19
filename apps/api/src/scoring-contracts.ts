import { z } from "zod";
import { RECOMMENDATION_LABELS, SCORE_POLICY_KEY, SCORE_POLICY_VERSION } from "@isp/contracts";

export const RecommendationLabel = z.enum(RECOMMENDATION_LABELS);

export const OpportunityScoreContract = z.object({
  printing_id: z.string().min(1),
  as_of: z.string().datetime(),
  opportunity: z.number().min(0).max(100),
  risk: z.number().min(0).max(100),
  confidence: z.number().min(0).max(100),
  liquidity: z.number().min(0).max(100),
  recommendation: RecommendationLabel,
  policy_key: z.literal(SCORE_POLICY_KEY),
  policy_version: z.string().min(1),
  explanations: z.array(
    z.object({
      code: z.string(),
      text: z.string(),
      refs: z.array(z.string()),
    }),
  ),
});

export const DefaultScorePolicyVersion = SCORE_POLICY_VERSION;
