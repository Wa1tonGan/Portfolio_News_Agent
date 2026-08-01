import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const companyProfiles = sqliteTable("company_profiles", {
  id: text("id").primaryKey(),
  ticker: text("ticker").notNull(),
  companyName: text("company_name").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastReviewedAt: text("last_reviewed_at").notNull(),
}, (table) => [
  uniqueIndex("company_profiles_ticker_idx").on(table.ticker),
]);

export const companyFacts = sqliteTable("company_facts", {
  id: text("id").primaryKey(),
  profileId: text("profile_id").notNull().references(() => companyProfiles.id, { onDelete: "cascade" }),
  category: text("category").notNull(),
  factKey: text("fact_key").notNull(),
  value: text("value").notNull(),
  status: text("status").notNull(),
  sourceType: text("source_type").notNull(),
  sourceUrl: text("source_url"),
  evidenceText: text("evidence_text").notNull(),
  lastVerificationDate: text("last_verification_date").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("company_facts_profile_idx").on(table.profileId),
  index("company_facts_lookup_idx").on(table.profileId, table.category, table.factKey),
]);

export const fundProfiles = sqliteTable("fund_profiles", {
  id: text("id").primaryKey(),
  ticker: text("ticker").notNull(),
  fundName: text("fund_name").notNull(),
  issuerName: text("issuer_name"),
  securityType: text("security_type").notNull(),
  leverageMultiplier: real("leverage_multiplier").notNull(),
  inverse: integer("inverse", { mode: "boolean" }).notNull(),
  dailyReset: integer("daily_reset", { mode: "boolean" }).notNull(),
  coveredCall: integer("covered_call", { mode: "boolean" }).notNull(),
  activelyManaged: integer("actively_managed", { mode: "boolean" }).notNull(),
  leverageKnown: integer("leverage_known", { mode: "boolean" }).notNull().default(false),
  inverseKnown: integer("inverse_known", { mode: "boolean" }).notNull().default(false),
  dailyResetKnown: integer("daily_reset_known", { mode: "boolean" }).notNull().default(false),
  coveredCallKnown: integer("covered_call_known", { mode: "boolean" }).notNull().default(false),
  activelyManagedKnown: integer("actively_managed_known", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastReviewedAt: text("last_reviewed_at").notNull(),
}, (table) => [
  uniqueIndex("fund_profiles_ticker_idx").on(table.ticker),
]);

export const fundFacts = sqliteTable("fund_facts", {
  id: text("id").primaryKey(),
  profileId: text("profile_id").notNull().references(() => fundProfiles.id, { onDelete: "cascade" }),
  category: text("category").notNull(),
  factKey: text("fact_key").notNull(),
  value: text("value").notNull(),
  status: text("status").notNull(),
  sourceType: text("source_type").notNull(),
  sourceUrl: text("source_url"),
  evidenceText: text("evidence_text").notNull(),
  effectiveDate: text("effective_date"),
  lastVerificationDate: text("last_verification_date").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("fund_facts_profile_idx").on(table.profileId),
  index("fund_facts_lookup_idx").on(table.profileId, table.category, table.factKey, table.effectiveDate),
]);

export const fundHoldings = sqliteTable("fund_holdings", {
  id: text("id").primaryKey(),
  profileId: text("profile_id").notNull().references(() => fundProfiles.id, { onDelete: "cascade" }),
  constituentTicker: text("constituent_ticker"),
  constituentName: text("constituent_name").notNull(),
  weightPercent: real("weight_percent"),
  country: text("country"),
  sector: text("sector"),
  currency: text("currency"),
  status: text("status").notNull(),
  sourceType: text("source_type").notNull(),
  sourceUrl: text("source_url"),
  evidenceText: text("evidence_text").notNull(),
  effectiveDate: text("effective_date").notNull(),
  lastVerificationDate: text("last_verification_date").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("fund_holdings_profile_idx").on(table.profileId),
  index("fund_holdings_lookup_idx").on(table.profileId, table.constituentTicker, table.constituentName, table.effectiveDate),
]);

export const usSecurities = sqliteTable("us_securities", {
  symbol: text("symbol").primaryKey(),
  nasdaqSymbol: text("nasdaq_symbol").notNull(),
  cqsSymbol: text("cqs_symbol").notNull(),
  securityName: text("security_name").notNull(),
  exchangeCode: text("exchange_code").notNull(),
  exchangeName: text("exchange_name").notNull(),
  securityType: text("security_type").notNull(),
  isEtf: integer("is_etf", { mode: "boolean" }).notNull(),
  sourceDataset: text("source_dataset").notNull(),
  sourceUpdatedAt: text("source_updated_at").notNull(),
  cachedAt: text("cached_at").notNull(),
  refreshId: text("refresh_id").notNull(),
}, (table) => [
  index("us_securities_lookup_idx").on(table.nasdaqSymbol, table.cqsSymbol),
  index("us_securities_type_idx").on(table.securityType),
]);

export const securityRegistryMetadata = sqliteTable("security_registry_metadata", {
  registryKey: text("registry_key").primaryKey(),
  lastRefreshAt: text("last_refresh_at").notNull(),
  sourceUpdatedAt: text("source_updated_at").notNull(),
});

export const analysisRuns = sqliteTable("analysis_runs", {
  id: text("id").primaryKey(),
  status: text("status").notNull(),
  portfolioJson: text("portfolio_json").notNull(),
  resultJson: text("result_json"),
  errorText: text("error_text"),
  startedAt: text("started_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  completedAt: text("completed_at"),
}, (table) => [
  index("analysis_runs_started_idx").on(table.startedAt),
  index("analysis_runs_status_idx").on(table.status),
]);

export const analysisActivities = sqliteTable("analysis_activities", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull().references(() => analysisRuns.id, { onDelete: "cascade" }),
  sequence: integer("sequence").notNull(),
  activityJson: text("activity_json").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [
  uniqueIndex("analysis_activities_run_sequence_idx").on(table.runId, table.sequence),
]);
