import assert from "node:assert/strict";
import test from "node:test";
import { FundResearchAgent } from "../lib/fund-research-agent.ts";
import { mergeFundProfiles, type FundProfile } from "../lib/fund-profile-contracts.ts";
import type { FetchedFundSource, FundSearchResult } from "../lib/fund-research-tools.ts";
import { OllamaError } from "../lib/ollama.ts";

const timestamp = "2026-07-23T05:00:00.000Z";
const searchResult: FundSearchResult = {
  id: "fund-source-1",
  title: "VOO official fund profile and holdings",
  url: "https://investor.vanguard.com/investment-products/etfs/profile/voo/portfolio-holdings",
  snippet: "Official profile and holdings",
  sourceType: "official_holdings",
  trusted: true,
};
const fetchedSource: FetchedFundSource = {
  ...searchResult,
  text: "<chunk 1> The fund is a passively managed, non-leveraged, non-inverse ETF with no daily reset and no covered-call strategy. [...] <chunk 2> Holdings as of July 22, 2026: Apple Inc. (AAPL) 6.4%.",
  fetchedAt: timestamp,
};

class MemoryFundStore {
  profile: FundProfile | null;
  saveCalls = 0;
  constructor(profile: FundProfile | null = null) { this.profile = profile; }
  async getByTicker() { return this.profile; }
  async save(profile: FundProfile) {
    this.saveCalls += 1;
    this.profile = mergeFundProfiles(this.profile, profile);
    return this.profile;
  }
}

type Extraction = {
  facts: Array<Record<string, unknown>>;
  holdings: Array<Record<string, unknown>>;
  structureFields: Array<Record<string, unknown>>;
};

class ScriptedFundOllama {
  model = "qwen3.5:4b";
  calls = 0;
  private readonly extraction: Extraction;
  constructor(extraction: Extraction) { this.extraction = extraction; }
  async chatStructured(options: { system: string }) {
    this.calls += 1;
    if (options.system.includes("Planner")) {
      return { result: { searches: [{ id: "fund-search", kind: "official", topic: "profile holdings structure" }] } };
    }
    if (options.system.includes("Source Selector")) return { result: { sourceIds: ["fund-source-1"] } };
    return { result: this.extraction };
  }
}

class InvalidOnceFundOllama {
  model = "qwen3.5:4b";
  extractionCalls = 0;
  extractionPrompts: string[] = [];
  async chatStructured(options: { system: string; prompt: string; schema: Record<string, unknown>; attempts?: number; timeoutMs?: number }) {
    if (options.system.includes("Planner")) {
      return { result: { searches: [{ id: "fund-search", kind: "official", topic: "profile holdings structure" }] } };
    }
    if (options.system.includes("Source Selector")) return { result: { sourceIds: ["fund-source-1"] } };
    this.extractionCalls += 1;
    this.extractionPrompts.push(options.prompt);
    assert.equal(options.attempts, 1);
    if (this.extractionCalls === 1) {
      assert.equal(options.timeoutMs, 180_000);
      const properties = options.schema.properties as { facts: { maxItems: number }; holdings: { maxItems: number } };
      assert.equal(properties.facts.maxItems, 4);
      assert.equal(properties.holdings.maxItems, 2);
      throw new OllamaError("Ollama returned JSON that did not match the required schema.");
    }
    assert.equal(options.timeoutMs, 120_000);
    const properties = options.schema.properties as { facts: { maxItems: number }; holdings: { maxItems: number } };
    assert.equal(properties.facts.maxItems, 2);
    assert.equal(properties.holdings.maxItems, 1);
    return { result: validExtraction() };
  }
}

class TimeoutFundOllama {
  model = "qwen3.5:4b";
  extractionCalls = 0;
  async chatStructured(options: { system: string }) {
    if (options.system.includes("Planner")) {
      return { result: { searches: [{ id: "fund-search", kind: "official", topic: "profile holdings structure" }] } };
    }
    if (options.system.includes("Source Selector")) return { result: { sourceIds: ["fund-source-1"] } };
    this.extractionCalls += 1;
    throw new OllamaError("Ollama took longer than 180 seconds to respond.", undefined, "timeout");
  }
}

