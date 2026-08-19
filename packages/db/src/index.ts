export {
  createDb,
  createDbConnection,
  createDbFromEnv,
  type Database,
} from "./client.js";
export {
  isMissingDatabaseAdminUrlError,
  isMissingDatabaseUrlError,
  MissingDatabaseAdminUrlError,
  MissingDatabaseUrlError,
  requireDatabaseAdminUrl,
  requireDatabaseUrl,
} from "./env.js";
export {
  InvalidTenantContextError,
  MissingTenantContextError,
} from "./errors.js";
export { applyMigrations } from "./migrate-lib.js";
export { bootstrapRoles, replaceConnectionRole } from "./bootstrap-roles.js";
export { listMigrationFiles, readMigrationSql } from "./migrations.js";
export { DB_ROLES } from "./roles.js";
export {
  assertContextId,
  assertTenantContext,
  parseOrganizationContext,
  withMachineContext,
  withOrganizationContext,
  withPlatformContext,
  withSystemContext,
  withTenantScope,
  type MachineContext,
  type OrganizationContext,
  type SystemContext,
} from "./rls.js";
export { insertAuditEvent, listAuditEvents } from "./repos/audit.js";
export { getTenant } from "./repos/tenant.js";
export {
  deleteTenantResource,
  insertTenantResource,
  listTenantResources,
  updateTenantResource,
} from "./repos/tenant-resource.js";
export {
  claimStripeEvent,
  ensureTenantBilling,
  findOrganizationIdByStripeCustomer,
  getTenantBilling,
  listPlanCatalog,
  listTenantEntitlementOverrides,
  upsertTenantBilling,
  upsertTenantEntitlementOverride,
} from "./repos/billing.js";
export {
  countActiveApiKeys,
  insertApiKey,
  listApiKeys,
  lookupApiKeyByPrefix,
  revokeApiKey,
  touchApiKeyLastUsed,
  type ApiKeyLookup,
} from "./repos/api-key.js";
export { getMonthUsage, monthStartUtc, recordUsage } from "./repos/usage.js";
export {
  IllegalSourceEventTransitionError,
  findSourceEventByIdempotency,
  getSourceEvent,
  insertSourceEvent,
  listSourceEvents,
  updateSourceEventStatus,
} from "./repos/source-event.js";
export {
  getOutboxJob,
  insertOutboxJob,
  listOutboxJobs,
  listPendingOutboxRefs,
  markOutboxPublishFailed,
  markOutboxPublished,
} from "./repos/outbox.js";
export {
  canTransitionSourceEvent,
  isSourceEventStatus,
} from "./ingest-status.js";
export {
  IdentifierCollisionError,
  IllegalDecisionTransitionError,
  ImmutableHistoryError,
  InvalidConfidenceError,
  InvalidMetricError,
  KernelValidationError,
  MissingSignalEvidenceError,
  UnknownEventTypeError,
} from "./kernel-errors.js";
export {
  ALGORITHM_KEY,
  ALGORITHM_VERSION,
  SOURCE_NAMESPACE,
  normalizeSourceEvent,
  requireSignalEvidence,
} from "./normalize.js";
export { parseConfidence } from "./kernel-registry.js";
export {
  findEntityByCanonical,
  findEntityIdentifier,
  getEntity,
  insertEntity,
  insertEntityIdentifier,
  listEntities,
  listEntityIdentifiers,
} from "./repos/entity.js";
export {
  getObservation,
  getObservationBySourceEvent,
  insertObservation,
  insertObservationMetric,
  listObservationMetrics,
  listObservationMetricsInRange,
  listObservationsInRange,
} from "./repos/observation.js";
export {
  getEvidenceReference,
  insertEvidenceReference,
  listEvidenceReferences,
} from "./repos/evidence.js";
export {
  getFeatureSnapshot,
  getSignal,
  insertFeatureSnapshot,
  insertSignal,
  insertSignalEvidence,
  listFeatureSnapshotsInRange,
  listSignalEvidence,
  listSignalsInRange,
} from "./repos/signal.js";
export {
  finalizeDecisionRecord,
  getDecisionRecord,
  insertDecisionEvidence,
  insertDecisionRecord,
  listDecisionEvidence,
  listDecisionRecords,
} from "./repos/decision.js";
export { getSourceDefinition, listSourceDefinitions } from "./repos/source-definition.js";
export {
  TCG_ENTITY_TYPE,
  TCG_GAME_KEYS,
  TCG_LANGUAGE_CODES,
  TCG_PRINTING_IDENTIFIER_TYPE,
  TCG_SOURCE_NAMESPACE,
  TCG_VARIANT_KEYS,
  TcgIdentifierConflictError,
  TcgValidationError,
  canonicalPrintingKey,
  kernelCanonicalKeyForPrinting,
  normalizeCollectorNumber,
  normalizeTcgName,
  parseTcgLanguage,
  parseTcgVariant,
} from "./tcg/identity.js";
export {
  findTcgPrintingIdentifier,
  getTcgGame,
  getTcgPrintingByKey,
  getTcgSet,
  insertTcgCardConcept,
  insertTcgCardNameAlias,
  insertTcgPrinting,
  insertTcgPrintingIdentifier,
  insertTcgSet,
  listTcgGames,
  listTcgIdentifierConflicts,
  listTcgLanguages,
} from "./tcg/catalog.js";
export {
  resolveTcgPrinting,
  type TcgResolveQuery,
  type TcgResolveResult,
} from "./tcg/resolve.js";
export { TCC_ID_TYPE, TCC_NAMESPACE, seedTcgIdentityFixtures } from "./tcg/fixtures.js";
export {
  SandboxTcgCardCentralProvider,
  sandboxProviderFromFixtures,
  type TcgIdentityProvider,
} from "./tcg/provider.js";
export { ensureTcgPrintingEntity } from "./tcg/kernel-link.js";
export {
  TcgMarketRevisionError,
  TcgMarketValidationError,
  computeTcgAskSoldSpread,
  parseTcgCondition,
  parseTcgCurrency,
  parseTcgMarketRecord,
  resolveWindow,
  rollingMedian,
  type TcgMarketRecordInput,
} from "./tcg/market-identity.js";
export {
  getTcgMarketSnapshot,
  ingestTcgMarketRecord,
  listTcgMarketQuarantine,
  listTcgMarketRevisions,
  markTcgMarketIngestFailed,
  normalizeTcgMarketIngest,
  receiveTcgMarketRecord,
} from "./tcg/market-ingest.js";
export {
  computeDailyReturns,
  getLatestTcgMarketSnapshot,
  getTcgAskSoldSpread,
  listTcgListingHistory,
  listTcgMarketSnapshots,
  listTcgSoldHistory,
  listWindow,
  summarizeTcgLiquidityInputs,
} from "./tcg/market-query.js";
export {
  FixtureTcgMarketProvider,
  fixtureEbayMarketProvider,
  fixtureTcgCardCentralMarketProvider,
  fixtureTcgplayerMarketProvider,
  type TcgMarketProvider,
} from "./tcg/market-provider.js";
export { tcgMarketFixtureRecords } from "./tcg/market-fixtures.js";
export { projectTcgMarketSnapshotToTenant } from "./tcg/market-project.js";
export {
  MAX_SOURCE_EXCERPT_CHARS,
  SOURCE_EXTRACTOR_VERSION,
  SourceValidationError,
  boundSourceExcerpt,
  deriveSentimentFoundation,
  normalizeMentionText,
  summarizeMentionVelocity,
  type SourceContentRecordInput,
} from "./source/identity.js";
export {
  getSourceContentByExternal,
  ingestSourceContentRecord,
  listSourceAccounts,
  listSourceContent,
  listSourceEngagement,
  listSourceMentions,
  listSourceSegments,
  markSourceIngestFailed,
  normalizeSourceIntelligenceIngest,
  receiveSourceContentRecord,
} from "./source/ingest.js";
export { sourceIntelligenceFixtures } from "./source/fixtures.js";
export {
  FixtureRedditSourceProvider,
  FixtureYoutubeSourceProvider,
  type RedditSourceProvider,
  type YoutubeSourceProvider,
} from "./source/provider.js";
export {
  RESOLVER_VERSION,
  EntityResolutionError,
  nameSimilarity,
} from "./resolution/identity.js";
export {
  applyResolutionReview,
  getLatestResolution,
  getResolutionAttempt,
  listResolutionCorrections,
  listResolutionHistory,
} from "./resolution/persist.js";
export { resolveEntity, resolveSourceMention } from "./resolution/resolve.js";
export {
  CREATOR_EXTRACTOR_VERSION,
  CREATOR_PRICE_AT_CALL_VERSION,
  CreatorValidationError,
} from "./creator/identity.js";
export {
  DeterministicCreatorCallExtractor,
  FixtureLlmCreatorCallExtractor,
  extractCallDeterministic,
} from "./creator/extract.js";
export { priceAtCall } from "./creator/price-at-call.js";
export {
  ensureCreatorForSourceAccount,
  extractCreatorCallsFromContent,
  linkCreatorAccount,
  reviseCreatorCall,
} from "./creator/ingest.js";
export {
  getCreatorCall,
  listCallsAwaitingOutcome,
  listCallsByCreator,
  listCallsByDate,
  listCallsByDirection,
  listCallsByPrinting,
  listCreatorAccounts,
  listCreators,
  listUnresolvedCalls,
} from "./creator/query.js";
export { creatorCallSourceFixtures } from "./creator/fixtures.js";
export { evaluateCreatorCallOutcome, earlyCallScore } from "./creator/outcomes.js";
export {
  getCreatorAuthorityProfile,
  latestTrustState,
  recomputeCreatorAuthority,
  recordCreatorTrust,
  AUTHORITY_VERSION,
} from "./creator/authority.js";
export { authorityScore, bayesMean, wilsonInterval } from "./creator/stats.js";
export {
  ALPHA_METHOD_VERSION,
  BENCHMARK_RESOLVER_VERSION,
  DEFAULT_INDEX_WEIGHTING,
  DEFAULT_OUTLIER_POLICY,
  INDEX_BASE_VALUE,
  INDEX_METHOD_VERSION,
  MARKET_FEATURE_SET_KEY,
  MARKET_FEATURE_SET_VERSION,
  MARKET_RETURN_PERIODS,
} from "./analytics/catalog.js";
export {
  computeMarketFeatures,
  computeMarketFeaturesWithBenchmark,
  computeFeaturesFromSeries,
  getMarketFeatureSnapshot,
  persistMarketFeatureSnapshot,
} from "./analytics/features.js";
export {
  computeIndexLevel,
  getIndexDefinition,
  getIndexLevelAsOf,
  indexReturn,
  listIndexDefinitions,
  listIndexLevels,
  listMembershipAsOf,
  persistIndexLevel,
  qualifyIndexMembers,
  rebalanceIndex,
  upsertIndexDefinition,
} from "./analytics/index-engine.js";
export { printingBenchmarkContext, resolveBenchmark } from "./analytics/benchmark.js";
export { computeCreatorAlpha, getCreatorCallAlpha } from "./analytics/alpha.js";
export * from "./schema/index.js";
