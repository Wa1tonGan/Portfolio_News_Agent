import assert from "node:assert/strict";
import test from "node:test";
import {
  capMacroRelevanceScore, createTechnicalResult, isExactImpactOutput, isExactReviewOutput,
  isValidMacroCausalPath, pairKey, selectFairCandidates, type CandidatePair,
} from "../lib/analysis-contracts.ts";
import {
  ANALYSIS_GRAPH_NODES,
  createAnalysisWorkflowGraph,
  runAnalysisPipeline,
} from "../lib/analysis-pipeline-next.ts";
import type { CompanyProfile } from "../lib/company-profile-contracts.ts";
import type { FundProfile } from "../lib/fund-profile-contracts.ts";

const validTickers = new Set(["AAPL", "XOM", "JPM"]);
const impact = (newsId: string, ticker: string) => ({
  newsId, ticker, overallLabel: "positive", strength: "medium", timeHorizon: "short_term", confidence: 70,
  directness: "direct", businessImpact: "Supported effect.", possibleMarketChannel: "Possible repricing channel.",
  causalPath: ["event", "company effect"], evidence: "Supplied evidence.", limitations: ["May change"],
});
const review = (newsId: string, ticker: string) => ({
  newsId, ticker, verdict: "approved", finalLabel: "positive", finalConfidence: 65,
  finalSummary: "Supported after review.", issues: [],
});

test("Impact validation rejects missing, duplicate, and unknown pairs", () => {
  const expected = new Set(["N1:AAPL", "N2:XOM"]);
  assert.equal(isExactImpactOutput({ items: [impact("N1", "AAPL")] }, expected, validTickers), false);
  assert.equal(isExactImpactOutput({ items: [impact("N1", "AAPL"), impact("N1", "AAPL")] }, expected, validTickers), false);
  assert.equal(isExactImpactOutput({ items: [impact("N1", "AAPL"), impact("N2", "MSFT")] }, expected, validTickers), false);
  assert.equal(isExactImpactOutput({ items: [impact("N1", "AAPL"), impact("N2", "XOM")] }, expected, validTickers), true);
  assert.equal(isExactImpactOutput({ items: [impact("N1", "AAPL"), { ...impact("N2", "XOM"), confidence: 0.95 }] }, expected, validTickers), false);
});

test("Reviewer validation requires every expected pair and audit exactly once", () => {
  const expectedReviews = new Set(["N1:AAPL", "N2:XOM"]);
  const expectedAudits = new Set(["N3"]);
  const audit = { newsId: "N3", verdict: "upheld", reason: "No credible path.", connections: [] };
  assert.equal(isExactReviewOutput({ reviews: [review("N1", "AAPL")], rejectionAudits: [audit] }, expectedReviews, expectedAudits, validTickers), false);
  assert.equal(isExactReviewOutput({ reviews: [review("N1", "AAPL"), review("N1", "AAPL")], rejectionAudits: [audit] }, expectedReviews, expectedAudits, validTickers), false);
  assert.equal(isExactReviewOutput({ reviews: [review("N1", "AAPL"), review("N2", "XOM")], rejectionAudits: [audit] }, expectedReviews, expectedAudits, validTickers), true);
  assert.equal(isExactReviewOutput({ reviews: [review("N1", "AAPL"), { ...review("N2", "XOM"), finalConfidence: 0.65 }], rejectionAudits: [audit] }, expectedReviews, expectedAudits, validTickers), false);
});

function candidate(newsId: string, ticker: string, relevanceScore: number, portfolioWeight = 1): CandidatePair {
  return { newsId, ticker, relevanceScore, portfolioWeight, directness: "direct", causalHypothesis: "Supported path", title: newsId, summary: newsId, microReason: "", macroReason: "" };
}

