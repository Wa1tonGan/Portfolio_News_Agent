export const financialLabels = ["positive", "negative", "mixed", "neutral", "uncertain"] as const;
export const directnessValues = ["direct", "indirect"] as const;
export const timeHorizonValues = ["immediate", "short_term", "long_term"] as const;
export const impactStrengthValues = ["low", "medium", "high"] as const;
export const reviewerVerdicts = ["approved", "downgraded", "rejected"] as const;
export const macroScopeValues = ["none", "global", "country", "sector", "holding"] as const;
export const macroEvidenceBasisValues = ["economy_wide", "profile_exposure", "fund_holding", "direct_event"] as const;

export type FinancialLabel = typeof financialLabels[number];
export type Directness = typeof directnessValues[number];
export type TimeHorizon = typeof timeHorizonValues[number];
export type ImpactStrength = typeof impactStrengthValues[number];
export type ReviewerVerdict = typeof reviewerVerdicts[number];
export type MacroScope = typeof macroScopeValues[number];
export type MacroEvidenceBasis = typeof macroEvidenceBasisValues[number];
export type EvidenceLevel = "flash_text" | "headline_only" | "full_article";
export type ImpactProcessingStatus = "completed" | "impact_failed" | "review_failed" | "evidence_fetch_failed";
export type PipelineStatus = "completed" | "partial" | "failed";

export type StageError = {
  stage: "profile" | "retrieval" | "freshness" | "evidence" | "impact" | "review" | "audit" | "reopen";
  message: string;
  retryable: boolean;
  pairKeys?: string[];
};

export type RelevanceConnection = {
  ticker: string;
  score: number;
  linkType: Directness;
  causalPath: string;
  basis?: "model" | "code_hint";
  macroBasis?: MacroEvidenceBasis;
};

export type BranchDecision = {
  newsId: string;
  rationale: string;
  factors: string[];
  connections: RelevanceConnection[];
  macroScope?: MacroScope;
  affectedMarkets?: string[];
  economyImpact?: string;
};

export type RelevanceOutput = { items: BranchDecision[] };

export type ImpactItem = {
  newsId: string;
  ticker: string;
  overallLabel: FinancialLabel;
  strength: ImpactStrength;
  timeHorizon: TimeHorizon;
  confidence: number;
  directness: Directness;
  businessImpact: string;
  possibleMarketChannel: string;
  causalPath: string[];
  evidence: string;
  limitations: string[];
};

export type ImpactOutput = { items: ImpactItem[] };

export type ReviewItem = {
  newsId: string;
  ticker: string;
  verdict: ReviewerVerdict;
  finalLabel: FinancialLabel;
  finalConfidence: number;
  finalSummary: string;
  issues: string[];
};

export type RejectionAuditDecision = {
  newsId: string;
  verdict: "upheld" | "reopen";
  reason: string;
  connections: RelevanceConnection[];
};

export type ReviewOutput = { reviews: ReviewItem[]; rejectionAudits: RejectionAuditDecision[] };

export type CandidatePair = {
  newsId: string;
  ticker: string;
  relevanceScore: number;
  portfolioWeight: number;
  directness: Directness;
  causalHypothesis: string;
  title: string;
  summary: string;
  microReason: string;
  macroReason: string;
};

export type CandidateCoverageStatus = "selected" | "below_threshold" | "deferred_capacity" | "deferred_ticker_limit";
export type CandidateCoverage = { newsId: string; ticker: string; relevanceScore: number; status: CandidateCoverageStatus; reason: string };

export type FinalImpactResult = {
  newsId: string;
  ticker: string;
  status: ImpactProcessingStatus;
  finalLabel: FinancialLabel | null;
  finalConfidence: number | null;
  finalSummary: string | null;
  directness: Directness;
  timeHorizon: TimeHorizon | null;
  evidenceLevel: EvidenceLevel;
  reviewerVerdict: ReviewerVerdict | null;
  reviewerIssues: string[];
  businessImpact: string | null;
  possibleMarketChannel: string | null;
  causalPath: string[];
  evidence: string | null;
  limitations: string[];
  technicalError?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isEnum<T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === "string" && allowed.includes(value);
}

function isScore(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;
}

export function pairKey(value: { newsId: string; ticker: string }) {
  return `${value.newsId}:${value.ticker.toUpperCase()}`;
}

