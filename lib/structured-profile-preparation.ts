import { AlphaVantageClient } from "./alpha-vantage.ts";
import { assessCompanyProfile, type CompanyFact, type CompanyProfile } from "./company-profile-contracts.ts";
import type { CompanyProfileStore } from "./company-profile-store.ts";
import {
  assessFundProfile,
  type FundFact,
  type FundHolding,
  type FundProfile,
  type FundSecurityType,
  type FundStructure,
} from "./fund-profile-contracts.ts";
import type { FundProfileStore } from "./fund-profile-store.ts";

const COMPANY_SOURCE_URL = "https://www.alphavantage.co/documentation/#company-overview";
const ETF_SOURCE_URL = "https://www.alphavantage.co/documentation/#etf-profile";

function text(value: unknown, max = 1_000) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const result = String(value).trim().replace(/\s+/g, " ");
  return /^(?:none|null|n\/a|-)$/i.test(result) ? "" : result.slice(0, max);
}

function field(data: Record<string, unknown>, ...names: string[]) {
  for (const name of names) {
    if (name in data) return data[name];
  }
  const lowered = new Map(Object.entries(data).map(([key, value]) => [key.toLocaleLowerCase(), value]));
  for (const name of names) {
    if (lowered.has(name.toLocaleLowerCase())) return lowered.get(name.toLocaleLowerCase());
  }
  return undefined;
}

