export const companyFactCategories = [
  "aliases",
  "sector",
  "industry",
  "products",
  "customers",
  "regions",
  "revenue_drivers",
  "cost_drivers",
  "currency_exposures",
  "commodity_exposures",
  "macro_exposures",
] as const;

export const companyFactStatuses = ["verified", "unverified"] as const;

export const companyFactSourceTypes = [
  "user_provided",
  "local_document",
  "official_company",
  "investor_relations",
  "company_filing",
  "regulator",
  "exchange_announcement",
  "jin10",
  "structured_provider",
  "reputable_external",
  "model_memory",
] as const;

export type CompanyFactCategory = typeof companyFactCategories[number];
export type CompanyFactStatus = typeof companyFactStatuses[number];
export type CompanyFactSourceType = typeof companyFactSourceTypes[number];

export type CompanyFact = {
  id: string;
  category: CompanyFactCategory;
  factKey: string;
  value: string;
  status: CompanyFactStatus;
  sourceType: CompanyFactSourceType;
  sourceUrl: string | null;
  evidenceText: string;
  lastVerificationDate: string;
  createdAt: string;
  updatedAt: string;
};

export type CompanyFactConflict = {
  category: CompanyFactCategory;
  factKey: string;
  factIds: string[];
  values: string[];
};

export type CompanyProfile = {
  id: string;
  ticker: string;
  companyName: string;
  facts: CompanyFact[];
  createdAt: string;
  updatedAt: string;
  lastReviewedAt: string;
};

export type CompanyProfileHealth = {
  complete: boolean;
  stale: boolean;
  reusable: boolean;
  missingCategories: CompanyFactCategory[];
  staleFactIds: string[];
  conflicts: CompanyFactConflict[];
};

export type CompanyProfileAvailability = "ready" | "missing" | "incomplete" | "stale" | "conflicted" | "error";

export type CompanyProfileContext = {
  ticker: string;
  companyName: string;
  availability: CompanyProfileAvailability;
  complete: boolean;
  stale: boolean;
  reusable: boolean;
  missingCategories: CompanyFactCategory[];
  conflicts: CompanyFactConflict[];
  verifiedFactCount: number;
  unverifiedFactCount: number;
  facts: CompanyFact[];
  technicalError: string | null;
};

export type CompanyProfileValidation = {
  valid: boolean;
  errors: string[];
};

export const requiredCompanyProfileCategories: CompanyFactCategory[] = [
  "sector",
  "industry",
  "products",
];

const webSourceTypes = new Set<CompanyFactSourceType>([
  "official_company",
  "investor_relations",
  "company_filing",
  "regulator",
  "exchange_announcement",
  "jin10",
  "structured_provider",
  "reputable_external",
]);