class ScriptedFundTools {
  limits = { maxPages: 5 };
  searchResults: FundSearchResult[];
  sources: FetchedFundSource[];
  searchFailures: Array<{ requestId: string; message: string }>;
  fetchFailures: Array<{ sourceId: string; message: string }>;
  searchCalls = 0;
  fetchCalls = 0;
  constructor(options: {
    searchResults?: FundSearchResult[];
    sources?: FetchedFundSource[];
    searchFailures?: Array<{ requestId: string; message: string }>;
    fetchFailures?: Array<{ sourceId: string; message: string }>;
  } = {}) {
    this.searchResults = options.searchResults ?? [searchResult];
    this.sources = options.sources ?? [fetchedSource];
    this.searchFailures = options.searchFailures ?? [];
    this.fetchFailures = options.fetchFailures ?? [];
  }
  async searchFundSources() {
    this.searchCalls += 1;
    return { results: this.searchResults, failures: this.searchFailures };
  }
  async fetchFundSources() {
    this.fetchCalls += 1;
    return { sources: this.sources, failures: this.fetchFailures };
  }
}

function validExtraction(): Extraction {
  return {
    facts: [{
      category: "fund_type", factKey: "基金类型", value: "交易所交易基金",
      effectiveDate: "", sourceId: "fund-source-1", evidenceText: "fund-source-1-evidence-1",
    }],
    holdings: [{
      constituentTicker: "AAPL", constituentName: "Apple Inc.", weightPercent: 6.4,
      country: "美国", sector: "信息技术", currency: "USD", effectiveDate: "2026-07-22",
      sourceId: "fund-source-1", evidenceText: "fund-source-1-evidence-2",
    }],
    structureFields: [
      { field: "leverageMultiplier", value: "1", sourceId: "fund-source-1", evidenceText: "fund-source-1-evidence-1" },
      { field: "inverse", value: "no", sourceId: "fund-source-1", evidenceText: "fund-source-1-evidence-1" },
      { field: "dailyReset", value: "no", sourceId: "fund-source-1", evidenceText: "fund-source-1-evidence-1" },
      { field: "coveredCall", value: "no", sourceId: "fund-source-1", evidenceText: "fund-source-1-evidence-1" },
      { field: "activelyManaged", value: "no", sourceId: "fund-source-1", evidenceText: "fund-source-1-evidence-1" },
    ],
  };
}

test("trusted fund evidence creates verified facts, structure, and dated holdings", async () => {
  const store = new MemoryFundStore();
  const ollama = new ScriptedFundOllama(validExtraction());
  const result = await new FundResearchAgent({
    ollama: ollama as never,
    store,
    tools: new ScriptedFundTools() as never,
  }).research({ ticker: "VOO", fundName: "Vanguard S&P 500 ETF", securityType: "etf" });
  assert.equal(result.status, "updated");
  assert.equal(result.verifiedFactsAdded, 6);
  assert.equal(result.verifiedHoldingsAdded, 1);
  assert.equal(store.profile?.holdings[0].effectiveDate, "2026-07-22");
  assert.equal(store.profile?.structure.leverageMultiplier, 1);
  assert.equal(store.profile?.facts.every((fact) => fact.status === "verified"), true);
});

test("an invalid fund extraction retries once with a smaller evidence prompt and then saves", async () => {
  const store = new MemoryFundStore();
  const ollama = new InvalidOnceFundOllama();
  const result = await new FundResearchAgent({
    ollama: ollama as never,
    store,
    tools: new ScriptedFundTools() as never,
  }).research({ ticker: "VOO", fundName: "Vanguard S&P 500 ETF", securityType: "etf" });
  assert.equal(result.status, "updated");
  assert.equal(result.modelRetries, 1);
  assert.equal(ollama.extractionCalls, 2);
  assert.match(ollama.extractionPrompts[1], /up to 1 important holdings/);
  assert.equal(store.saveCalls, 1);
});

