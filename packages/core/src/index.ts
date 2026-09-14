// packages/core/src/index.ts — the public surface.
export * from "./types.ts";
export { detectBot, BOT_RULES, BOT_TABLE_VERSION, type BotVerdict } from "./bots.ts";
export {
  classifyReferrer,
  parseUtm,
  hostOf,
  aiSourceOf,
  AI_HOSTS,
  SEARCH_HOSTS,
  SOCIAL_HOSTS,
  EMAIL_HOSTS,
  REFERRER_TABLE_VERSION,
  type ReferrerVerdict,
} from "./referrers.ts";
export { parseUa, type UaVerdict } from "./ua.ts";
export { countryFromHeaders, COUNTRY_HEADERS } from "./geo.ts";
export { normalizeIp, ipv6Prefix64 } from "./ip.ts";
export {
  policyFor,
  POLICIES,
  STRICT_TRADEOFFS,
  stripReferrer,
  blockedByDoNotTrack,
  type PrivacyMode,
  type PrivacyPolicy,
} from "./privacy.ts";
export { visitorId, identityId, dayKey, SESSION_WINDOW_MS } from "./visitor.ts";
export { validateEvent, LIMITS, type ValidationResult } from "./validate.ts";
export { Ingestor, splitUrl, type IngestOptions, type IngestResult } from "./ingest.ts";
export { type Store, SCHEMA_VERSION } from "./store/store.ts";
export { SqliteStore } from "./store/sqlite.ts";
export {
  buildBundle,
  windowOf,
  previousWindow,
  evidenceOf,
  bucketFor,
  LIVE_WINDOW_MS,
  MAX_SERIES_POINTS,
  type MetricBundle,
  type Evidence,
  type TimeWindow,
  type SeriesPoint,
} from "./metrics/bundle.ts";
export { METRICS, metricsFor, metricById, type MetricDef } from "./metrics/queries.ts";
export {
  computeFunnel,
  buildFunnelSql,
  validateSteps,
  defaultFunnel,
  FunnelError,
  MAX_FUNNEL_STEPS,
  type FunnelStep,
  type FunnelResult,
  type FunnelStepResult,
} from "./metrics/funnel.ts";
export {
  computeRetention,
  MAX_COHORTS,
  MAX_OFFSET,
  type RetentionResult,
  type RetentionUnavailable,
  type RetentionCohort,
} from "./metrics/retention.ts";
export { guardProse, extractNumbers, checkCausality, type GuardResult } from "./insight/guard.ts";
export { composeDigest, renderText, fmt, type Digest, type DigestLine } from "./insight/compose.ts";
export {
  slackBlocks,
  sendSlack,
  emailSubject,
  emailHtml,
  HttpEmailSender,
  NullEmailSender,
  type EmailSender,
  type DeliveryTarget,
  type DeliveryResult,
} from "./deliver/channels.ts";
export {
  tick,
  migrateDelivery,
  addSubscription,
  listSubscriptions,
  removeSubscription,
  alreadySent,
  recordSent,
  worthSending,
  periodStart,
  windowForPeriod,
  deliveryKey,
  DELIVERY_DDL,
  type Subscription,
  type Cadence,
  type TickOutcome,
  type TickDeps,
} from "./deliver/scheduler.ts";
export {
  phraseDigest,
  buildPrompt,
  OllamaClient,
  OpenAiCompatClient,
  type LlmClient,
  type PhraseOutcome,
} from "./insight/llm.ts";
