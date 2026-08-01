import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyCompanySource,
  CompanyResearchToolError,
  ControlledCompanyResearchTools,
  validateCompanySourceUrl,
  type CompanySearchResult,
} from "../lib/company-research-tools.ts";

test("company research blocks private, credentialed, non-HTTPS, and social URLs", () => {
  const blocked = [
    "http://example.com/report",
    "https://user:secret@example.com/report",
    "https://127.0.0.1/report",
    "https://[::1]/report",
    "https://service.local/report",
    "https://reddit.com/r/stocks",
  ];
  blocked.forEach((url) => assert.throws(() => validateCompanySourceUrl(url), CompanyResearchToolError));
  assert.equal(validateCompanySourceUrl("https://www.sec.gov/Archives/report.htm"), "https://www.sec.gov/Archives/report.htm");
});

test("source classification trusts only controlled official and authority domains", () => {
  assert.deepEqual(classifyCompanySource("https://investor.example.com/results", ["example.com"]), { sourceType: "investor_relations", trusted: true });
  assert.deepEqual(classifyCompanySource("https://www.sec.gov/Archives/edgar/data/1/report.htm"), { sourceType: "company_filing", trusted: true });
  assert.deepEqual(classifyCompanySource("https://news.example.net/company-story"), { sourceType: "reputable_external", trusted: false });
});

test("controlled search returns bounded URLs and fetches only returned source IDs", async () => {
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://api.tavily.com/search") {
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "manual");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-tavily-key");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.match(String(body.query), /Example plc/);
      assert.deepEqual(body.include_domains, ["example.com"]);
      assert.equal(String(init?.body).includes("test-tavily-key"), false);
      return Response.json({ results: [
        { title: "Example results", url: "https://investor.example.com/results", content: "Annual company results" },
        { title: "Unsafe", url: "http://127.0.0.1/private", content: "Must be omitted" },
      ] });
    }
    if (url === "https://api.tavily.com/extract") {
      assert.equal(init?.method, "POST");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-tavily-key");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.deepEqual(body.urls, ["https://investor.example.com/results"]);
      assert.equal(body.extract_depth, "advanced");
      assert.equal(body.format, "text");
      return Response.json({
        results: [{ url: "https://investor.example.com/results", raw_content: "Example serves customers across Asia and Europe." }],
        failed_results: [],
      });
    }
    return new Response("missing", { status: 404 });
  };
  const tools = new ControlledCompanyResearchTools({ fetcher, tavilyApiKey: "test-tavily-key" });
  const search = await tools.searchCompanySources({
    ticker: "EXM", companyName: "Example plc", officialDomains: ["example.com"],
    requests: [{ id: "search-1", kind: "official", topic: "regions" }],
  });
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0].trusted, true);
  const fetched = await tools.fetchCompanySources({ results: search.results, sourceIds: [search.results[0].id], officialDomains: ["example.com"] });
  assert.match(fetched.sources[0].text, /customers across Asia/);
  await assert.rejects(() => tools.fetchCompanySources({ results: search.results, sourceIds: ["invented-source"] }), /not returned/);
});

test("search and page limits are enforced before network access", async () => {
  const tools = new ControlledCompanyResearchTools({ fetcher: async () => new Response(""), tavilyApiKey: "test-tavily-key" });
  await assert.rejects(() => tools.searchCompanySources({
    ticker: "EXM", companyName: "Example",
    requests: [1, 2, 3, 4].map((number) => ({ id: `s${number}`, kind: "official" as const, topic: "profile" })),
  }), /between 1 and 3 searches/);
  const results: CompanySearchResult[] = Array.from({ length: 7 }, (_, index) => ({
    id: `source-${index}`, title: "Source", url: `https://example.com/${index}`, snippet: "", sourceType: "reputable_external", trusted: false,
  }));
  await assert.rejects(() => tools.fetchCompanySources({ results, sourceIds: results.map((result) => result.id) }), /At most 4/);
  await assert.rejects(() => tools.searchCompanySources({
    ticker: "EXM", companyName: "Example",
    requests: [{ id: "unsafe", kind: "official", topic: "site:127.0.0.1 private" }],
  }), /invalid company search/);
});

test("request timeouts remain technical fetch failures", async () => {
  const fetcher = (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
  const tools = new ControlledCompanyResearchTools({ fetcher, tavilyApiKey: "test-tavily-key", limits: { searchTimeoutMs: 5 } });
  const result = await tools.searchCompanySources({
    ticker: "EXM", companyName: "Example",
    requests: [{ id: "timeout-search", kind: "official", topic: "profile" }],
  });
  assert.equal(result.results.length, 0);
  assert.match(result.failures[0].message, /timed out/);
});

test("Tavily Extract results cannot substitute a blocked or different source URL", async () => {
  const fetcher = async () => Response.json({
    results: [{ url: "https://127.0.0.1/private", raw_content: "Private content" }],
    failed_results: [],
  });
  const tools = new ControlledCompanyResearchTools({ fetcher, tavilyApiKey: "test-tavily-key" });
  const result: CompanySearchResult = { id: "source-1", title: "Source", url: "https://example.com/start", snippet: "", sourceType: "reputable_external", trusted: false };
  const fetched = await tools.fetchCompanySources({ results: [result], sourceIds: [result.id] });
  assert.equal(fetched.sources.length, 0);
  assert.match(fetched.failures[0].message, /no usable source text/);
});

test("Tavily Extract page failures remain per-source technical failures", async () => {
  const fetcher = async () => Response.json({
    results: [],
    failed_results: [{ url: "https://example.com/report", error: "Extraction failed for this URL" }],
  });
  const tools = new ControlledCompanyResearchTools({ fetcher, tavilyApiKey: "test-tavily-key" });
  const result: CompanySearchResult = { id: "source-1", title: "Source", url: "https://example.com/report", snippet: "", sourceType: "reputable_external", trusted: false };
  const fetched = await tools.fetchCompanySources({ results: [result], sourceIds: [result.id] });
  assert.equal(fetched.sources.length, 0);
  assert.match(fetched.failures[0].message, /Extraction failed/);
});

test("missing Tavily configuration fails before network access", async () => {
  let requests = 0;
  const tools = new ControlledCompanyResearchTools({
    tavilyApiKey: "",
    fetcher: async () => { requests += 1; return new Response(""); },
  });
  await assert.rejects(() => tools.searchCompanySources({
    ticker: "EXM", companyName: "Example",
    requests: [{ id: "search-1", kind: "official", topic: "profile" }],
  }), /TAVILY_API_KEY/);
  assert.equal(requests, 0);
});

test("Tavily authentication and quota failures remain technical search failures", async () => {
  for (const [status, message] of [[401, /rejected/], [429, /quota or rate limit/]] as const) {
    const tools = new ControlledCompanyResearchTools({
      tavilyApiKey: "test-tavily-key",
      fetcher: async () => new Response("{}", { status, headers: { "content-type": "application/json" } }),
    });
    const result = await tools.searchCompanySources({
      ticker: "EXM", companyName: "Example",
      requests: [{ id: `search-${status}`, kind: "business", topic: "products" }],
    });
    assert.equal(result.results.length, 0);
    assert.match(result.failures[0].message, message);
  }
});
