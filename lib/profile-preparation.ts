import type { AlphaVantageAttempt } from "./alpha-vantage.ts";

export type PreparatableSecurityType = "stock" | "adr" | "reit" | "etf" | "closed_end_fund";
export type ProfileKind = "company" | "fund";

export type ProfilePreparationHolding = {
  ticker: string;
  companyName: string;
  registeredName?: string;
  securityType?: PreparatableSecurityType;
};

export type ProfilePreparationResearchResult = {
  status: "reused" | "updated" | "no_sources" | "no_facts";
  pagesFetched: number;
  factsAdded: number;
  verifiedFactsAdded: number;
  holdingsAdded?: number;
  verifiedHoldingsAdded?: number;
  modelRetries?: number;
  coverageIssue?: { code: string; message: string } | null;
  provider?: "local_cache" | "alpha_vantage" | "controlled_web" | "alpha_vantage+controlled_web";
  structuredProviderIssue?: string | null;
  alphaAttempt?: AlphaVantageAttempt;
};

export type ProfilePreparationSummary = {
  running: boolean;
  total: number;
  completed: number;
  companies: number;
  funds: number;
  researched: number;
  reused: number;
  coverageIssues: number;
  failures: number;
};

export type ProfilePreparationOutcome = {
  holding: ProfilePreparationHolding;
  kind: ProfileKind;
  state: "reused" | "updated" | "coverage_issue" | "failed";
  result?: ProfilePreparationResearchResult;
  error?: string;
};

export function profileKindForSecurityType(securityType: ProfilePreparationHolding["securityType"]): ProfileKind {
  if (securityType === "stock" || securityType === "adr" || securityType === "reit") return "company";
  if (securityType === "etf" || securityType === "closed_end_fund") return "fund";
  throw new Error("Holding security type is not supported for profile preparation.");
}

export function initialProfilePreparationSummary(holdings: ProfilePreparationHolding[]): ProfilePreparationSummary {
  const kinds = holdings.map((holding) => profileKindForSecurityType(holding.securityType));
  return {
    running: holdings.length > 0,
    total: holdings.length,
    completed: 0,
    companies: kinds.filter((kind) => kind === "company").length,
    funds: kinds.filter((kind) => kind === "fund").length,
    researched: 0,
    reused: 0,
    coverageIssues: 0,
    failures: 0,
  };
}

export async function preparePortfolioProfileSet(options: {
  holdings: ProfilePreparationHolding[];
  lookup: (holding: ProfilePreparationHolding, kind: ProfileKind) => Promise<{ reusable: boolean }>;
  research: (holding: ProfilePreparationHolding, kind: ProfileKind) => Promise<ProfilePreparationResearchResult>;
  onItemStart?: (summary: ProfilePreparationSummary, holding: ProfilePreparationHolding, kind: ProfileKind) => void;
  onProgress?: (summary: ProfilePreparationSummary, outcome: ProfilePreparationOutcome) => void;
  shouldContinue?: () => boolean;
}) {
  let summary = initialProfilePreparationSummary(options.holdings);
  for (const holding of options.holdings) {
    if (options.shouldContinue && !options.shouldContinue()) return { ...summary, running: false };
    const kind = profileKindForSecurityType(holding.securityType);
    options.onItemStart?.(summary, holding, kind);
    let outcome: ProfilePreparationOutcome;
    try {
      const lookup = await options.lookup(holding, kind);
      if (lookup.reusable) {
        summary = { ...summary, reused: summary.reused + 1 };
        outcome = { holding, kind, state: "reused" };
      } else {
        const result = await options.research(holding, kind);
        if (result.status === "reused") {
          summary = { ...summary, reused: summary.reused + 1 };
          outcome = { holding, kind, state: "reused", result };
        } else if (result.status === "updated") {
          summary = { ...summary, researched: summary.researched + 1 };
          outcome = { holding, kind, state: "updated", result };
        } else {
          summary = { ...summary, coverageIssues: summary.coverageIssues + 1 };
          outcome = { holding, kind, state: "coverage_issue", result };
        }
      }
    } catch (error) {
      summary = { ...summary, failures: summary.failures + 1 };
      outcome = {
        holding,
        kind,
        state: "failed",
        error: error instanceof Error ? error.message : "Profile preparation failed.",
      };
    }
    summary = {
      ...summary,
      completed: summary.completed + 1,
      running: summary.completed + 1 < summary.total,
    };
    options.onProgress?.(summary, outcome);
  }
  return summary;
}
