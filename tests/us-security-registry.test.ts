import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { D1UsSecurityRegistry, parseNasdaqDirectory } from "../lib/us-security-registry.ts";

class SQLiteStatementAdapter {
  private values: unknown[] = [];
  private readonly database: DatabaseSync;
  private readonly sql: string;
  constructor(database: DatabaseSync, sql: string) { this.database = database; this.sql = sql; }
  bind(...values: unknown[]) { this.values = values; return this; }
  async first<T>() { return (this.database.prepare(this.sql).get(...this.values as never[]) as T | undefined) ?? null; }
  async all<T>() { return { results: this.database.prepare(this.sql).all(...this.values as never[]) as T[] }; }
  run() { return this.database.prepare(this.sql).run(...this.values as never[]); }
}

class SQLiteD1Adapter {
  readonly database: DatabaseSync;
  constructor(database = new DatabaseSync(":memory:")) { this.database = database; }
  prepare(sql: string) { return new SQLiteStatementAdapter(this.database, sql); }
  async batch(statements: SQLiteStatementAdapter[]) { return statements.map((statement) => statement.run()); }
}

const nasdaqListed = `Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares
AAPL|Apple Inc. - Common Stock|Q|N|N|100|N|N
QQQ|Invesco QQQ Trust, Series 1|Q|N|N|100|Y|N
TEST|Test Security|Q|Y|N|100|N|N
File Creation Time: 0722202610:01|||||||`;

const otherListed = `ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol
BABA|Alibaba Group Holding Limited American Depositary Shares|N|BABA|N|100|N|BABA
VOO|Vanguard S&P 500 ETF|P|VOO|Y|100|N|VOO
EXR|Example Real Estate Investment Trust Common Stock|A|EXR|N|100|N|EXR
File Creation Time: 0722202610:01|||||||`;

function directoryFetcher(counter: { calls: number }) {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    counter.calls += 1;
    assert.equal(init?.redirect, "manual");
    const url = String(input);
    return new Response(url.includes("nasdaqlisted") ? nasdaqListed : otherListed, {
      headers: { "content-type": "text/plain" },
    });
  };
}

test("Nasdaq directory parsing excludes tests and identifies stocks, ADRs, REITs, and ETFs", () => {
  const listed = parseNasdaqDirectory("nasdaqlisted", nasdaqListed, "2026-07-22T00:00:00.000Z", "r1");
  const other = parseNasdaqDirectory("otherlisted", otherListed, "2026-07-22T00:00:00.000Z", "r1");
  assert.deepEqual(listed.rows.map((row) => [row.symbol, row.securityType]), [["AAPL", "stock"], ["QQQ", "etf"]]);
  assert.deepEqual(other.rows.map((row) => [row.symbol, row.securityType]), [["BABA", "adr"], ["VOO", "etf"], ["EXR", "reit"]]);
  assert.equal(other.rows[1].exchangeName, "NYSE Arca");
  assert.equal(listed.sourceUpdatedAt, "2026-07-22T14:01:00.000Z");
});

test("registry downloads once, reuses the fresh cache, resolves identities, and exposes counts", async () => {
  const adapter = new SQLiteD1Adapter();
  const counter = { calls: 0 };
  const registry = new D1UsSecurityRegistry(adapter as never, { fetcher: directoryFetcher(counter) });

  const first = await registry.lookup(["AAPL", "VOO", "0700.HK"]);
  assert.equal(counter.calls, 2);
  assert.equal(first.status.refreshed, true);
  assert.deepEqual(first.missingSymbols, ["0700.HK"]);
  assert.equal(first.matches.find((match) => match.inputSymbol === "VOO")?.security.securityType, "etf");

  const second = await registry.lookup(["BABA"]);
  assert.equal(counter.calls, 2);
  assert.equal(second.status.refreshed, false);
  assert.equal(second.matches[0].security.securityType, "adr");

  const inspection = await registry.inspect();
  assert.equal(inspection.total, 5);
  assert.equal(inspection.types.find((item) => item.securityType === "etf")?.total, 2);
});

test("a failed refresh keeps an existing stale cache visible and marked stale", async () => {
  const adapter = new SQLiteD1Adapter();
  await new D1UsSecurityRegistry(adapter as never, { fetcher: directoryFetcher({ calls: 0 }) }).lookup(["AAPL"]);
  adapter.database.prepare("UPDATE security_registry_metadata SET last_refresh_at = ?").run("2020-01-01T00:00:00.000Z");

  const staleRegistry = new D1UsSecurityRegistry(adapter as never, {
    maxAgeMs: 60_000,
    fetcher: async () => { throw new Error("offline"); },
  });
  const result = await staleRegistry.lookup(["AAPL"]);
  assert.equal(result.matches[0].security.symbol, "AAPL");
  assert.equal(result.status.stale, true);
  assert.match(result.status.warning ?? "", /request failed/i);
});

test("unexpected source content is rejected before it can replace the cache", () => {
  assert.throws(
    () => parseNasdaqDirectory("nasdaqlisted", "<html>blocked</html>", "2026-07-22T00:00:00.000Z", "r1"),
    /unexpected header/i,
  );
});
