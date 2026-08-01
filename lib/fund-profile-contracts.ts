export const fundFactCategories = [
  "fund_type",
  "issuer",
  "benchmark",
  "strategy",
  "sector_exposure",
  "country_exposure",
  "currency_exposure",
  "asset_class_exposure",
  "commodity_exposure",
  "interest_rate_exposure",
  "credit_exposure",
  "fund_structure",
] as const;

export const fundFactStatuses = ["verified", "unverified"] as const;

export const fundFactSourceTypes = [
  "official_fund_page",
  "official_holdings",
  "official_factsheet",
  "prospectus",
  "regulator",
  "exchange_announcement",
  "index_provider",
  "structured_provider",
  "reputable_external",
  "user_provided",
  "local_document",
  "model_memory",
] as const;

export const fundSecurityTypes = ["etf", "closed_end_fund"] as const;
export const fundStructureFields = [
  "leverageMultiplier",
  "inverse",
  "dailyReset",
  "coveredCall",
  "activelyManaged",
] as const;

export type FundFactCategory = typeof fundFactCategories[number];
export type FundFactStatus = typeof fundFactStatuses[number];
export type FundFactSourceType = typeof fundFactSourceTypes[number];
export type FundSecurityType = typeof fundSecurityTypes[number];
export type FundStructureField = typeof fundStructureFields[number];

export type FundFact = {
  id: string;
  category: FundFactCategory;
  factKey: string;
  value: string;
  status: FundFactStatus;
  sourceType: FundFactSourceType;
  sourceUrl: string | null;
  evidenceText: string;
  effectiveDate: string | null;
  lastVerificationDate: string;
  createdAt: string;
  updatedAt: string;
};

export type FundHolding = {
  id: string;
  constituentTicker: string | null;
  constituentName: string;
  weightPercent: number | null;
  country: string | null;
  sector: string | null;
  currency: string | null;
  status: FundFactStatus;
  sourceType: FundFactSourceType;
  sourceUrl: string | null;
  evidenceText: string;
  effectiveDate: string;
  lastVerificationDate: string;
  createdAt: string;
  updatedAt: string;
};

export type FundStructure = {
  leverageMultiplier: number | null;
  inverse: boolean | null;
  dailyReset: boolean | null;
  coveredCall: boolean | null;
  activelyManaged: boolean | null;
};

export type FundFactConflict = {
  category: FundFactCategory;
  factKey: string;
  effectiveDate: string | null;
  factIds: string[];
  values: string[];
};

export type FundHoldingConflict = {
  constituentKey: string;
  effectiveDate: string;
  holdingIds: string[];
  weights: Array<number | null>;
};

export type FundProfile = {
  id: string;
  ticker: string;
  fundName: string;
  issuerName: string | null;
  securityType: FundSecurityType;
  structure: FundStructure;
  facts: FundFact[];
  holdings: FundHolding[];
  createdAt: string;
  updatedAt: string;
  lastReviewedAt: string;
};

export type FundProfileHealth = {
  complete: boolean;
  stale: boolean;
  reusable: boolean;
  missingCategories: FundFactCategory[];
  missingExposure: boolean;
  missingNature: boolean;
  missingStructureFields: FundStructureField[];
  staleFactIds: string[];
  staleHoldingIds: string[];
  factConflicts: FundFactConflict[];
  holdingConflicts: FundHoldingConflict[];
};

export type FundProfileAvailability = "ready" | "missing" | "incomplete" | "stale" | "conflicted" | "error";

export type FundProfileContext = {
  ticker: string;
  fundName: string;
  availability: FundProfileAvailability;
  complete: boolean;
  stale: boolean;
  reusable: boolean;
  missingCategories: FundFactCategory[];
  missingExposure: boolean;
  missingNature: boolean;
  missingStructureFields: FundStructureField[];
  factConflicts: FundFactConflict[];
  holdingConflicts: FundHoldingConflict[];
  verifiedFactCount: number;
  unverifiedFactCount: number;
  verifiedHoldingCount: number;
  unverifiedHoldingCount: number;
  facts: FundFact[];
  holdings: FundHolding[];
  technicalError: string | null;
};

export type FundProfileValidation = {
  valid: boolean;
  errors: string[];
};