test("Fair selection supports more than three pairs and prevents one ticker monopolizing capacity", () => {
  const input = [
    candidate("N1", "AAPL", 95, 60), candidate("N2", "AAPL", 94, 60), candidate("N3", "AAPL", 93, 60),
    candidate("N4", "XOM", 80, 2), candidate("N5", "JPM", 75, 1), candidate("N6", "JPM", 70, 1),
  ];
  const result = selectFairCandidates(input, { maxCandidatePairs: 5, maxPairsPerTicker: 2 });
  assert.equal(result.selected.length, 5);
  assert.deepEqual(new Set(result.selected.map((item) => item.ticker)), new Set(["AAPL", "XOM", "JPM"]));
  assert.equal(result.selected.filter((item) => item.ticker === "AAPL").length, 2);
  assert.equal(result.coverage.find((item) => pairKey(item) === "N3:AAPL")?.status, "deferred_ticker_limit");
});

test("Article and Reviewer failures are technical results with no financial label", () => {
  const pair = candidate("N1", "AAPL", 80);
  const articleFailure = createTechnicalResult(pair, "evidence_fetch_failed", "headline_only", "detail service unavailable");
  const reviewFailure = createTechnicalResult(pair, "review_failed", "full_article", "review model failed");
  assert.equal(articleFailure.finalLabel, null);
  assert.equal(articleFailure.status, "evidence_fetch_failed");
  assert.equal(reviewFailure.finalLabel, null);
  assert.equal(reviewFailure.status, "review_failed");
});

test("Macro causal paths require a complete transmission chain and broad scores remain capped", () => {
  assert.equal(isValidMacroCausalPath("战争升级 → 原油供应收紧 → 通胀和企业成本上升 → 持仓盈利承压"), true);
  assert.equal(isValidMacroCausalPath("战争升级 → 股票下跌"), false);
  assert.equal(capMacroRelevanceScore(90, "economy_wide"), 55);
  assert.equal(capMacroRelevanceScore(90, "profile_exposure"), 75);
  assert.equal(capMacroRelevanceScore(90, "fund_holding"), 85);
  assert.equal(capMacroRelevanceScore(90, "direct_event"), 90);
});

test("A reopen audit requires a valid connection and can enter fair processing", () => {
  const expectedAudits = new Set(["N9"]);
  const reopened = { newsId: "N9", verdict: "reopen", reason: "Possible missed exposure", connections: [{ ticker: "AAPL", score: 70, linkType: "direct", causalPath: "Event names the company" }] };
  assert.equal(isExactReviewOutput({ reviews: [], rejectionAudits: [{ ...reopened, connections: [] }] }, new Set(), expectedAudits, validTickers), false);
  assert.equal(isExactReviewOutput({ reviews: [], rejectionAudits: [reopened] }, new Set(), expectedAudits, validTickers), true);
  const selection = selectFairCandidates([candidate("N9", "AAPL", 70)], { maxCandidatePairs: 3, maxPairsPerTicker: 1 });
  assert.equal(selection.selected.length, 1);
  assert.equal(selection.coverage[0].status, "selected");
});

function toolResult(items: Record<string, unknown>[]) {
  return { isError: false, structuredContent: { data: { items } } };
}

class FakeJin10 {
  private readonly article: boolean;
  private readonly failDetail: boolean;
  private readonly flashTitle: string;
  constructor(article: boolean, failDetail = false, flashTitle = "Apple announces an operating update") {
    this.article = article;
    this.failDetail = failDetail;
    this.flashTitle = flashTitle;
  }
  async connect() { return {}; }
  async listFlash() { return toolResult(this.article ? [] : [{ id: "123", title: this.flashTitle, content: this.flashTitle, time: "2026-01-01T10:00:00Z" }]); }
  async listNews() { return toolResult(this.article ? [{ id: "123", title: "Apple announces an operating update", introduction: "Apple announces an operating update", time: "2026-01-01T10:00:00Z" }] : []); }
  async searchFlash() { return toolResult([]); }
  async searchNews() { return toolResult([]); }
  async listCalendar(): Promise<{
    isError: boolean;
    structuredContent: { data: Record<string, unknown>[] };
  }> {
    return { isError: false, structuredContent: { data: [] } };
  }
  async getNews() {
    if (this.failDetail) throw new Error("detail service unavailable");
    return { isError: false, structuredContent: { data: { id: "123", title: "Apple update", content: "Full evidence" } } };
  }
}

