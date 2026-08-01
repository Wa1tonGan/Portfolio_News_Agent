import assert from "node:assert/strict";
import test from "node:test";
import { POST } from "../app/api/alpha-vantage/status/route.ts";

test("Alpha-only status route reports API work separately and never saves, reads pages, or runs a model", async (context) => {
  const previousKey = process.env.ALPHA_VANTAGE_API_KEY;
  const previousFetch = globalThis.fetch;
  context.after(() => {
    if (previousKey === undefined) delete process.env.ALPHA_VANTAGE_API_KEY;
    else process.env.ALPHA_VANTAGE_API_KEY = previousKey;
    globalThis.fetch = previousFetch;
  });

  process.env.ALPHA_VANTAGE_API_KEY = "private-test-key";
  globalThis.fetch = (async (_input, init) => {
    assert.equal(init?.redirect, "manual");
    return Response.json({
      net_assets: "25900000000",
      leveraged: "NO",
      sectors: [{ sector: "TECHNOLOGY", weight: "0.58" }],
      holdings: [
        { symbol: "NVDA", description: "NVIDIA Corp", weight: "0.09" },
        { symbol: "MSFT", description: "Microsoft Corp", weight: "0.08" },
        { symbol: "AAPL", description: "Apple Inc", weight: "0.07" },
      ],
    });
  }) as typeof fetch;

  const response = await POST(new Request("http://localhost/api/alpha-vantage/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticker: "DRAM", securityType: "etf" }),
  }));
  const result = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 200);
  assert.equal(result.connected, true);
  assert.equal(result.endpoint, "ETF_PROFILE");
  assert.equal(result.apiCalls, 1);
  assert.equal(result.pagesFetched, 0);
  assert.equal(result.modelUsed, false);
  assert.equal(result.readyForBaseline, true);
  assert.equal(result.sectorCount, 1);
  assert.equal(result.holdingCount, 3);
  assert.equal("profile" in result, false);
});