export const requiredFundProfileCategories: FundFactCategory[] = [
  "fund_type",
];

const exposureCategories = new Set<FundFactCategory>([
  "sector_exposure",
  "country_exposure",
  "currency_exposure",
  "asset_class_exposure",
  "commodity_exposure",
  "interest_rate_exposure",
  "credit_exposure",
]);

const webSourceTypes = new Set<FundFactSourceType>([
  "official_fund_page",
  "official_holdings",
  "official_factsheet",
  "prospectus",
  "regulator",
  "exchange_announcement",
  "index_provider",
  "structured_provider",
  "reputable_external",
]);

function positiveFeatureMention(value: string, pattern: RegExp, negativePattern: RegExp) {
  return pattern.test(value) && !negativePattern.test(value);
}

export function requiredFundStructureFieldsForProfile(
  profile: Pick<FundProfile, "fundName" | "structure" | "facts">,
): FundStructureField[] {
  const verifiedDescription = profile.facts
    .filter((fact) =>
      fact.status === "verified"
      && (fact.category === "strategy" || fact.category === "fund_structure"))
    .map((fact) => `${fact.factKey} ${fact.value}`)
    .join(" ");
  const description = normalizedText(`${profile.fundName} ${verifiedDescription}`);
  const inverse = profile.structure.inverse === true || positiveFeatureMention(
    description,
    /\binverse\b|\bultrapro short\b|\bshort (?!term\b|duration\b|maturity\b)[a-z0-9]|\bbear\b|反向|做空/u,
    /\b(?:not|non)[ -]?inverse\b|非反向/u,
  );
  const leveraged = (
    profile.structure.leverageMultiplier !== null
    && Math.abs(profile.structure.leverageMultiplier) > 1
  ) || positiveFeatureMention(
    description,
    /\b(?:2x|3x|ultra|ultrapro|leveraged|double|triple)\b|杠杆|倍/u,
    /\b(?:not|non)[ -]?leveraged\b|非杠杆/u,
  );
  const coveredCall = profile.structure.coveredCall === true || positiveFeatureMention(
    description,
    /\bcovered[ -]?call\b|\bbuy[ -]?write\b|备兑/u,
    /\b(?:not|non)[ -]?covered[ -]?call\b|非备兑/u,
  );
  const required = new Set<FundStructureField>();
  if (inverse) {
    required.add("inverse");
    required.add("leverageMultiplier");
    required.add("dailyReset");
  }
  if (leveraged) {
    required.add("leverageMultiplier");
    required.add("dailyReset");
  }
  if (coveredCall) required.add("coveredCall");
  return fundStructureFields.filter((field) => required.has(field));
}

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

function validateEvidence(
  value: Pick<FundFact, "status" | "sourceType" | "sourceUrl" | "evidenceText" | "lastVerificationDate">,
) {
  const errors: string[] = [];
  if (!fundFactStatuses.includes(value.status)) errors.push("Status is invalid.");
  if (!fundFactSourceTypes.includes(value.sourceType)) errors.push("Source type is invalid.");
  if (!value.evidenceText.trim()) errors.push("Evidence text is required.");
  if (!isIsoDate(value.lastVerificationDate)) errors.push("Last verification date must use YYYY-MM-DD.");
  if (webSourceTypes.has(value.sourceType) && !hasSafeHttpsUrl(value.sourceUrl)) {
    errors.push("Web-sourced evidence requires a safe HTTPS source URL.");
  }
  if (value.sourceUrl && !hasSafeHttpsUrl(value.sourceUrl)) {
    errors.push("Source URL must be HTTPS and must not contain credentials.");
  }
  if (value.status === "verified" && value.sourceType === "model_memory") {
    errors.push("Model memory cannot be saved as verified evidence.");
  }
  return errors;
}