test("a timed-out fund extraction does not queue a second long model generation", async () => {
  const ollama = new TimeoutFundOllama();
  await assert.rejects(
    () => new FundResearchAgent({
      ollama: ollama as never,
      store: new MemoryFundStore(),
      tools: new ScriptedFundTools() as never,
    }).research({ ticker: "VOO", fundName: "Vanguard S&P 500 ETF", securityType: "etf" }),
    /evidence extraction failed.*180 seconds/i,
  );
  assert.equal(ollama.extractionCalls, 1);
});

test("no Tavily search results remain visible and never write a profile", async () => {
  const store = new MemoryFundStore();
  const ollama = new ScriptedFundOllama(validExtraction());
  const tools = new ScriptedFundTools({
    searchResults: [],
    sources: [],
    searchFailures: [{ requestId: "fund-search", message: "Tavily found no matching source." }],
  });
  const result = await new FundResearchAgent({ ollama: ollama as never, store, tools: tools as never })
    .research({ ticker: "ZZZZ", fundName: "Unknown Fund", securityType: "etf" });
  assert.equal(result.status, "no_sources");
  assert.equal(result.coverageIssue?.code, "no_search_results");
  assert.match(result.coverageIssue?.message ?? "", /no matching source/);
  assert.equal(store.saveCalls, 0);
  assert.equal(store.profile, null);
  assert.equal(tools.fetchCalls, 0);
  assert.equal(ollama.calls, 1);
});

test("failed extraction preserves an existing profile without mutation", async () => {
  const initialStore = new MemoryFundStore();
  await new FundResearchAgent({
    ollama: new ScriptedFundOllama(validExtraction()) as never,
    store: initialStore,
    tools: new ScriptedFundTools() as never,
  }).research({ ticker: "VOO", fundName: "Vanguard S&P 500 ETF", securityType: "etf" });
  const existing = initialStore.profile!;
  existing.holdings = [];
  const store = new MemoryFundStore(existing);
  const tools = new ScriptedFundTools({
    sources: [],
    fetchFailures: [{ sourceId: "fund-source-1", message: "Tavily could not extract this page." }],
  });
  const result = await new FundResearchAgent({
    ollama: new ScriptedFundOllama(validExtraction()) as never,
    store,
    tools: tools as never,
  }).research({ ticker: "VOO", fundName: "Vanguard S&P 500 ETF", securityType: "etf" });
  assert.equal(result.status, "no_sources");
  assert.equal(result.coverageIssue?.code, "no_fetched_sources");
  assert.equal(store.saveCalls, 0);
  assert.equal(store.profile, existing);
});

test("missing structure evidence no longer blocks supported fund facts and holdings", async () => {
  const partial = validExtraction();
  partial.structureFields = [];
  const store = new MemoryFundStore();
  const result = await new FundResearchAgent({
    ollama: new ScriptedFundOllama(partial) as never,
    store,
    tools: new ScriptedFundTools() as never,
  }).research({ ticker: "VOO", fundName: "Vanguard S&P 500 ETF", securityType: "etf" });
  assert.equal(result.status, "updated");
  assert.equal(result.coverageIssue, null);
  assert.equal(store.saveCalls, 1);
  assert.equal(store.profile?.facts.length, 1);
  assert.equal(store.profile?.holdings.length, 1);
  assert.deepEqual(store.profile?.structure, {
    leverageMultiplier: null, inverse: null, dailyReset: null, coveredCall: null, activelyManaged: null,
  });
  assert.deepEqual(result.health?.missingStructureFields, []);
});

test("unknown external fund sources remain unverified", async () => {
  const externalResult = { ...searchResult, sourceType: "reputable_external" as const, trusted: false };
  const externalSource = { ...fetchedSource, ...externalResult };
  const store = new MemoryFundStore();
  const result = await new FundResearchAgent({
    ollama: new ScriptedFundOllama(validExtraction()) as never,
    store,
    tools: new ScriptedFundTools({ searchResults: [externalResult], sources: [externalSource] }) as never,
  }).research({ ticker: "VOO", fundName: "Vanguard S&P 500 ETF", securityType: "etf" });
  assert.equal(result.unverifiedFactsAdded, 6);
  assert.equal(result.unverifiedHoldingsAdded, 1);
  assert.equal(result.verifiedFactsAdded, 0);
  assert.equal(result.health?.reusable, false);
});
