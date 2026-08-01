import {
  companyFactCategories,
  companyFactSourceTypes,
  companyFactStatuses,
  type CompanyFact,
  type CompanyProfile,
} from "./company-profile-contracts.ts";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function cleanText(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function cleanCompanyTicker(value: unknown) {
  const ticker = cleanText(value, 30).toUpperCase();
  return /^[A-Z0-9][A-Z0-9._-]{0,29}$/.test(ticker) ? ticker : "";
}

export function createUserCompanyProfile(value: unknown, now = new Date()): CompanyProfile {
  if (!isObject(value)) throw new Error("Company profile must be an object.");
  const ticker = cleanCompanyTicker(value.ticker);
  const companyName = cleanText(value.companyName, 160);
  if (!ticker || !companyName) throw new Error("A valid ticker and company name are required.");
  if (!Array.isArray(value.facts) || !value.facts.length || value.facts.length > 100) {
    throw new Error("Provide between 1 and 100 company facts.");
  }
  const timestamp = now.toISOString();
  const defaultDate = timestamp.slice(0, 10);
  const facts: CompanyFact[] = value.facts.map((raw, index) => {
    if (!isObject(raw)) throw new Error(`Fact ${index + 1} must be an object.`);
    const category = cleanText(raw.category, 40);
    const status = cleanText(raw.status, 20) || "unverified";
    const sourceType = cleanText(raw.sourceType, 40) || "user_provided";
    if (!companyFactCategories.includes(category as CompanyFact["category"])) throw new Error(`Fact ${index + 1} has an invalid category.`);
    if (!companyFactStatuses.includes(status as CompanyFact["status"])) throw new Error(`Fact ${index + 1} has an invalid status.`);
    if (!companyFactSourceTypes.includes(sourceType as CompanyFact["sourceType"])) throw new Error(`Fact ${index + 1} has an invalid source type.`);
    return {
      id: crypto.randomUUID(),
      category: category as CompanyFact["category"],
      factKey: cleanText(raw.factKey, 100),
      value: cleanText(raw.value, 500),
      status: status as CompanyFact["status"],
      sourceType: sourceType as CompanyFact["sourceType"],
      sourceUrl: cleanText(raw.sourceUrl, 800) || null,
      evidenceText: cleanText(raw.evidenceText, 2_000),
      lastVerificationDate: cleanText(raw.lastVerificationDate, 10) || defaultDate,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  });
  return {
    id: `profile-${ticker.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    ticker,
    companyName,
    facts,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastReviewedAt: timestamp,
  };
}