class CalendarJin10 extends FakeJin10 {
  constructor() { super(false); }
  async listFlash() { return toolResult([]); }
  async listCalendar() {
    return {
      isError: false,
      structuredContent: {
        data: [
          {
            pub_time: "2026-01-01 10:00",
            title: "美国至 12 月 31 日当周石油钻井总数 (口)",
            previous: "410",
            consensus: "411",
            actual: "412",
            affect_txt: "已公布",
          },
          {
            pub_time: "2026-01-01 10:00",
            title: "美国至 12 月 31 日当周总钻井总数 (口)",
            previous: "540",
            consensus: "541",
            actual: "542",
            affect_txt: "已公布",
          },
        ],
      },
    };
  }
}

class FakeOllama {
  model = "test-model";
  calls: Array<{ system: string; prompt: string }> = [];
  private readonly mode: "normal" | "review_fail" | "reopen";
  constructor(mode: "normal" | "review_fail" | "reopen" = "normal") { this.mode = mode; }
  async chatStructured(options: { system: string; prompt: string }) {
    this.calls.push(options);
    const id = this.mode === "reopen" ? "flash:123" : "news:123";
    const modelNewsId = options.prompt.match(/"id":"(N\d+_\d+)"/)?.[1] ?? id;
    const pipelineNewsId = options.prompt.match(/"newsId":"((?:flash|news|calendar):[^"]+)"/)?.[1] ?? id;
    if (options.system.includes("MICRO agent")) return { result: { items: [{ newsId: modelNewsId, rationale: "Checked", factors: [], connections: this.mode === "reopen" ? [] : [{ ticker: "AAPL", score: 80, linkType: "direct", causalPath: "Named company event" }] }] } };
    if (options.system.includes("MACRO agent")) {
      return {
        result: {
          items: [{
            newsId: modelNewsId,
            rationale: "No supported macro event.",
            factors: [],
            macroScope: "none",
            affectedMarkets: [],
            economyImpact: "",
            connections: [],
          }],
        },
      };
    }
    if (options.system.startsWith("You audit")) return { result: { reviews: [], rejectionAudits: [{ newsId: id, verdict: "reopen", reason: "Possible missed event", connections: [{ ticker: "AAPL", score: 70, linkType: "direct", causalPath: "Reviewer found a company connection" }] }] } };
    if (options.system.includes("Impact Analyst")) return { result: { items: [impact(pipelineNewsId, "AAPL")] } };
    if (options.system.includes("Report Reviewer")) {
      if (this.mode === "review_fail") throw new Error("review model failed");
      return { result: { reviews: [review(pipelineNewsId, "AAPL")], rejectionAudits: [] } };
    }
    throw new Error("Unexpected agent call");
  }
}

class AliasEchoOllama {
  model = "test-model";
  calls: Array<{ system: string; prompt: string }> = [];
  async chatStructured(options: { system: string; prompt: string }) {
    this.calls.push(options);
    if (options.system.includes("MICRO agent") || options.system.includes("MACRO agent")) {
      const ids = [...options.prompt.matchAll(/"id":"(N\d+_\d+)"/g)].map((match) => match[1]);
      const isMacro = options.system.includes("MACRO agent");
      return {
        result: {
          items: ids.map((newsId) => ({
            newsId,
            rationale: isMacro ? "No supported macro event." : "Checked",
            factors: [],
            ...(isMacro
              ? {
                  macroScope: "none",
                  affectedMarkets: [],
                  economyImpact: "",
                }
              : {}),
            connections: [],
          })),
        },
      };
    }
    if (options.system.startsWith("You audit")) {
      const ids = [...options.prompt.matchAll(/"id":"(calendar:[^"]+)"/g)].map((match) => match[1]);
      return {
        result: {
          reviews: [],
          rejectionAudits: [...new Set(ids)].map((newsId) => ({
            newsId, verdict: "upheld", reason: "No supported portfolio connection.", connections: [],
          })),
        },
      };
    }
    if (options.system.includes("Impact Analyst")) return { result: { items: [] } };
    if (options.system.includes("Report Reviewer")) return { result: { reviews: [], rejectionAudits: [] } };
    throw new Error("Unexpected agent call");
  }
}

