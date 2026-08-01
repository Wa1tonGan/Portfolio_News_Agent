import assert from "node:assert/strict";
import test from "node:test";
import { CompanyResearchAgent } from "../lib/company-research-agent.ts";
import { assessCompanyProfile, mergeCompanyProfiles, requiredCompanyProfileCategories, type CompanyFact, type CompanyProfile } from "../lib/company-profile-contracts.ts";
import type { CompanySearchResult, FetchedCompanySource } from "../lib/company-research-tools.ts";
import { OllamaError } from "../lib/ollama.ts";

const timestamp = "2026-07-22T02:00:00.000Z";
function storedFact(id: string, category: CompanyFact["category"], value: string, factKey = "primary"): CompanyFact {
  return {
    id, category, factKey, value, status: "verified", sourceType: "user_provided", sourceUrl: null,
    evidenceText: "Confirmed directly for the local profile.", lastVerificationDate: "2026-07-22", createdAt: timestamp, updatedAt: timestamp,
  };
}
function storedProfile(facts: CompanyFact[]): CompanyProfile {
  return { id: "profile-exm", ticker: "EXM", companyName: "Example plc", facts, createdAt: timestamp, updatedAt: timestamp, lastReviewedAt: timestamp };
}

class MemoryStore {
  profile: CompanyProfile | null;
  saveCalls = 0;
  constructor(profile: CompanyProfile | null = null) { this.profile = profile; }
  async getByTicker() { return this.profile; }
  async save(profile: CompanyProfile) {
    this.saveCalls += 1;
    this.profile = mergeCompanyProfiles(this.profile, profile);
    return this.profile;
  }
}

class ScriptedOllama {
  model = "qwen3.5:9b";
  calls = 0;
  extraction: { facts: Array<{ category: CompanyFact["category"]; factKey: string; value: string; sourceId: string; evidenceText: string }> };
  constructor(extraction: ScriptedOllama["extraction"]) { this.extraction = extraction; }
  async chatStructured(options: { system: string }) {
    this.calls += 1;
    if (options.system.includes("Planner")) return { result: { searches: [{ id: "search-1", kind: "official", topic: "company profile" }] } };
    if (options.system.includes("Source Selector")) return { result: { sourceIds: ["source-1"] } };
    return { result: this.extraction };
  }
}

class InvalidOnceCompanyOllama {
  model = "qwen3.5:4b";
  extractionCalls = 0;
  async chatStructured(options: { system: string; schema: Record<string, unknown>; attempts?: number; timeoutMs?: number }) {
    if (options.system.includes("Planner")) {
      return { result: { searches: [{ id: "search-1", kind: "official", topic: "company profile" }] } };
    }
    if (options.system.includes("Source Selector")) return { result: { sourceIds: ["source-1"] } };
    this.extractionCalls += 1;
    assert.equal(options.attempts, 1);
    if (this.extractionCalls === 1) {
      assert.equal(options.timeoutMs, 150_000);
      throw new OllamaError("Ollama returned JSON that did not match the required schema.");
    }
    assert.equal(options.timeoutMs, 120_000);
    const properties = options.schema.properties as { facts: { maxItems: number } };
    assert.equal(properties.facts.maxItems, 3);
    return { result: { facts: [{
      category: "products", factKey: "industrial-sensors", value: "Designs industrial sensors",
      sourceId: "source-1", evidenceText: "Example plc designs industrial sensors and serves customers across Asia and Europe.",
    }] } };
  }
}

const searchResult: CompanySearchResult = {
  id: "source-1", title: "Example annual report", url: "https://example.com/annual-report",
  snippet: "Company profile", sourceType: "official_company", trusted: true,
};
const fetchedSource: FetchedCompanySource = {
  ...searchResult,
  text: "Example plc designs industrial sensors and serves customers across Asia and Europe.",
  fetchedAt: timestamp,
};

class ScriptedTools {
  limits = { maxPages: 6 };
  calls = 0;
  sources: FetchedCompanySource[];
  constructor(sources: FetchedCompanySource[]) { this.sources = sources; }
  async searchCompanySources() { this.calls += 1; return { results: [searchResult], failures: [] }; }
  async fetchCompanySources() { this.calls += 1; return { sources: this.sources, failures: [] }; }
}

test("trusted fetched evidence is verified and saved", async () => {
  const store = new MemoryStore();
  const ollama = new ScriptedOllama({ facts: [{
    category: "products", factKey: "industrial-sensors", value: "Designs industrial sensors", sourceId: "source-1",
    evidenceText: "Example plc designs industrial sensors and serves customers across Asia and Europe.",
  }] });
  const result = await new CompanyResearchAgent({ ollama: ollama as never, store, tools: new ScriptedTools([fetchedSource]) as never })
    .research({ ticker: "EXM", companyName: "Example plc", officialDomains: ["example.com"] });
  assert.equal(result.verifiedFactsAdded, 1);
  assert.equal(store.profile?.facts[0].status, "verified");
  assert.equal(store.profile?.facts[0].sourceUrl, searchResult.url);
});

