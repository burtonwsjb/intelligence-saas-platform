import { and, desc, eq, lte } from "drizzle-orm";
import type { Database } from "../client.js";
import { creatorAuthoritySlice, creatorCall } from "../schema/creator.js";
import { entityResolutionAttempt } from "../schema/resolution.js";
import { sourceContent, sourceEngagementSnapshot, sourceMention } from "../schema/source.js";
import { tcgPrinting } from "../schema/tcg.js";
import { computeMarketFeatures, persistMarketFeatureSnapshot } from "../analytics/features.js";
import { getTcgAskSoldSpread } from "../tcg/market-query.js";
import { MS_DAY } from "../analytics/catalog.js";
import type { CreatorVote, ScoreInputs, SocialStats } from "./model.js";

async function printingLanguage(db: Database, printingId: string) {
  const [row] = await db
    .select({ languageCode: tcgPrinting.languageCode, gameKey: tcgPrinting.gameKey })
    .from(tcgPrinting)
    .where(eq(tcgPrinting.id, printingId))
    .limit(1);
  return row;
}

async function creatorVotes(db: Database, printingId: string, languageCode: string, asOf: Date): Promise<CreatorVote[]> {
  const calls = await db
    .select()
    .from(creatorCall)
    .where(and(eq(creatorCall.printingId, printingId), lte(creatorCall.publishedAt, asOf)));
  const votes: CreatorVote[] = [];
  for (const call of calls) {
    const slices = await db
      .select()
      .from(creatorAuthoritySlice)
      .where(eq(creatorAuthoritySlice.creatorId, call.creatorId))
      .orderBy(desc(creatorAuthoritySlice.createdAt));
    const slice =
      slices.find((row) => row.languageCode === languageCode) ??
      slices.find((row) => row.languageCode == null && row.priceTier === "all") ??
      slices[0];
    votes.push({
      creatorId: call.creatorId,
      direction: call.direction,
      languageCode,
      authorityWeight: slice?.authorityWeight == null ? 0.05 : Number(slice.authorityWeight),
      sampleSize: slice?.sampleSize == null ? 0 : Number(slice.sampleSize),
      publishedAt: call.publishedAt.toISOString(),
    });
  }
  return votes;
}

async function socialStats(db: Database, printingId: string, languageCode: string, asOf: Date): Promise<SocialStats> {
  const from7 = new Date(asOf.getTime() - 7 * MS_DAY);
  const from14 = new Date(asOf.getTime() - 14 * MS_DAY);
  const attempts = await db
    .select()
    .from(entityResolutionAttempt)
    .where(eq(entityResolutionAttempt.chosenPrintingId, printingId));
  const mentionIds = [...new Set(attempts.map((row) => row.mentionId).filter((id): id is string => Boolean(id)))];
  if (mentionIds.length === 0) {
    return {
      mentions_7d: 0,
      mentions_prior_7d: 0,
      unique_accounts: 0,
      unique_content: 0,
      engagement_sum: 0,
      language_code: languageCode,
    };
  }
  const mentions = await db.select().from(sourceMention);
  const relevant = mentions.filter((row) => mentionIds.includes(row.id));
  const contents = await db.select().from(sourceContent);
  const contentById = new Map(contents.map((row) => [row.id, row]));
  const recent = relevant.filter((row) => {
    const published = contentById.get(row.contentId)?.publishedAt;
    return published != null && published.getTime() > from7.getTime() && published.getTime() <= asOf.getTime();
  });
  const prior = relevant.filter((row) => {
    const published = contentById.get(row.contentId)?.publishedAt;
    return published != null && published.getTime() > from14.getTime() && published.getTime() <= from7.getTime();
  });
  const contentIds = [...new Set(recent.map((row) => row.contentId))];
  const accounts = [...new Set(contentIds.map((id) => contentById.get(id)?.accountId).filter(Boolean))];
  const engagementRows = await db.select().from(sourceEngagementSnapshot);
  const engagement = engagementRows
    .filter((row) => contentIds.includes(row.contentId) && row.observedAt.getTime() <= asOf.getTime())
    .reduce((sum, row) => sum + Number(row.views ?? 0) + Number(row.likes ?? 0) + Number(row.upvotes ?? 0), 0);
  return {
    mentions_7d: recent.length,
    mentions_prior_7d: prior.length,
    unique_accounts: accounts.length,
    unique_content: contentIds.length,
    engagement_sum: engagement,
    language_code: languageCode,
  };
}

export async function gatherScoreInputs(
  db: Database,
  input: { printingId: string; asOf: Date; scoreVersion?: string },
): Promise<ScoreInputs> {
  const identity = await printingLanguage(db, input.printingId);
  if (!identity) {
    throw new Error("printing not found.");
  }
  const computed = await computeMarketFeatures(db, { printingId: input.printingId, asOf: input.asOf });
  const snapshot = await persistMarketFeatureSnapshot(db, computed);
  const spread = await getTcgAskSoldSpread(db, { printingId: input.printingId, to: input.asOf, condition: "nm" });
  const quality = computed.features.data_quality as {
    sample_size: number;
    staleness_hours: number | null;
    source_composition: Record<string, number>;
    state: string;
  };
  const votes = await creatorVotes(db, input.printingId, identity.languageCode, input.asOf);
  const social = await socialStats(db, input.printingId, identity.languageCode, input.asOf);
  return {
    printingId: input.printingId,
    languageCode: identity.languageCode,
    asOf: input.asOf.toISOString(),
    featureSnapshotId: snapshot.id,
    featureSetVersion: computed.features.feature_set_version as string,
    sampleSize: computed.sampleSize,
    dataQuality: computed.dataQuality,
    stalenessHours: quality.staleness_hours,
    sourceCount: Object.keys(quality.source_composition ?? {}).length,
    resolutionCertainty: 1,
    returns: computed.features.returns as ScoreInputs["returns"],
    volumeMomentum: computed.features.volume_momentum as ScoreInputs["volumeMomentum"],
    salesVelocity: computed.features.sales_velocity as ScoreInputs["salesVelocity"],
    supply: computed.features.supply as ScoreInputs["supply"],
    relativeStrength: computed.features.relative_strength as ScoreInputs["relativeStrength"],
    volatility: computed.features.volatility as ScoreInputs["volatility"],
    spreadChange: computed.features.spread_change as ScoreInputs["spreadChange"],
    latestSpreadRatio: spread.spread_ratio,
    manipulation: computed.features.manipulation_foundation as ScoreInputs["manipulation"],
    social,
    creatorVotes: votes,
    scoreVersion: input.scoreVersion,
  };
}