class SystemicMacroOllama {
  model = "test-model";
  async chatStructured(options: { system: string; prompt: string }) {
    const modelNewsId = options.prompt.match(/"id":"(N\d+_\d+)"/)?.[1] ?? "flash:123";
    if (options.system.includes("MICRO agent")) {
      return { result: { items: [{ newsId: modelNewsId, rationale: "No direct company event.", factors: [], connections: [] }] } };
    }
    if (options.system.includes("MACRO agent")) {
      return {
        result: {
          items: [{
            newsId: modelNewsId,
            rationale: "The geopolitical shock can affect the national economy through energy and inflation.",
            factors: ["geopolitics", "oil", "inflation"],
            macroScope: "country",
            affectedMarkets: ["United States"],
            economyImpact: "Higher energy costs can raise inflation and weaken economy-wide demand and corporate margins.",
            connections: [{
              ticker: "AAPL",
              score: 90,
              linkType: "indirect",
              macroBasis: "economy_wide",
              causalPath: "地缘冲突升级 → 原油价格上涨 → 美国通胀和企业成本上升 → AAPL 需求与利润率可能承压",
            }],
          }],
        },
      };
    }
    if (options.system.includes("Impact Analyst")) return { result: { items: [impact("flash:123", "AAPL")] } };
    if (options.system.includes("Report Reviewer")) return { result: { reviews: [review("flash:123", "AAPL")], rejectionAudits: [] } };
    if (options.system.startsWith("You audit")) return { result: { reviews: [], rejectionAudits: [] } };
    throw new Error("Unexpected agent call");
  }
}

class MultiConnectionMacroOllama {
  model = "test-model";
  calls: Array<{ system: string; prompt: string; schema?: Record<string, unknown> }> = [];

  async chatStructured(options: { system: string; prompt: string; schema?: Record<string, unknown> }) {
    this.calls.push(options);
    const modelNewsId = options.prompt.match(/"id":"(N\d+_\d+)"/)?.[1] ?? "flash:123";
    if (options.system.includes("MICRO agent")) {
      return {
        result: {
          items: [{
            newsId: modelNewsId,
            rationale: "没有直接公司事件。",
            factors: [],
            connections: [],
          }],
        },
      };
    }
    if (options.system.includes("MACRO agent")) {
      return {
        result: {
          items: [{
            newsId: modelNewsId,
            rationale: "同一宏观事件可通过不同路径影响多个持仓。",
            factors: ["能源", "通胀"],
            macroScope: "country",
            affectedMarkets: ["美国"],
            economyImpact: "能源成本变化可能同时影响生产商收入和消费企业成本。",
            connections: [
              {
                ticker: "AAPL",
                score: 55,
                linkType: "indirect",
                macroBasis: "economy_wide",
                causalPath: "地缘冲突升级 → 能源价格上涨 → 企业投入成本上升 → AAPL 利润率可能承压",
              },
              {
                ticker: "XOM",
                score: 55,
                linkType: "indirect",
                macroBasis: "economy_wide",
                causalPath: "地缘冲突升级 → 原油价格上涨 → 能源生产收入改善 → XOM 上游业务可能受益",
              },
            ],
          }],
        },
      };
    }
    if (options.system.includes("Impact Analyst")) {
      return {
        result: {
          items: [
            { ...impact("flash:123", "AAPL"), overallLabel: "negative" },
            impact("flash:123", "XOM"),
          ],
        },
      };
    }
    if (options.system.includes("Report Reviewer")) {
      return {
        result: {
          reviews: [
            { ...review("flash:123", "AAPL"), finalLabel: "negative" },
            review("flash:123", "XOM"),
          ],
          rejectionAudits: [],
        },
      };
    }
    if (options.system.startsWith("You audit")) {
      return { result: { reviews: [], rejectionAudits: [] } };
    }
    throw new Error("Unexpected agent call");
  }
}