function normalizedText(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function isIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function hasSafeHttpsUrl(value: string | null) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function validateCompanyFact(fact: CompanyFact): CompanyProfileValidation {
  const errors: string[] = [];
  if (!fact.id.trim()) errors.push("Fact ID is required.");
  if (!companyFactCategories.includes(fact.category)) errors.push("Fact category is invalid.");
  if (!fact.factKey.trim()) errors.push("Fact key is required.");
  if (!fact.value.trim()) errors.push("Fact value is required.");
  if (!companyFactStatuses.includes(fact.status)) errors.push("Fact status is invalid.");
  if (!companyFactSourceTypes.includes(fact.sourceType)) errors.push("Fact source type is invalid.");
  if (!fact.evidenceText.trim()) errors.push("Evidence text is required.");
  if (!isIsoDate(fact.lastVerificationDate)) errors.push("Last verification date must use YYYY-MM-DD.");
  if (!Number.isFinite(Date.parse(fact.createdAt))) errors.push("Created timestamp is invalid.");
  if (!Number.isFinite(Date.parse(fact.updatedAt))) errors.push("Updated timestamp is invalid.");

  if (webSourceTypes.has(fact.sourceType) && !hasSafeHttpsUrl(fact.sourceUrl)) {
    errors.push("Web-sourced facts require a safe HTTPS source URL.");
  }
  if (fact.sourceUrl && !hasSafeHttpsUrl(fact.sourceUrl)) {
    errors.push("Source URL must be HTTPS and must not contain credentials.");
  }
  if (fact.status === "verified" && fact.sourceType === "model_memory") {
    errors.push("Model memory cannot be saved as a verified fact.");
  }

  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function validateCompanyProfile(profile: CompanyProfile): CompanyProfileValidation {
  const errors: string[] = [];
  if (!profile.id.trim()) errors.push("Profile ID is required.");
  if (!profile.ticker.trim() || profile.ticker !== profile.ticker.toUpperCase()) errors.push("Ticker must be non-empty and uppercase.");
  if (!profile.companyName.trim()) errors.push("Company name is required.");
  if (!Number.isFinite(Date.parse(profile.createdAt))) errors.push("Profile created timestamp is invalid.");
  if (!Number.isFinite(Date.parse(profile.updatedAt))) errors.push("Profile updated timestamp is invalid.");
  if (!Number.isFinite(Date.parse(profile.lastReviewedAt))) errors.push("Profile review timestamp is invalid.");
  const ids = new Set<string>();
  profile.facts.forEach((fact) => {
    if (ids.has(fact.id)) errors.push(`Duplicate fact ID: ${fact.id}.`);
    ids.add(fact.id);
    validateCompanyFact(fact).errors.forEach((error) => errors.push(`${fact.id || "unknown fact"}: ${error}`));
  });
  return { valid: errors.length === 0, errors };
}

function logicalSlot(fact: Pick<CompanyFact, "category" | "factKey">) {
  return `${fact.category}:${normalizedText(fact.factKey)}`;
}

function factFingerprint(fact: CompanyFact) {
  return [logicalSlot(fact), normalizedText(fact.value), fact.status, fact.sourceType, fact.sourceUrl ?? "", normalizedText(fact.evidenceText)].join("|");
}

export function findCompanyFactConflicts(facts: CompanyFact[]): CompanyFactConflict[] {
  const groups = new Map<string, CompanyFact[]>();
  facts.forEach((fact) => {
    const slot = logicalSlot(fact);
    groups.set(slot, [...(groups.get(slot) ?? []), fact]);
  });
  const conflicts: CompanyFactConflict[] = [];
  groups.forEach((group) => {
    const values = [...new Set(group.map((fact) => normalizedText(fact.value)))];
    if (values.length < 2) return;
    conflicts.push({
      category: group[0].category,
      factKey: group[0].factKey,
      factIds: group.map((fact) => fact.id).sort(),
      values: group.map((fact) => fact.value).filter((value, index, all) => all.findIndex((item) => normalizedText(item) === normalizedText(value)) === index),
    });
  });
  return conflicts.sort((a, b) => `${a.category}:${a.factKey}`.localeCompare(`${b.category}:${b.factKey}`));
}

export function mergeCompanyProfiles(existing: CompanyProfile | null, incoming: CompanyProfile): CompanyProfile {
  const incomingValidation = validateCompanyProfile(incoming);
  if (!incomingValidation.valid) throw new Error(`Invalid company profile: ${incomingValidation.errors.join(" ")}`);
  if (!existing) return { ...incoming, ticker: incoming.ticker.toUpperCase(), facts: [...incoming.facts] };
  if (existing.ticker !== incoming.ticker) throw new Error("Cannot merge profiles with different tickers.");

  const facts = [...existing.facts];
  const fingerprints = new Set(facts.map(factFingerprint));
  const factsById = new Map(facts.map((fact) => [fact.id, factFingerprint(fact)]));
  incoming.facts.forEach((fact) => {
    const fingerprint = factFingerprint(fact);
    const existingFingerprint = factsById.get(fact.id);
    if (existingFingerprint && existingFingerprint !== fingerprint) {
      throw new Error(`Fact ID ${fact.id} already belongs to different evidence.`);
    }
    if (!fingerprints.has(fingerprint)) {
      facts.push(fact);
      fingerprints.add(fingerprint);
      factsById.set(fact.id, fingerprint);
    }
  });
  return {
    ...existing,
    companyName: incoming.companyName || existing.companyName,
    facts,
    updatedAt: incoming.updatedAt,
    lastReviewedAt: incoming.lastReviewedAt,
  };
}

export function assessCompanyProfile(
  profile: CompanyProfile,
  options: { now?: Date; staleAfterDays?: number; requiredCategories?: CompanyFactCategory[] } = {},
): CompanyProfileHealth {
  const now = options.now ?? new Date();
  const staleAfterDays = Math.max(1, options.staleAfterDays ?? 365);
  const cutoff = now.getTime() - staleAfterDays * 24 * 60 * 60 * 1000;
  const requiredCategories = options.requiredCategories ?? requiredCompanyProfileCategories;
  const verified = profile.facts.filter((fact) => fact.status === "verified");
  const missingCategories = requiredCategories.filter((category) => !verified.some((fact) => fact.category === category));
  const staleFactIds = verified
    .filter((fact) => Date.parse(`${fact.lastVerificationDate}T00:00:00Z`) < cutoff)
    .map((fact) => fact.id)
    .sort();
  const baselineFactsAreStale = requiredCategories.some((category) =>
    verified.some((fact) => fact.category === category)
    && !verified.some((fact) =>
      fact.category === category
      && Date.parse(`${fact.lastVerificationDate}T00:00:00Z`) >= cutoff));
  const profileReviewIsStale = Date.parse(profile.lastReviewedAt) < cutoff;
  const conflicts = findCompanyFactConflicts(profile.facts);
  const complete = missingCategories.length === 0;
  const stale = profileReviewIsStale || baselineFactsAreStale;
  return { complete, stale, reusable: complete && !stale && conflicts.length === 0, missingCategories, staleFactIds, conflicts };
}

export function createCompanyProfileContext(
  ticker: string,
  companyName: string,
  profile: CompanyProfile | null,
  options: { now?: Date; technicalError?: string } = {},
): CompanyProfileContext {
  if (!profile) {
    return {
      ticker: ticker.toUpperCase(), companyName, availability: options.technicalError ? "error" : "missing",
      complete: false, stale: false, reusable: false,
      missingCategories: [...requiredCompanyProfileCategories], conflicts: [],
      verifiedFactCount: 0, unverifiedFactCount: 0, facts: [], technicalError: options.technicalError ?? null,
    };
  }
  const validation = validateCompanyProfile(profile);
  if (!validation.valid) throw new Error(validation.errors.join(" "));
  const health = assessCompanyProfile(profile, { now: options.now });
  const availability: CompanyProfileAvailability = health.conflicts.length
    ? "conflicted"
    : health.stale
      ? "stale"
      : health.complete
        ? "ready"
        : "incomplete";
  return {
    ticker: ticker.toUpperCase(), companyName: profile.companyName, availability,
    complete: health.complete, stale: health.stale, reusable: health.reusable,
    missingCategories: health.missingCategories, conflicts: health.conflicts,
    verifiedFactCount: profile.facts.filter((fact) => fact.status === "verified").length,
    unverifiedFactCount: profile.facts.filter((fact) => fact.status === "unverified").length,
    facts: [...profile.facts], technicalError: null,
  };
}
