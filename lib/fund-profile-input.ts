import {
  fundFactCategories,
  fundFactSourceTypes,
  fundFactStatuses,
  fundSecurityTypes,
  type FundFact,
  type FundHolding,
  type FundProfile,
  type FundStructure,
} from "./fund-profile-contracts.ts";
import { cleanCompanyTicker } from "./company-profile-input.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function cleanText(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function cleanNullableText(value: unknown, max: number) {
  return cleanText(value, max) || null;
}

function cleanStatus(value: unknown, label: string) {
  const status = cleanText(value, 20) || "unverified";
  if (!fundFactStatuses.includes(status as FundFact["status"])) throw new Error(`${label} has an invalid status.`);
  return status as FundFact["status"];
}

function cleanSourceType(value: unknown, label: string) {
  const sourceType = cleanText(value, 40) || "user_provided";
  if (!fundFactSourceTypes.includes(sourceType as FundFact["sourceType"])) throw new Error(`${label} has an invalid source type.`);
  return sourceType as FundFact["sourceType"];
}

function cleanStructure(value: unknown): FundStructure {
  const raw = isObject(value) ? value : {};
  return {
    leverageMultiplier: typeof raw.leverageMultiplier === "number" ? raw.leverageMultiplier : null,
    inverse: typeof raw.inverse === "boolean" ? raw.inverse : null,
    dailyReset: typeof raw.dailyReset === "boolean" ? raw.dailyReset : null,
    coveredCall: typeof raw.coveredCall === "boolean" ? raw.coveredCall : null,
    activelyManaged: typeof raw.activelyManaged === "boolean" ? raw.activelyManaged : null,
  };
}

export function cleanFundTicker(value: unknown) {
  return cleanCompanyTicker(value);
}

export function createUserFundProfile(value: unknown, now = new Date()): FundProfile {
  if (!isObject(value)) throw new Error("Fund profile must be an object.");
  const ticker = cleanFundTicker(value.ticker);
  const fundName = cleanText(value.fundName, 200);
  const securityType = cleanText(value.securityType, 40);
  if (!ticker || !fundName) throw new Error("A valid ticker and fund name are required.");
  if (!fundSecurityTypes.includes(securityType as FundProfile["securityType"])) {
    throw new Error("Security type must be ETF or closed-end fund.");
  }
  const rawFacts = value.facts === undefined ? [] : value.facts;
  const rawHoldings = value.holdings === undefined ? [] : value.holdings;
  if (!Array.isArray(rawFacts) || rawFacts.length > 100) throw new Error("Provide no more than 100 fund facts.");
  if (!Array.isArray(rawHoldings) || rawHoldings.length > 500) throw new Error("Provide no more than 500 fund holdings.");
  if (!rawFacts.length && !rawHoldings.length) throw new Error("Provide at least one fund fact or holding.");

  const timestamp = now.toISOString();
  const defaultDate = timestamp.slice(0, 10);
  const facts: FundFact[] = rawFacts.map((raw, index) => {
    if (!isObject(raw)) throw new Error(`Fund fact ${index + 1} must be an object.`);
    const category = cleanText(raw.category, 40);
    if (!fundFactCategories.includes(category as FundFact["category"])) throw new Error(`Fund fact ${index + 1} has an invalid category.`);
    return {
      id: crypto.randomUUID(),
      category: category as FundFact["category"],
      factKey: cleanText(raw.factKey, 120),
      value: cleanText(raw.value, 1_000),
      status: cleanStatus(raw.status, `Fund fact ${index + 1}`),
      sourceType: cleanSourceType(raw.sourceType, `Fund fact ${index + 1}`),
      sourceUrl: cleanNullableText(raw.sourceUrl, 800),
      evidenceText: cleanText(raw.evidenceText, 4_000),
      effectiveDate: cleanNullableText(raw.effectiveDate, 10),
      lastVerificationDate: cleanText(raw.lastVerificationDate, 10) || defaultDate,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  });
  const holdings: FundHolding[] = rawHoldings.map((raw, index) => {
    if (!isObject(raw)) throw new Error(`Fund holding ${index + 1} must be an object.`);
    return {
      id: crypto.randomUUID(),
      constituentTicker: cleanFundTicker(raw.constituentTicker) || null,
      constituentName: cleanText(raw.constituentName, 200),
      weightPercent: typeof raw.weightPercent === "number" ? raw.weightPercent : null,
      country: cleanNullableText(raw.country, 100),
      sector: cleanNullableText(raw.sector, 120),
      currency: cleanNullableText(raw.currency, 20),
      status: cleanStatus(raw.status, `Fund holding ${index + 1}`),
      sourceType: cleanSourceType(raw.sourceType, `Fund holding ${index + 1}`),
      sourceUrl: cleanNullableText(raw.sourceUrl, 800),
      evidenceText: cleanText(raw.evidenceText, 4_000),
      effectiveDate: cleanText(raw.effectiveDate, 10),
      lastVerificationDate: cleanText(raw.lastVerificationDate, 10) || defaultDate,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  });
  return {
    id: `fund-${ticker.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    ticker,
    fundName,
    issuerName: cleanNullableText(value.issuerName, 200),
    securityType: securityType as FundProfile["securityType"],
    structure: cleanStructure(value.structure),
    facts,
    holdings,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastReviewedAt: timestamp,
  };
}