class UnsafeMacroConnectionOllama {
  model = "test-model";
  async chatStructured(options: { system: string; prompt: string }) {
    const modelNewsId = options.prompt.match(/"id":"(N\d+_\d+)"/)?.[1] ?? "flash:123";
    if (options.system.includes("MICRO agent")) {
      return { result: { items: [{ newsId: modelNewsId, rationale: "No direct company event.", factors: [], connections: [] }] } };
    }
    if (options.system.includes("MACRO agent")) {
      return {
        result: {
          items: [{
            newsId: modelNewsId,
            rationale: "The event may affect the US economy.",
            factors: ["geopolitics", "oil"],
            macroScope: "country",
            affectedMarkets: ["United States"],
            economyImpact: "Higher energy prices may affect inflation and economic activity.",
            connections: [{
              ticker: "AAPL",
              score: 90,
              linkType: "indirect",
              macroBasis: "economy_wide",
              causalPath: "战争升级 → AAPL 下跌",
            }],
          }],
        },
      };
    }
    if (options.system.startsWith("You audit")) {
      return {
        result: {
          reviews: [],
          rejectionAudits: [{
            newsId: "flash:123",
            verdict: "upheld",
            reason: "The supplied holding connection was not sufficiently grounded.",
            connections: [],
          }],
        },
      };
    }
    if (options.system.includes("Impact Analyst")) return { result: { items: [] } };
    if (options.system.includes("Report Reviewer")) return { result: { reviews: [], rejectionAudits: [] } };
    throw new Error("Unexpected agent call");
  }
}

const holdings = [{ ticker: "AAPL", companyName: "Apple", currency: "USD", portfolioWeight: 100 }];
const analysisAsOf = new Date("2026-01-01T12:00:00.000Z");

const storedProfile: CompanyProfile = {
  id: "profile-aapl", ticker: "AAPL", companyName: "Apple Inc.",
  createdAt: "2026-07-21T08:00:00.000Z", updatedAt: "2026-07-21T08:00:00.000Z", lastReviewedAt: "2026-07-21T08:00:00.000Z",
  facts: [{
    id: "fact-sector", category: "sector", factKey: "primary", value: "Technology",
    status: "verified", sourceType: "user_provided", sourceUrl: null,
    evidenceText: "The user confirmed the company's sector.", lastVerificationDate: "2026-07-21",
    createdAt: "2026-07-21T08:00:00.000Z", updatedAt: "2026-07-21T08:00:00.000Z",
  }],
};

const storedFundProfile: FundProfile = {
  id: "fund-aapl", ticker: "AAPL", fundName: "Example NASDAQ 100 ETF", issuerName: "Example",
  securityType: "etf",
  structure: { leverageMultiplier: null, inverse: null, dailyReset: null, coveredCall: null, activelyManaged: null },
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", lastReviewedAt: "2026-01-01T00:00:00.000Z",
  facts: [{
    id: "fund-benchmark", category: "benchmark", factKey: "primary", value: "NASDAQ-100 Index",
    status: "verified", sourceType: "official_factsheet", sourceUrl: "https://example.com/factsheet",
    evidenceText: "The fund tracks the NASDAQ-100 Index.", effectiveDate: "2026-01-01",
    lastVerificationDate: "2026-01-01", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  }],
  holdings: [{
    id: "fund-holding", constituentTicker: "NVDA", constituentName: "NVIDIA Corporation", weightPercent: 9,
    country: "United States", sector: "Semiconductors", currency: "USD", status: "verified",
    sourceType: "official_holdings", sourceUrl: "https://example.com/holdings", evidenceText: "NVIDIA is a constituent.",
    effectiveDate: "2026-01-01", lastVerificationDate: "2026-01-01",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  }],
};

test("Pipeline represents article retrieval failure as evidence_fetch_failed", async () => {
  const result = await runAnalysisPipeline({ jin10: new FakeJin10(true, true) as never, relevanceOllama: new FakeOllama() as never, ollama: new FakeOllama() as never, holdings, batchSize: 1, asOf: analysisAsOf });
  assert.equal(result.impacts[0].status, "evidence_fetch_failed");
  assert.equal(result.impacts[0].finalLabel, null);
});