function arrayField(data: Record<string, unknown>, ...names: string[]) {
  const value = field(data, ...names);
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> =>
    Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function slug(value: string) {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "primary";
}

function positiveFlag(value: unknown) {
  return value === true
    || value === 1
    || (typeof value === "string" && /^(?:true|yes|y|1|leveraged)$/i.test(value.trim()));
}

function percentage(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const parsed = Number(raw.replace(/,/g, "").replace(/%$/, ""));
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  const normalized = raw.endsWith("%") || parsed > 1 ? parsed : parsed * 100;
  return normalized <= 100 ? Math.round(normalized * 10_000) / 10_000 : null;
}

function formatPercentage(value: number) {
  return `${Math.round(value * 100) / 100}%`;
}

function matchingTicker(data: Record<string, unknown>, ticker: string) {
  const returned = text(field(data, "Symbol", "symbol"), 30).toUpperCase();
  return !returned || returned === ticker;
}

function companyFact(
  category: CompanyFact["category"],
  factKey: string,
  value: string,
  fieldName: string,
  timestamp: string,
): CompanyFact {
  return {
    id: crypto.randomUUID(),
    category,
    factKey,
    value,
    status: "verified",
    sourceType: "structured_provider",
    sourceUrl: COMPANY_SOURCE_URL,
    evidenceText: `Alpha Vantage OVERVIEW ${fieldName}: ${value}`,
    lastVerificationDate: timestamp.slice(0, 10),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function fundFact(
  category: FundFact["category"],
  factKey: string,
  value: string,
  fieldName: string,
  timestamp: string,
  sourceUrl = ETF_SOURCE_URL,
): FundFact {
  return {
    id: crypto.randomUUID(),
    category,
    factKey,
    value,
    status: "verified",
    sourceType: "structured_provider",
    sourceUrl,
    evidenceText: `Alpha Vantage structured profile ${fieldName}: ${value}`,
    effectiveDate: null,
    lastVerificationDate: timestamp.slice(0, 10),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export type StructuredCompanyPreparation = {
  provider: "alpha_vantage";
  profile: CompanyProfile | null;
  health: ReturnType<typeof assessCompanyProfile> | null;
  factsAdded: number;
};

export async function prepareCompanyFromAlphaVantage(args: {
  ticker: string;
  companyName: string;
  client: Pick<AlphaVantageClient, "getCompanyOverview">;
  store: Pick<CompanyProfileStore, "getByTicker" | "save">;
  now?: Date;
}): Promise<StructuredCompanyPreparation> {
  const ticker = args.ticker.trim().toUpperCase();
  const response = await args.client.getCompanyOverview(ticker);
  const existing = await args.store.getByTicker(ticker);
  if (!response || !matchingTicker(response, ticker)) {
    return { provider: "alpha_vantage", profile: existing, health: existing ? assessCompanyProfile(existing) : null, factsAdded: 0 };
  }
  const timestamp = (args.now ?? new Date()).toISOString();
  const facts: CompanyFact[] = [];
  const sector = text(field(response, "Sector"), 300);
  const industry = text(field(response, "Industry"), 300);
  const description = text(field(response, "Description"), 500);
  const returnedName = text(field(response, "Name"), 160);
  if (sector) facts.push(companyFact("sector", "primary", sector, "Sector", timestamp));
  if (industry) facts.push(companyFact("industry", "primary", industry, "Industry", timestamp));
  if (description) facts.push(companyFact("products", "business_nature", description, "Description", timestamp));
  if (returnedName && returnedName.toLocaleLowerCase() !== args.companyName.trim().toLocaleLowerCase()) {
    facts.push(companyFact("aliases", "provider_name", returnedName, "Name", timestamp));
  }
  if (!facts.length) {
    return { provider: "alpha_vantage", profile: existing, health: existing ? assessCompanyProfile(existing) : null, factsAdded: 0 };
  }
  const incoming: CompanyProfile = {
    id: existing?.id ?? `profile-${slug(ticker)}`,
    ticker,
    companyName: returnedName || args.companyName.trim().slice(0, 160),
    facts,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    lastReviewedAt: timestamp,
  };
  const existingIds = new Set(existing?.facts.map((fact) => fact.id) ?? []);
  const saved = await args.store.save(incoming);
  return {
    provider: "alpha_vantage",
    profile: saved,
    health: assessCompanyProfile(saved),
    factsAdded: saved.facts.filter((fact) => !existingIds.has(fact.id)).length,
  };
}

function etfExposureFacts(response: Record<string, unknown>, timestamp: string) {
  const facts: FundFact[] = [];
  const assetClass = text(field(response, "assetClass", "asset_class", "AssetClass"), 300);
  if (assetClass) facts.push(fundFact("asset_class_exposure", "primary", assetClass, "asset class", timestamp));

  const sectors = arrayField(response, "sectors", "sector_allocation", "SectorAllocation")
    .map((sector) => ({
      sector,
      weightPercent: percentage(field(sector, "weight", "percentage", "allocation")),
    }))
    .filter((item) => item.weightPercent === null || item.weightPercent > 0)
    .sort((a, b) => (b.weightPercent ?? 0) - (a.weightPercent ?? 0))
    .slice(0, 8);
  sectors.forEach((sector, index) => {
    const name = text(field(sector.sector, "sector", "name", "description"), 160);
    if (name) facts.push(fundFact(
      "sector_exposure",
      `allocation_${slug(name) || index + 1}`,
      sector.weightPercent === null ? name : `${name}: ${formatPercentage(sector.weightPercent)}`,
      "sector allocation",
      timestamp,
    ));
  });

  const holdings = arrayField(response, "holdings", "constituents", "Holdings");
  if (!assetClass && !sectors.length && holdings.length) {
    facts.push(fundFact(
      "asset_class_exposure",
      "holdings_based",
      "Listed securities represented in the ETF holdings profile",
      "holdings",
      timestamp,
    ));
  }
  return facts;
}

function etfHoldings(response: Record<string, unknown>, timestamp: string) {
  return arrayField(response, "holdings", "constituents", "Holdings")
    .map((holding) => {
      const constituentTicker = text(field(holding, "symbol", "ticker", "code"), 30).toUpperCase();
      const constituentName = text(field(holding, "description", "name", "company"), 200) || constituentTicker;
      const weightPercent = percentage(field(holding, "weight", "percentage", "allocation"));
      return { constituentTicker, constituentName, weightPercent };
    })
    .filter((holding) => Boolean(holding.constituentName) && holding.weightPercent !== null && holding.weightPercent > 0)
    .sort((a, b) => (b.weightPercent ?? 0) - (a.weightPercent ?? 0))
    .slice(0, 20)
    .map((holding): FundHolding => ({
      id: crypto.randomUUID(),
      constituentTicker: holding.constituentTicker || null,
      constituentName: holding.constituentName,
      weightPercent: holding.weightPercent,
      country: null,
      sector: null,
      currency: null,
      status: "verified",
      sourceType: "structured_provider",
      sourceUrl: ETF_SOURCE_URL,
      evidenceText: `Alpha Vantage ETF_PROFILE holding: ${holding.constituentTicker || "no ticker"} | ${holding.constituentName} | weight ${formatPercentage(holding.weightPercent ?? 0)}`,
      effectiveDate: timestamp.slice(0, 10),
      lastVerificationDate: timestamp.slice(0, 10),
      createdAt: timestamp,
      updatedAt: timestamp,
    }));
}

export type StructuredFundPreparation = {
  provider: "alpha_vantage";
  profile: FundProfile | null;
  health: ReturnType<typeof assessFundProfile> | null;
  factsAdded: number;
  holdingsAdded: number;
};

export async function prepareFundFromAlphaVantage(args: {
  ticker: string;
  fundName: string;
  securityType: FundSecurityType;
  client: Pick<AlphaVantageClient, "getCompanyOverview" | "getEtfProfile">;
  store: Pick<FundProfileStore, "getByTicker" | "save">;
  now?: Date;
}): Promise<StructuredFundPreparation> {
  const ticker = args.ticker.trim().toUpperCase();
  const response = args.securityType === "etf"
    ? await args.client.getEtfProfile(ticker)
    : await args.client.getCompanyOverview(ticker);
  const existing = await args.store.getByTicker(ticker);
  if (!response || !matchingTicker(response, ticker)) {
    return {
      provider: "alpha_vantage",
      profile: existing,
      health: existing ? assessFundProfile(existing) : null,
      factsAdded: 0,
      holdingsAdded: 0,
    };
  }
  const timestamp = (args.now ?? new Date()).toISOString();
  const sourceUrl = args.securityType === "etf" ? ETF_SOURCE_URL : COMPANY_SOURCE_URL;
  const facts: FundFact[] = [
    fundFact(
      "fund_type",
      "primary",
      args.securityType === "etf" ? "ETF" : "Closed-end fund",
      args.securityType === "etf" ? "ETF_PROFILE response" : "OVERVIEW response",
      timestamp,
      sourceUrl,
    ),
  ];
  const structure: FundStructure = {
    leverageMultiplier: null, inverse: null, dailyReset: null, coveredCall: null, activelyManaged: null,
  };
  const holdings = args.securityType === "etf" ? etfHoldings(response, timestamp) : [];
  if (args.securityType === "etf") {
    facts.push(...etfExposureFacts(response, timestamp));
    if (positiveFlag(field(response, "leveraged", "isLeveraged", "is_leveraged"))) {
      facts.push(fundFact(
        "fund_structure",
        "provider_leveraged_indicator",
        "Leveraged ETF",
        "leveraged",
        timestamp,
      ));
    }
    const benchmark = text(field(response, "benchmark", "trackingIndex", "tracking_index", "index"), 500);
    const description = text(field(response, "description", "investmentStrategy", "investment_strategy"), 1_000);
    const issuer = text(field(response, "issuer", "fundFamily", "fund_family", "etfCompany"), 200);
    if (benchmark) facts.push(fundFact("benchmark", "primary", benchmark, "benchmark", timestamp));
    if (description) facts.push(fundFact("strategy", "primary", description, "description", timestamp));
    if (issuer) facts.push(fundFact("issuer", "primary", issuer, "issuer", timestamp));
  } else {
    const description = text(field(response, "Description"), 1_000);
    const sector = text(field(response, "Sector"), 300);
    const industry = text(field(response, "Industry"), 300);
    if (description) facts.push(fundFact("strategy", "business_nature", description, "Description", timestamp, sourceUrl));
    if (sector) facts.push(fundFact("sector_exposure", "primary", sector, "Sector", timestamp, sourceUrl));
    if (industry) facts.push(fundFact("asset_class_exposure", "industry", industry, "Industry", timestamp, sourceUrl));
  }
  const returnedName = text(field(response, "Name", "name"), 200);
  const issuerName = text(field(response, "issuer", "fundFamily", "fund_family", "etfCompany"), 200) || existing?.issuerName || null;
  const incoming: FundProfile = {
    id: existing?.id ?? `fund-${slug(ticker)}`,
    ticker,
    fundName: returnedName || args.fundName.trim().slice(0, 200),
    issuerName,
    securityType: args.securityType,
    structure: existing ? {
      leverageMultiplier: existing.structure.leverageMultiplier ?? structure.leverageMultiplier,
      inverse: existing.structure.inverse ?? structure.inverse,
      dailyReset: existing.structure.dailyReset ?? structure.dailyReset,
      coveredCall: existing.structure.coveredCall ?? structure.coveredCall,
      activelyManaged: existing.structure.activelyManaged ?? structure.activelyManaged,
    } : structure,
    facts,
    holdings,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    lastReviewedAt: timestamp,
  };
  const existingIds = new Set(existing?.facts.map((fact) => fact.id) ?? []);
  const existingHoldingIds = new Set(existing?.holdings.map((holding) => holding.id) ?? []);
  const saved = await args.store.save(incoming);
  return {
    provider: "alpha_vantage",
    profile: saved,
    health: assessFundProfile(saved),
    factsAdded: saved.facts.filter((fact) => !existingIds.has(fact.id)).length,
    holdingsAdded: saved.holdings.filter((holding) => !existingHoldingIds.has(holding.id)).length,
  };
}