export function isValidMacroCausalPath(value: string) {
  const steps = value.split(/\s*(?:→|->|=>)\s*/).map((step) => step.trim()).filter(Boolean);
  return steps.length >= 4 && steps.every((step) => step.length >= 2);
}

export function capMacroRelevanceScore(score: number, basis: MacroEvidenceBasis) {
  const cap = basis === "economy_wide" ? 55 : basis === "profile_exposure" ? 75 : basis === "fund_holding" ? 85 : 100;
  return Math.max(0, Math.min(cap, Math.round(score)));
}

export function isImpactItem(value: unknown): value is ImpactItem {
  if (!isObject(value)) return false;
  return typeof value.newsId === "string" && typeof value.ticker === "string" &&
    isEnum(value.overallLabel, financialLabels) && isEnum(value.strength, impactStrengthValues) &&
    isEnum(value.timeHorizon, timeHorizonValues) && isScore(value.confidence) &&
    isEnum(value.directness, directnessValues) && typeof value.businessImpact === "string" &&
    typeof value.possibleMarketChannel === "string" && isStringArray(value.causalPath) &&
    typeof value.evidence === "string" && isStringArray(value.limitations);
}

function matchesExactKeys(actualKeys: string[], expectedKeys: Set<string>) {
  const normalized = actualKeys.map((key) => key.toUpperCase());
  const normalizedExpected = new Set([...expectedKeys].map((key) => key.toUpperCase()));
  return normalized.length === normalizedExpected.size && new Set(normalized).size === normalized.length &&
    normalized.every((key) => normalizedExpected.has(key));
}

export function isExactImpactOutput(value: unknown, expectedKeys: Set<string>, validTickers: Set<string>): value is ImpactOutput {
  if (!isObject(value) || !Array.isArray(value.items) || !value.items.every(isImpactItem)) return false;
  if (value.items.some((item) => !validTickers.has(item.ticker.toUpperCase()))) return false;
  return matchesExactKeys(value.items.map(pairKey), expectedKeys);
}

function isReviewItem(value: unknown): value is ReviewItem {
  if (!isObject(value)) return false;
  return typeof value.newsId === "string" && typeof value.ticker === "string" &&
    isEnum(value.verdict, reviewerVerdicts) && isEnum(value.finalLabel, financialLabels) &&
    isScore(value.finalConfidence) && typeof value.finalSummary === "string" && isStringArray(value.issues);
}

function isRelevanceConnection(value: unknown, validTickers?: Set<string>): value is RelevanceConnection {
  if (!isObject(value) || typeof value.ticker !== "string" || !isScore(value.score) ||
    !isEnum(value.linkType, directnessValues) || typeof value.causalPath !== "string") return false;
  return !validTickers || validTickers.has(value.ticker.toUpperCase());
}

function isAuditDecision(value: unknown, validTickers: Set<string>): value is RejectionAuditDecision {
  if (!isObject(value) || typeof value.newsId !== "string" ||
    (value.verdict !== "upheld" && value.verdict !== "reopen") || typeof value.reason !== "string" ||
    !Array.isArray(value.connections) || !value.connections.every((item) => isRelevanceConnection(item, validTickers))) return false;
  return value.verdict === "upheld" || value.connections.some((connection) => connection.score >= 30);
}

export function isExactReviewOutput(
  value: unknown,
  expectedReviewKeys: Set<string>,
  expectedAuditIds: Set<string>,
  validTickers: Set<string>,
): value is ReviewOutput {
  if (!isObject(value) || !Array.isArray(value.reviews) || !Array.isArray(value.rejectionAudits) ||
    !value.reviews.every(isReviewItem) || !value.rejectionAudits.every((item) => isAuditDecision(item, validTickers))) return false;
  if (value.reviews.some((item) => !validTickers.has(item.ticker.toUpperCase()))) return false;
  const reviewKeysMatch = matchesExactKeys(value.reviews.map(pairKey), expectedReviewKeys);
  const auditIds = value.rejectionAudits.map((item) => item.newsId);
  const auditsMatch = auditIds.length === expectedAuditIds.size && new Set(auditIds).size === auditIds.length &&
    auditIds.every((id) => expectedAuditIds.has(id));
  return reviewKeysMatch && auditsMatch;
}

function candidateOrder(a: CandidatePair, b: CandidatePair) {
  return b.relevanceScore - a.relevanceScore || b.portfolioWeight - a.portfolioWeight || pairKey(a).localeCompare(pairKey(b));
}