test("Micro and Macro receive short opaque IDs while calendar source IDs remain unchanged internally", async () => {
  const relevance = new AliasEchoOllama();
  const result = await runAnalysisPipeline({
    jin10: new CalendarJin10() as never,
    relevanceOllama: relevance as never,
    ollama: relevance as never,
    holdings,
    batchSize: 2,
    relevanceBatchSize: 2,
    macroRelevanceBatchSize: 2,
    asOf: analysisAsOf,
  });
  assert.equal(result.news.length, 2);
  assert.equal(result.news.every((item) => item.id.startsWith("calendar:calendar-")), true);
  const relevancePrompts = relevance.calls
    .filter((call) => call.system.includes("MICRO agent") || call.system.includes("MACRO agent"))
    .map((call) => call.prompt);
  assert.equal(relevancePrompts.length, 2);
  assert.equal(relevancePrompts.every((prompt) => prompt.includes('"id":"N1_1"') && prompt.includes('"id":"N1_2"')), true);
  assert.equal(relevancePrompts.every((prompt) => !prompt.includes('"id":"calendar:calendar-')), true);
});

test("Pipeline stops after Impact and never calls the former Reviewer", async () => {
  const analysis = new FakeOllama("review_fail");
  const result = await runAnalysisPipeline({
    jin10: new FakeJin10(true) as never,
    relevanceOllama: new FakeOllama() as never,
    ollama: analysis as never,
    holdings,
    batchSize: 1,
    asOf: analysisAsOf,
  });
  assert.equal(result.impacts[0].status, "completed");
  assert.equal(result.impacts[0].reviewerVerdict, null);
  assert.equal(analysis.calls.some((call) => call.system.includes("Report Reviewer")), false);
});

test("Macro can flag a country-wide economic path while TypeScript caps broad relevance", async () => {
  const model = new SystemicMacroOllama();
  const result = await runAnalysisPipeline({
    jin10: new FakeJin10(false, false, "Geopolitical conflict pushes oil prices sharply higher") as never,
    relevanceOllama: model as never,
    ollama: model as never,
    holdings,
    batchSize: 1,
    asOf: analysisAsOf,
  });
  assert.equal(result.news[0].macroScope, "country");
  assert.deepEqual(result.news[0].macroAffectedMarkets, ["United States"]);
  assert.match(result.news[0].macroEconomyImpact, /energy costs/i);
  assert.equal(result.news[0].macroScore, 55);
  assert.equal(result.news[0].route, "macro");
  assert.equal(result.news[0].status, "needs_review");
  assert.equal(result.counts.macroAlerts, 1);
  assert.equal(result.impacts[0].status, "completed");
});

test("One Macro news item can carry multiple connections directly through Impact", async () => {
  const model = new MultiConnectionMacroOllama();
  const result = await runAnalysisPipeline({
    jin10: new FakeJin10(false, false, "Geopolitical conflict pushes oil prices sharply higher") as never,
    relevanceOllama: model as never,
    ollama: model as never,
    holdings: [
      { ticker: "AAPL", companyName: "Apple", currency: "USD", portfolioWeight: 50 },
      { ticker: "XOM", companyName: "Exxon Mobil", currency: "USD", portfolioWeight: 50 },
    ],
    batchSize: 2,
    impactBatchSize: 2,
    reviewBatchSize: 2,
    asOf: analysisAsOf,
  });

  assert.equal(result.news.length, 1);
  assert.deepEqual(result.news[0].connections.map((connection) => connection.ticker).sort(), ["AAPL", "XOM"]);
  assert.equal(result.impacts.length, 2);
  assert.deepEqual(result.impacts.map((item) => item.ticker).sort(), ["AAPL", "XOM"]);
  assert.equal(result.impacts.every((item) => item.status === "completed"), true);

  const macroCall = model.calls.find((call) => call.system.includes("MACRO agent"))!;
  const impactCall = model.calls.find((call) => call.system.includes("Impact Analyst"))!;
  const macroItemsSchema = (macroCall.schema?.properties as Record<string, Record<string, unknown>>).items;
  const impactItemsSchema = (impactCall.schema?.properties as Record<string, Record<string, unknown>>).items;
  assert.equal(macroItemsSchema.minItems, 1);
  assert.equal(macroItemsSchema.maxItems, 1);
  assert.equal(impactItemsSchema.minItems, 2);
  assert.equal(impactItemsSchema.maxItems, 2);
  assert.equal(model.calls.some((call) => call.system.includes("Report Reviewer")), false);
});