export function validateFundFact(fact: FundFact): FundProfileValidation {
  const errors: string[] = [];
  if (!fact.id.trim()) errors.push("Fact ID is required.");
  if (!fundFactCategories.includes(fact.category)) errors.push("Fact category is invalid.");
  if (!fact.factKey.trim()) errors.push("Fact key is required.");
  if (!fact.value.trim()) errors.push("Fact value is required.");
  if (fact.effectiveDate !== null && !isIsoDate(fact.effectiveDate)) errors.push("Effective date must use YYYY-MM-DD.");
  if (!Number.isFinite(Date.parse(fact.createdAt))) errors.push("Created timestamp is invalid.");
  if (!Number.isFinite(Date.parse(fact.updatedAt))) errors.push("Updated timestamp is invalid.");
  errors.push(...validateEvidence(fact));
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

export function validateFundHolding(holding: FundHolding): FundProfileValidation {
  const errors: string[] = [];
  if (!holding.id.trim()) errors.push("Holding ID is required.");
  if (!holding.constituentName.trim()) errors.push("Constituent name is required.");
  if (holding.constituentTicker && holding.constituentTicker !== holding.constituentTicker.toUpperCase()) {
    errors.push("Constituent ticker must be uppercase.");
  }
  if (holding.weightPercent !== null && (!Number.isFinite(holding.weightPercent) || holding.weightPercent < 0 || holding.weightPercent > 100)) {
    errors.push("Holding weight must be between 0 and 100.");
  }
  if (!isIsoDate(holding.effectiveDate)) errors.push("Holding effective date must use YYYY-MM-DD.");
  if (!Number.isFinite(Date.parse(holding.createdAt))) errors.push("Created timestamp is invalid.");
  if (!Number.isFinite(Date.parse(holding.updatedAt))) errors.push("Updated timestamp is invalid.");
  errors.push(...validateEvidence(holding));
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

function validateFundStructure(structure: FundStructure) {
  const errors: string[] = [];
  if (structure.leverageMultiplier !== null && (
    !Number.isFinite(structure.leverageMultiplier)
    || structure.leverageMultiplier < -5
    || structure.leverageMultiplier > 5
    || structure.leverageMultiplier === 0
  )) {
    errors.push("Leverage multiplier must be between -5 and 5 and cannot be zero.");
  }
  if (structure.inverse !== null && structure.leverageMultiplier !== null
    && structure.inverse !== (structure.leverageMultiplier < 0)) {
    errors.push("Inverse flag must agree with the leverage multiplier.");
  }
  for (const [key, value] of Object.entries(structure)) {
    if (key !== "leverageMultiplier" && value !== null && typeof value !== "boolean") errors.push(`${key} must be boolean or unknown.`);
  }
  return errors;
}

export function validateFundProfile(profile: FundProfile): FundProfileValidation {
  const errors: string[] = [];
  if (!profile.id.trim()) errors.push("Profile ID is required.");
  if (!profile.ticker.trim() || profile.ticker !== profile.ticker.toUpperCase()) errors.push("Ticker must be non-empty and uppercase.");
  if (!profile.fundName.trim()) errors.push("Fund name is required.");
  if (!fundSecurityTypes.includes(profile.securityType)) errors.push("Fund security type is invalid.");
  if (!Number.isFinite(Date.parse(profile.createdAt))) errors.push("Profile created timestamp is invalid.");
  if (!Number.isFinite(Date.parse(profile.updatedAt))) errors.push("Profile updated timestamp is invalid.");
  if (!Number.isFinite(Date.parse(profile.lastReviewedAt))) errors.push("Profile review timestamp is invalid.");
  errors.push(...validateFundStructure(profile.structure));
  const ids = new Set<string>();
  profile.facts.forEach((fact) => {
    if (ids.has(fact.id)) errors.push(`Duplicate evidence ID: ${fact.id}.`);
    ids.add(fact.id);
    validateFundFact(fact).errors.forEach((error) => errors.push(`${fact.id || "unknown fact"}: ${error}`));
  });
  profile.holdings.forEach((holding) => {
    if (ids.has(holding.id)) errors.push(`Duplicate evidence ID: ${holding.id}.`);
    ids.add(holding.id);
    validateFundHolding(holding).errors.forEach((error) => errors.push(`${holding.id || "unknown holding"}: ${error}`));
  });
  return { valid: errors.length === 0, errors };
}

function factSlot(fact: Pick<FundFact, "category" | "factKey" | "effectiveDate">) {
  return `${fact.category}:${normalizedText(fact.factKey)}:${fact.effectiveDate ?? "current"}`;
}

function factFingerprint(fact: FundFact) {
  return [factSlot(fact), normalizedText(fact.value), fact.status, fact.sourceType, fact.sourceUrl ?? "", normalizedText(fact.evidenceText)].join("|");
}

function holdingKey(holding: Pick<FundHolding, "constituentTicker" | "constituentName">) {
  return normalizedText(holding.constituentTicker || holding.constituentName);
}

function holdingSlot(holding: FundHolding) {
  return `${holdingKey(holding)}:${holding.effectiveDate}`;
}

function holdingFingerprint(holding: FundHolding) {
  return [
    holdingSlot(holding), holding.weightPercent ?? "", normalizedText(holding.country ?? ""),
    normalizedText(holding.sector ?? ""), normalizedText(holding.currency ?? ""), holding.status,
    holding.sourceType, holding.sourceUrl ?? "", normalizedText(holding.evidenceText),
  ].join("|");
}

export function findFundFactConflicts(facts: FundFact[]): FundFactConflict[] {
  const groups = new Map<string, FundFact[]>();
  facts.forEach((fact) => groups.set(factSlot(fact), [...(groups.get(factSlot(fact)) ?? []), fact]));
  const conflicts: FundFactConflict[] = [];
  groups.forEach((group) => {
    const values = [...new Set(group.map((fact) => normalizedText(fact.value)))];
    if (values.length < 2) return;
    conflicts.push({
      category: group[0].category,
      factKey: group[0].factKey,
      effectiveDate: group[0].effectiveDate,
      factIds: group.map((fact) => fact.id).sort(),
      values: group.map((fact) => fact.value).filter((value, index, all) => all.findIndex((item) => normalizedText(item) === normalizedText(value)) === index),
    });
  });
  return conflicts.sort((a, b) => `${a.category}:${a.factKey}:${a.effectiveDate}`.localeCompare(`${b.category}:${b.factKey}:${b.effectiveDate}`));
}

export function findFundHoldingConflicts(holdings: FundHolding[]): FundHoldingConflict[] {
  const groups = new Map<string, FundHolding[]>();
  holdings.forEach((holding) => groups.set(holdingSlot(holding), [...(groups.get(holdingSlot(holding)) ?? []), holding]));
  const conflicts: FundHoldingConflict[] = [];
  groups.forEach((group) => {
    const signatures = new Set(group.map((holding) => [
      holding.weightPercent ?? "", normalizedText(holding.country ?? ""), normalizedText(holding.sector ?? ""), normalizedText(holding.currency ?? ""),
    ].join("|")));
    if (signatures.size < 2) return;
    conflicts.push({
      constituentKey: holdingKey(group[0]),
      effectiveDate: group[0].effectiveDate,
      holdingIds: group.map((holding) => holding.id).sort(),
      weights: group.map((holding) => holding.weightPercent),
    });
  });
  return conflicts.sort((a, b) => `${a.constituentKey}:${a.effectiveDate}`.localeCompare(`${b.constituentKey}:${b.effectiveDate}`));
}

function mergeStructure(existing: FundStructure, incoming: FundStructure) {
  const merged = { ...existing };
  for (const field of fundStructureFields) {
    const oldValue = existing[field];
    const newValue = incoming[field];
    if (oldValue !== null && newValue !== null && oldValue !== newValue) {
      throw new Error(`Fund structure field ${field} cannot be silently changed; save the conflict as evidence.`);
    }
    if (oldValue === null && newValue !== null) {
      (merged[field] as FundStructure[typeof field]) = newValue;
    }
  }
  return merged;
}

export function mergeFundProfiles(existing: FundProfile | null, incoming: FundProfile): FundProfile {
  const validation = validateFundProfile(incoming);
  if (!validation.valid) throw new Error(`Invalid fund profile: ${validation.errors.join(" ")}`);
  if (!existing) return { ...incoming, facts: [...incoming.facts], holdings: [...incoming.holdings] };
  if (existing.ticker !== incoming.ticker) throw new Error("Cannot merge fund profiles with different tickers.");
  if (existing.securityType !== incoming.securityType) throw new Error("Fund security type cannot be silently changed.");
  if (existing.issuerName && incoming.issuerName && normalizedText(existing.issuerName) !== normalizedText(incoming.issuerName)) {
    throw new Error("Fund issuer cannot be silently changed; save the conflict as evidence.");
  }
  const structure = mergeStructure(existing.structure, incoming.structure);

  const facts = [...existing.facts];
  const factFingerprints = new Set(facts.map(factFingerprint));
  const factsById = new Map(facts.map((fact) => [fact.id, factFingerprint(fact)]));
  incoming.facts.forEach((fact) => {
    const fingerprint = factFingerprint(fact);
    if (factsById.has(fact.id) && factsById.get(fact.id) !== fingerprint) {
      throw new Error(`Fund fact ID ${fact.id} already belongs to different evidence.`);
    }
    if (!factFingerprints.has(fingerprint)) {
      facts.push(fact);
      factFingerprints.add(fingerprint);
      factsById.set(fact.id, fingerprint);
    }
  });

  const holdings = [...existing.holdings];
  const holdingFingerprints = new Set(holdings.map(holdingFingerprint));
  const holdingsById = new Map(holdings.map((holding) => [holding.id, holdingFingerprint(holding)]));
  incoming.holdings.forEach((holding) => {
    const fingerprint = holdingFingerprint(holding);
    if (holdingsById.has(holding.id) && holdingsById.get(holding.id) !== fingerprint) {
      throw new Error(`Fund holding ID ${holding.id} already belongs to different evidence.`);
    }
    if (!holdingFingerprints.has(fingerprint)) {
      holdings.push(holding);
      holdingFingerprints.add(fingerprint);
      holdingsById.set(holding.id, fingerprint);
    }
  });

  return {
    ...existing,
    fundName: incoming.fundName || existing.fundName,
    issuerName: incoming.issuerName || existing.issuerName,
    structure,
    facts,
    holdings,
    updatedAt: incoming.updatedAt,
    lastReviewedAt: incoming.lastReviewedAt,
  };
}

export function assessFundProfile(
  profile: FundProfile,
  options: {
    now?: Date;
    factStaleAfterDays?: number;
    holdingStaleAfterDays?: number;
    requiredCategories?: FundFactCategory[];
  } = {},
): FundProfileHealth {
  const now = options.now ?? new Date();
  const factCutoff = now.getTime() - Math.max(1, options.factStaleAfterDays ?? 365) * 86_400_000;
  const holdingCutoff = now.getTime() - Math.max(1, options.holdingStaleAfterDays ?? 30) * 86_400_000;
  const requiredCategories = options.requiredCategories ?? requiredFundProfileCategories;
  const verifiedFacts = profile.facts.filter((fact) => fact.status === "verified");
  const verifiedHoldings = profile.holdings.filter((holding) => holding.status === "verified");
  const missingCategories = requiredCategories.filter((category) => !verifiedFacts.some((fact) => fact.category === category));
  const missingExposure = verifiedHoldings.length === 0 && !verifiedFacts.some((fact) => exposureCategories.has(fact.category));
  const natureFacts = verifiedFacts.filter((fact) => fact.category === "strategy" || fact.category === "benchmark");
  const missingNature = natureFacts.length === 0 && verifiedHoldings.length < 3;
  const requiredStructureFields = requiredFundStructureFieldsForProfile(profile);
  const missingStructureFields = requiredStructureFields.filter((field) =>
    profile.structure[field] === null
    || !verifiedFacts.some((fact) => fact.category === "fund_structure" && fact.factKey === field));
  const staleFactIds = verifiedFacts.filter((fact) => Date.parse(`${fact.lastVerificationDate}T00:00:00Z`) < factCutoff).map((fact) => fact.id).sort();
  const staleHoldingIds = verifiedHoldings.filter((holding) =>
    Date.parse(`${holding.lastVerificationDate}T00:00:00Z`) < holdingCutoff
    || Date.parse(`${holding.effectiveDate}T00:00:00Z`) < holdingCutoff
  ).map((holding) => holding.id).sort();
  const factConflicts = findFundFactConflicts(profile.facts);
  const holdingConflicts = findFundHoldingConflicts(profile.holdings);
  const complete = missingCategories.length === 0 && !missingExposure && !missingNature && missingStructureFields.length === 0;
  const profileReviewIsStale = Date.parse(profile.lastReviewedAt) < factCutoff;
  const baselineFactsAreStale = requiredCategories.some((category) =>
    verifiedFacts.some((fact) => fact.category === category)
    && !verifiedFacts.some((fact) =>
      fact.category === category
      && Date.parse(`${fact.lastVerificationDate}T00:00:00Z`) >= factCutoff));
  const exposureIsStale = !missingExposure
    && !verifiedFacts.some((fact) =>
      exposureCategories.has(fact.category)
      && Date.parse(`${fact.lastVerificationDate}T00:00:00Z`) >= factCutoff)
    && !verifiedHoldings.some((holding) =>
      Date.parse(`${holding.lastVerificationDate}T00:00:00Z`) >= holdingCutoff
      && Date.parse(`${holding.effectiveDate}T00:00:00Z`) >= holdingCutoff);
  const requiredStructureIsStale = requiredStructureFields.some((field) =>
    !missingStructureFields.includes(field)
    && !verifiedFacts.some((fact) =>
      fact.category === "fund_structure"
      && fact.factKey === field
      && Date.parse(`${fact.lastVerificationDate}T00:00:00Z`) >= factCutoff));
  const natureIsStale = !missingNature
    && !natureFacts.some((fact) => Date.parse(`${fact.lastVerificationDate}T00:00:00Z`) >= factCutoff)
    && verifiedHoldings.filter((holding) =>
      Date.parse(`${holding.lastVerificationDate}T00:00:00Z`) >= holdingCutoff
      && Date.parse(`${holding.effectiveDate}T00:00:00Z`) >= holdingCutoff).length < 3;
  const stale = profileReviewIsStale || baselineFactsAreStale || exposureIsStale || natureIsStale || requiredStructureIsStale;
  const conflicted = factConflicts.length > 0 || holdingConflicts.length > 0;
  return {
    complete, stale, reusable: complete && !stale && !conflicted,
    missingCategories, missingExposure, missingNature, missingStructureFields,
    staleFactIds, staleHoldingIds, factConflicts, holdingConflicts,
  };
}

export function createFundProfileContext(
  ticker: string,
  fundName: string,
  profile: FundProfile | null,
  options: { now?: Date; technicalError?: string } = {},
): FundProfileContext {
  if (!profile) {
    return {
      ticker: ticker.toUpperCase(), fundName, availability: options.technicalError ? "error" : "missing",
      complete: false, stale: false, reusable: false,
      missingCategories: [...requiredFundProfileCategories], missingExposure: true,
      missingNature: true,
      missingStructureFields: requiredFundStructureFieldsForProfile({
        fundName,
        structure: {
          leverageMultiplier: null, inverse: null, dailyReset: null, coveredCall: null, activelyManaged: null,
        },
        facts: [],
      }),
      factConflicts: [], holdingConflicts: [],
      verifiedFactCount: 0, unverifiedFactCount: 0, verifiedHoldingCount: 0, unverifiedHoldingCount: 0,
      facts: [], holdings: [], technicalError: options.technicalError ?? null,
    };
  }
  const validation = validateFundProfile(profile);
  if (!validation.valid) throw new Error(validation.errors.join(" "));
  const health = assessFundProfile(profile, { now: options.now });
  const conflicted = health.factConflicts.length > 0 || health.holdingConflicts.length > 0;
  const availability: FundProfileAvailability = conflicted
    ? "conflicted"
    : health.stale
      ? "stale"
      : health.complete
        ? "ready"
        : "incomplete";
  return {
    ticker: profile.ticker, fundName: profile.fundName, availability,
    complete: health.complete, stale: health.stale, reusable: health.reusable,
    missingCategories: health.missingCategories, missingExposure: health.missingExposure,
    missingNature: health.missingNature,
    missingStructureFields: health.missingStructureFields,
    factConflicts: health.factConflicts, holdingConflicts: health.holdingConflicts,
    verifiedFactCount: profile.facts.filter((fact) => fact.status === "verified").length,
    unverifiedFactCount: profile.facts.filter((fact) => fact.status === "unverified").length,
    verifiedHoldingCount: profile.holdings.filter((holding) => holding.status === "verified").length,
    unverifiedHoldingCount: profile.holdings.filter((holding) => holding.status === "unverified").length,
    facts: [...profile.facts], holdings: [...profile.holdings], technicalError: null,
  };
}
