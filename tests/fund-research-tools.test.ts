import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyFundSource,
  ControlledFundResearchTools,
  FundResearchToolError,
  validateFundSourceUrl,
  type FundSearchResult,
} from "../lib/fund-research-tools.ts";

test("fund research blocks unsafe URLs and classifies controlled fund sources", () => {
  [
    "http://example.com/fund",
    "https://user:secret@example.com/fund",
    "https://127.0.0.1/fund",
    "https://service.local/fund",
    "https://reddit.com/r/etfs",
  ].forEach((url) => assert.throws(() => validateFundSourceUrl(url), FundResearchToolError));
  assert.deepEqual(
    classifyFundSource("https://investor.vanguard.com/investment-products/etfs/profile/voo/portfolio-holdings"),
    { sourceType: "official_holdings", trusted: true },
  );
  assert.deepEqual(
    classifyFundSource("https://example-funds.com/voo-fact-sheet.pdf", ["example-funds.com"]),
    { sourceType: "official_factsheet", trusted: true },
  );
  assert.deepEqual(
    classifyFundSource("https://www.sec.gov/Archives/edgar/data/1/497k.htm"),
    { sourceType: "prospectus", trusted: true },
  );
  assert.deepEqual(
    classifyFundSource("https://news.example.net/voo-review"),
    { sourceType: "reputable_external", trusted: false },
  );
});

test("controlled fund search and extract stay bounded to returned source IDs", async () => {
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://api.tavily.com/search") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.match(String(body.query), /Vanguard S&P 500 ETF/);
      assert.equal(body.search_depth, "advanced");
      assert.deepEqual(body.include_domains, ["vanguard.com"]);
      return Response.json({ results: [
        {
          title: "VOO portfolio holdings",
          url: "https://investor.vanguard.com/investment-products/etfs/profile/voo/portfolio-holdings",
          content: "Official VOO holdings",
          score: 0.95,
        },
        { title: "Unsafe", url: "http://127.0.0.1/private", content: "Must be omitted" },
      ] });
    }
    if (url === "https://api.tavily.com/extract") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.deepEqual(body.urls, ["https://investor.vanguard.com/investment-products/etfs/profile/voo/portfolio-holdings"]);
      assert.match(String(body.query), /holdings weights/);
      return Response.json({
        results: [{
          url: "https://investor.vanguard.com/investment-products/etfs/profile/voo/portfolio-holdings",
          raw_content: "Holdings as of July 22, 2026: Apple Inc. 6.4%.",
        }],
        failed_results: [],
      });
    }
    return new Response("missing", { status: 404 });
  };
  const tools = new ControlledFundResearchTools({ fetcher, tavilyApiKey: "test-key" });
  const search = await tools.searchFundSources({
    ticker: "VOO", fundName: "Vanguard S&P 500 ETF", officialDomains: ["vanguard.com"],
    requests: [{ id: "holdings", kind: "official", topic: "portfolio holdings" }],
  });
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0].sourceType, "official_holdings");
  const fetched = await tools.fetchFundSources({
    results: search.results, sourceIds: [search.results[0].id], officialDomains: ["vanguard.com"],
  });
  assert.match(fetched.sources[0].text, /Apple Inc/);
  await assert.rejects(
    () => tools.fetchFundSources({ results: search.results, sourceIds: ["invented"] }),
    /not returned/,
  );
});

test("fund search limits and no-result failures stay technical", async () => {
  const timeoutFetcher = (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
  const tools = new ControlledFundResearchTools({
    fetcher: timeoutFetcher,
    tavilyApiKey: "test-key",
    limits: { searchTimeoutMs: 5 },
  });
  const result = await tools.searchFundSources({
    ticker: "VOO", fundName: "Vanguard ETF",
    requests: [{ id: "timeout", kind: "holdings", topic: "current holdings" }],
  });
  assert.equal(result.results.length, 0);
  assert.match(result.failures[0].message, /timed out/);
  await assert.rejects(() => tools.searchFundSources({
    ticker: "VOO", fundName: "Vanguard ETF",
    requests: [1, 2, 3, 4].map((number) => ({ id: `s${number}`, kind: "official" as const, topic: "profile" })),
  }), /between 1 and 3/);
  const sources: FundSearchResult[] = Array.from({ length: 6 }, (_, index) => ({
    id: `source-${index}`, title: "Source", url: `https://example.com/${index}`, snippet: "",
    sourceType: "reputable_external", trusted: false,
  }));
  await assert.rejects(() => tools.fetchFundSources({
    results: sources, sourceIds: sources.map((source) => source.id),
  }), /At most 5/);
});