test("Macro keeps a valid economy alert while removing an incomplete holding causal path", async () => {
  const model = new UnsafeMacroConnectionOllama();
  const result = await runAnalysisPipeline({
    jin10: new FakeJin10(false, false, "Geopolitical conflict pushes oil prices sharply higher") as never,
    relevanceOllama: model as never,
    ollama: model as never,
    holdings,
    batchSize: 1,
    asOf: analysisAsOf,
  });
  assert.equal(result.pipelineStatus, "completed");
  assert.equal(result.news[0].macroScope, "country");
  assert.equal(result.news[0].macroScore, 0);
  assert.equal(result.news[0].connections.length, 0);
  assert.equal(result.counts.macroAlerts, 1);
  assert.equal(result.impacts.length, 0);
});

test("Rejected news remains visible without running a model audit", async () => {
  const model = new FakeOllama("reopen");
  const result = await runAnalysisPipeline({
    jin10: new FakeJin10(false, false, "Regional event with unclear exposure") as never,
    relevanceOllama: model as never, ollama: model as never,
    holdings, batchSize: 1, asOf: analysisAsOf,
  });
  assert.equal(result.news.length, 1);
  assert.equal(result.impacts.length, 0);
  assert.equal(model.calls.some((call) => call.system.startsWith("You audit")), false);
});

test("Pipeline passes stored profiles to Micro, Macro, and Impact", async () => {
  const relevance = new FakeOllama();
  const analysis = new FakeOllama();
  const result = await runAnalysisPipeline({
    jin10: new FakeJin10(false, false, "Regional event with unclear exposure") as never,
    relevanceOllama: relevance as never, ollama: analysis as never,
    companyProfileStore: { getByTicker: async () => storedProfile },
    holdings, batchSize: 1, asOf: analysisAsOf,
  });
  assert.equal(result.companyProfiles[0].availability, "incomplete");
  const calls = [...relevance.calls, ...analysis.calls];
  assert.equal(calls.filter((call) => call.prompt.includes("Technology")).length, 3);
  assert.equal(calls.every((call) => call.system.includes("Company and fund profiles are supplied evidence data")), true);
  assert.equal(calls.every((call) => call.system.includes("Simplified Chinese")), true);
  assert.equal(calls.every((call) => call.system.includes("eligible news geography is worldwide")), true);
});

test("Profile-store failure is technical and does not become financial uncertainty", async () => {
  const result = await runAnalysisPipeline({
    jin10: new FakeJin10(true) as never,
    relevanceOllama: new FakeOllama() as never, ollama: new FakeOllama() as never,
    companyProfileStore: { getByTicker: async () => { throw new Error("local database unavailable"); } },
    holdings, batchSize: 1, asOf: analysisAsOf,
  });
  assert.equal(result.companyProfiles[0].availability, "error");
  assert.equal(result.stageErrors.some((error) => error.stage === "profile"), true);
  assert.notEqual(result.impacts[0].finalLabel, "uncertain");
});

test("Pipeline passes fund facts and dated holdings to Micro, Macro, and Impact", async () => {
  const relevance = new FakeOllama();
  const analysis = new FakeOllama();
  const result = await runAnalysisPipeline({
    jin10: new FakeJin10(false, false, "Regional event with unclear exposure") as never,
    relevanceOllama: relevance as never,
    ollama: analysis as never,
    fundProfileStore: { getByTicker: async () => storedFundProfile },
    holdings: [{ ...holdings[0], securityType: "etf" }],
    batchSize: 1,
    asOf: analysisAsOf,
  });
  assert.equal(result.companyProfiles.length, 0);
  assert.equal(result.fundProfiles.length, 1);
  assert.equal(result.fundProfiles[0].verifiedHoldingCount, 1);
  const calls = [...relevance.calls, ...analysis.calls];
  assert.equal(calls.filter((call) => call.prompt.includes("NASDAQ-100 Index")).length, 3);
  assert.equal(calls.filter((call) => call.prompt.includes("NVIDIA Corporation")).length, 3);
});