test("invalid company extraction retries once with a smaller schema and saves valid evidence", async () => {
  const store = new MemoryStore();
  const ollama = new InvalidOnceCompanyOllama();
  const result = await new CompanyResearchAgent({
    ollama: ollama as never,
    store,
    tools: new ScriptedTools([fetchedSource]) as never,
  }).research({ ticker: "EXM", companyName: "Example plc", officialDomains: ["example.com"] });
  assert.equal(result.status, "updated");
  assert.equal(result.modelRetries, 1);
  assert.equal(ollama.extractionCalls, 2);
  assert.equal(result.verifiedFactsAdded, 1);
  assert.equal(store.saveCalls, 1);
});

test("evidence matching tolerates punctuation differences but saves the exact source passage", async () => {
  const store = new MemoryStore();
  const source = { ...fetchedSource, text: "Example plc's revenue was $12.5 billion — across Asia and Europe." };
  const ollama = new ScriptedOllama({ facts: [{
    category: "revenue_drivers", factKey: "收入", value: "收入为125亿美元", sourceId: "source-1",
    evidenceText: "Example plc’s revenue was 12.5 billion across Asia and Europe",
  }] });
  const result = await new CompanyResearchAgent({ ollama: ollama as never, store, tools: new ScriptedTools([source]) as never })
    .research({ ticker: "EXM", companyName: "Example plc", officialDomains: ["example.com"] });
  assert.equal(result.verifiedFactsAdded, 1);
  assert.equal(store.profile?.facts[0].evidenceText, "Example plc's revenue was $12.5 billion — across Asia and Europe");
});

test("the small model can select an immutable evidence ID instead of copying source text", async () => {
  const store = new MemoryStore();
  const source = { ...fetchedSource, text: "<chunk 1> Example plc designs industrial sensors. [...] <chunk 2> It serves customers across Asia and Europe." };
  const ollama = new ScriptedOllama({ facts: [{
    category: "regions", factKey: "主要地区", value: "亚洲和欧洲", sourceId: "source-1",
    evidenceText: "source-1-evidence-2",
  }] });
  const result = await new CompanyResearchAgent({ ollama: ollama as never, store, tools: new ScriptedTools([source]) as never })
    .research({ ticker: "EXM", companyName: "Example plc", officialDomains: ["example.com"] });
  assert.equal(result.verifiedFactsAdded, 1);
  assert.equal(store.profile?.facts[0].evidenceText, "It serves customers across Asia and Europe.");
});

test("model memory remains unverified and unknown or unsupported sources are rejected", async () => {
  const store = new MemoryStore();
  const ollama = new ScriptedOllama({ facts: [
    { category: "sector", factKey: "primary", value: "Industrials", sourceId: "", evidenceText: "Model-memory suggestion without fetched evidence." },
    { category: "regions", factKey: "primary", value: "Asia", sourceId: "missing-source", evidenceText: "A source that was not fetched." },
    { category: "products", factKey: "unsupported", value: "Unsupported product", sourceId: "source-1", evidenceText: "This sentence is not present in the fetched source evidence." },
  ] });
  const result = await new CompanyResearchAgent({ ollama: ollama as never, store, tools: new ScriptedTools([fetchedSource]) as never })
    .research({ ticker: "EXM", companyName: "Example plc" });
  assert.equal(result.unverifiedFactsAdded, 1);
  assert.equal(store.profile?.facts[0].sourceType, "model_memory");
  assert.equal(result.rejectedFacts.length, 2);
});

test("conflicting researched facts are retained for review", async () => {
  const store = new MemoryStore(storedProfile([storedFact("existing-sector", "sector", "Technology")]));
  const ollama = new ScriptedOllama({ facts: [{
    category: "sector", factKey: "primary", value: "Industrials", sourceId: "source-1",
    evidenceText: "Example plc designs industrial sensors and serves customers across Asia and Europe.",
  }] });
  const result = await new CompanyResearchAgent({ ollama: ollama as never, store, tools: new ScriptedTools([fetchedSource]) as never })
    .research({ ticker: "EXM", companyName: "Example plc", officialDomains: ["example.com"] });
  assert.equal(store.profile?.facts.length, 2);
  assert.equal(result.health?.conflicts.length, 1);
});

test("complete current profiles are reused without model or web calls", async () => {
  const complete = storedProfile(requiredCompanyProfileCategories.map((category, index) => storedFact(`fact-${index}`, category, `Value ${index}`, `${category}-primary`)));
  assert.equal(assessCompanyProfile(complete).reusable, true);
  const store = new MemoryStore(complete);
  const ollama = new ScriptedOllama({ facts: [] });
  const tools = new ScriptedTools([]);
  const result = await new CompanyResearchAgent({ ollama: ollama as never, store, tools: tools as never })
    .research({ ticker: "EXM", companyName: "Example plc" });
  assert.equal(result.status, "reused");
  assert.equal(ollama.calls, 0);
  assert.equal(tools.calls, 0);
  assert.equal(store.saveCalls, 0);
});