export function selectFairCandidates(
  candidates: CandidatePair[],
  options: { maxCandidatePairs?: number; maxPairsPerTicker?: number; minimumScore?: number; strongScore?: number } = {},
) {
  const maxCandidatePairs = Math.max(1, options.maxCandidatePairs ?? 10);
  const maxPairsPerTicker = Math.max(1, options.maxPairsPerTicker ?? 2);
  const minimumScore = options.minimumScore ?? 30;
  const strongScore = options.strongScore ?? 65;
  const unique = new Map<string, CandidatePair>();
  for (const candidate of candidates) {
    const normalized = { ...candidate, ticker: candidate.ticker.toUpperCase() };
    const key = pairKey(normalized);
    const existing = unique.get(key);
    if (!existing || candidateOrder(normalized, existing) < 0) unique.set(key, normalized);
  }
  const ordered = [...unique.values()].sort(candidateOrder);
  const eligible = ordered.filter((item) => item.relevanceScore >= minimumScore);
  const byTicker = new Map<string, CandidatePair[]>();
  for (const candidate of eligible) {
    const group = byTicker.get(candidate.ticker) ?? [];
    group.push(candidate);
    byTicker.set(candidate.ticker, group);
  }

  const selected = new Map<string, CandidatePair>();
  const tickerCounts = new Map<string, number>();
  const leaders = [...byTicker.values()].map((group) => group[0]).filter((item) => item.relevanceScore >= strongScore).sort(candidateOrder);
  const add = (candidate: CandidatePair) => {
    if (selected.has(pairKey(candidate))) return;
    if (selected.size >= maxCandidatePairs || (tickerCounts.get(candidate.ticker) ?? 0) >= maxPairsPerTicker) return;
    selected.set(pairKey(candidate), candidate);
    tickerCounts.set(candidate.ticker, (tickerCounts.get(candidate.ticker) ?? 0) + 1);
  };
  leaders.forEach(add);
  eligible.forEach(add);

  const coverage: CandidateCoverage[] = ordered.map((candidate) => {
    const key = pairKey(candidate);
    if (selected.has(key)) return { newsId: candidate.newsId, ticker: candidate.ticker, relevanceScore: candidate.relevanceScore, status: "selected", reason: "已选入影响分析。" };
    if (candidate.relevanceScore < minimumScore) return { newsId: candidate.newsId, ticker: candidate.ticker, relevanceScore: candidate.relevanceScore, status: "below_threshold", reason: `关联评分低于 ${minimumScore}。` };
    if ((tickerCounts.get(candidate.ticker) ?? 0) >= maxPairsPerTicker) return { newsId: candidate.newsId, ticker: candidate.ticker, relevanceScore: candidate.relevanceScore, status: "deferred_ticker_limit", reason: `该股票已选满 ${maxPairsPerTicker} 个组合，因此延后处理。` };
    return { newsId: candidate.newsId, ticker: candidate.ticker, relevanceScore: candidate.relevanceScore, status: "deferred_capacity", reason: `处理容量已满 ${maxCandidatePairs} 个组合，因此延后处理。` };
  });

  return { selected: [...selected.values()].sort(candidateOrder), coverage };
}

export function chunkItems<T>(items: T[], size: number) {
  const safeSize = Math.max(1, Math.floor(size));
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += safeSize) chunks.push(items.slice(index, index + safeSize));
  return chunks;
}

export function capConfidence(value: number, evidenceLevel: EvidenceLevel) {
  const cap = evidenceLevel === "headline_only" ? 55 : evidenceLevel === "flash_text" ? 65 : 85;
  return Math.max(0, Math.min(cap, Math.round(value)));
}

export function createTechnicalResult(
  pair: CandidatePair,
  status: Exclude<ImpactProcessingStatus, "completed">,
  evidenceLevel: EvidenceLevel,
  message: string,
): FinalImpactResult {
  return {
    newsId: pair.newsId, ticker: pair.ticker, status, finalLabel: null, finalConfidence: null, finalSummary: null,
    directness: pair.directness, timeHorizon: null, evidenceLevel, reviewerVerdict: null, reviewerIssues: [],
    businessImpact: null, possibleMarketChannel: null, causalPath: [], evidence: null, limitations: [], technicalError: message,
  };
}