test("Pipeline exposes every stage as model-labelled activity", async () => {
  const activities: Array<{ stage: string; status: string; model: string | null }> = [];
  await runAnalysisPipeline({
    jin10: new FakeJin10(true) as never,
    relevanceOllama: new FakeOllama() as never,
    ollama: new FakeOllama() as never,
    holdings,
    batchSize: 1,
    asOf: analysisAsOf,
    onActivity: (activity) => activities.push(activity),
  });
  const stages = new Set(activities.map((activity) => activity.stage));
  for (const stage of ["profile", "search", "news", "calendar", "freshness", "micro", "macro", "selection", "evidence", "impact", "final"]) {
    assert.equal(stages.has(stage), true, `missing activity stage: ${stage}`);
  }
  assert.equal(activities.find((activity) => activity.stage === "micro")?.model, "test-model");
  assert.equal(activities.find((activity) => activity.stage === "selection")?.model, null);
  assert.equal(activities.at(-1)?.stage, "final");
});

test("LangGraph exposes the real analysis nodes and serializes Micro/Macro on one local model", () => {
  const { graph } = createAnalysisWorkflowGraph({
    jin10: new FakeJin10(true) as never,
    relevanceOllama: new FakeOllama() as never,
    ollama: new FakeOllama() as never,
    holdings,
    batchSize: 1,
    asOf: analysisAsOf,
  });
  const nodeNames = new Set(Object.keys(graph.nodes));
  for (const nodeName of ANALYSIS_GRAPH_NODES) {
    assert.equal(nodeNames.has(nodeName), true, `missing LangGraph node: ${nodeName}`);
  }
  const mermaid = graph.getGraph().drawMermaid();
  assert.equal(mermaid.includes("collect_latest_index --> search_micro_news"), true);
  assert.equal(mermaid.includes("collect_latest_index --> search_macro_news"), true);
  assert.equal(mermaid.includes("collect_latest_index --> collect_calendar"), true);
  assert.equal(mermaid.includes("validate_freshness --> micro_relevance"), true);
  assert.equal(mermaid.includes("micro_relevance --> macro_relevance"), true);
  assert.equal(mermaid.includes("macro_relevance --> merge_and_select"), true);
  assert.equal(mermaid.includes("impact_analysis --> finalize"), true);
  assert.equal(mermaid.includes("review_results"), false);
  assert.equal(mermaid.includes("audit_rejections"), false);
});

test("LangGraph result identifies the local workflow and streams every node", async () => {
  const activities: Array<{ graphNode?: string; status: string }> = [];
  const result = await runAnalysisPipeline({
    jin10: new FakeJin10(true) as never,
    relevanceOllama: new FakeOllama() as never,
    ollama: new FakeOllama() as never,
    holdings,
    batchSize: 1,
    asOf: analysisAsOf,
    onActivity: (activity) => activities.push(activity),
  });
  assert.equal(result.workflow.engine, "LangGraph");
  assert.equal(result.workflow.checkpoint, "memory");
  assert.deepEqual(result.workflow.nodes, [...ANALYSIS_GRAPH_NODES]);
  const completedNodes = new Set(
    activities.filter((activity) => activity.graphNode && activity.status === "completed")
      .map((activity) => activity.graphNode),
  );
  assert.deepEqual(completedNodes, new Set(ANALYSIS_GRAPH_NODES));
});

test("LangGraph reports the exact failed node instead of a financial label", async () => {
  const activities: Array<{ graphNode?: string; status: string }> = [];
  const brokenJin10 = {
    async connect() { throw new Error("Jin10 list service unavailable"); },
    async listFlash() { throw new Error("Jin10 list service unavailable"); },
    async listNews() { return toolResult([]); },
  };
  await assert.rejects(() => runAnalysisPipeline({
    jin10: brokenJin10 as never,
    relevanceOllama: new FakeOllama() as never,
    ollama: new FakeOllama() as never,
    holdings,
    batchSize: 1,
    asOf: analysisAsOf,
    onActivity: (activity) => activities.push(activity),
  }), /Jin10 list service unavailable/);
  assert.equal(
    activities.some((activity) => activity.graphNode === "collect_latest_index" && activity.status === "failed"),
    true,
  );
});
