import assert from "node:assert/strict";
import test from "node:test";
import {
  initialProfilePreparationSummary,
  preparePortfolioProfileSet,
  profileKindForSecurityType,
  type ProfilePreparationHolding,
} from "../lib/profile-preparation.ts";

const holdings: ProfilePreparationHolding[] = [
  { ticker: "AAPL", companyName: "Apple", securityType: "stock" },
  { ticker: "VOO", companyName: "Vanguard S&P 500 ETF", securityType: "etf" },
  { ticker: "BABA", companyName: "Alibaba ADR", securityType: "adr" },
  { ticker: "CEF", companyName: "Example Closed End Fund", securityType: "closed_end_fund" },
];

test("profile preparation classifies companies and funds deterministically", () => {
  assert.equal(profileKindForSecurityType("stock"), "company");
  assert.equal(profileKindForSecurityType("reit"), "company");
  assert.equal(profileKindForSecurityType("etf"), "fund");
  assert.equal(profileKindForSecurityType("closed_end_fund"), "fund");
  assert.throws(() => profileKindForSecurityType(undefined), /not supported/);
  assert.deepEqual(initialProfilePreparationSummary(holdings), {
    running: true, total: 4, completed: 0, companies: 2, funds: 2,
    researched: 0, reused: 0, coverageIssues: 0, failures: 0,
  });
});

test("mixed portfolios prepare sequentially, reuse current profiles, and continue after failures", async () => {
  const calls: string[] = [];
  const outcomes: string[] = [];
  const starts: string[] = [];
  const summary = await preparePortfolioProfileSet({
    holdings,
    lookup: async (holding, kind) => {
      calls.push(`lookup:${holding.ticker}:${kind}`);
      return { reusable: holding.ticker === "AAPL" };
    },
    research: async (holding, kind) => {
      calls.push(`research:${holding.ticker}:${kind}`);
      if (holding.ticker === "BABA") throw new Error("database unavailable");
      if (holding.ticker === "CEF") {
        return {
          status: "no_sources", pagesFetched: 0, factsAdded: 0, verifiedFactsAdded: 0,
          coverageIssue: { code: "no_search_results", message: "No reliable fund source." },
        };
      }
      return {
        status: "updated", pagesFetched: 2, factsAdded: 3, verifiedFactsAdded: 2,
        holdingsAdded: 10, verifiedHoldingsAdded: 10,
      };
    },
    onItemStart: (progress, holding, kind) => starts.push(`${progress.completed}:${holding.ticker}:${kind}`),
    onProgress: (progress, outcome) => outcomes.push(`${progress.completed}:${outcome.holding.ticker}:${outcome.state}`),
  });
  assert.deepEqual(calls, [
    "lookup:AAPL:company",
    "lookup:VOO:fund", "research:VOO:fund",
    "lookup:BABA:company", "research:BABA:company",
    "lookup:CEF:fund", "research:CEF:fund",
  ]);
  assert.deepEqual(outcomes, [
    "1:AAPL:reused", "2:VOO:updated", "3:BABA:failed", "4:CEF:coverage_issue",
  ]);
  assert.deepEqual(starts, [
    "0:AAPL:company", "1:VOO:fund", "2:BABA:company", "3:CEF:fund",
  ]);
  assert.deepEqual(summary, {
    running: false, total: 4, completed: 4, companies: 2, funds: 2,
    researched: 1, reused: 1, coverageIssues: 1, failures: 1,
  });
});

test("a superseded preparation run stops before the next holding", async () => {
  let active = true;
  const calls: string[] = [];
  const summary = await preparePortfolioProfileSet({
    holdings,
    shouldContinue: () => active,
    lookup: async (holding) => {
      calls.push(holding.ticker);
      active = false;
      return { reusable: true };
    },
    research: async () => {
      throw new Error("research should not run");
    },
  });
  assert.deepEqual(calls, ["AAPL"]);
  assert.equal(summary.completed, 1);
  assert.equal(summary.running, false);
});
