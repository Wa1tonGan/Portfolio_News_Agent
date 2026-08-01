import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { FundFact, FundHolding, FundProfile } from "../lib/fund-profile-contracts.ts";
import { D1FundProfileStore } from "../lib/fund-profile-store.ts";

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
  private readonly database: DatabaseSync;
  constructor(database: DatabaseSync) { this.database = database; }
  prepare(sql: string) { return new SQLiteStatementAdapter(this.database, sql); }
  async batch(statements: SQLiteStatementAdapter[]) { return statements.map((statement) => statement.run()); }
}

const timestamp = "2026-07-23T04:00:00.000Z";

function fact(id: string, value: string, status: FundFact["status"] = "verified"): FundFact {
  return {
    id, category: "strategy", factKey: "primary", value, status,
    sourceType: "user_provided", sourceUrl: null, evidenceText: "User-provided local evidence.",
    effectiveDate: null, lastVerificationDate: "2026-07-23", createdAt: timestamp, updatedAt: timestamp,
  };
}

function holding(id: string, weightPercent: number, status: FundHolding["status"] = "verified"): FundHolding {
  return {
    id, constituentTicker: "AAPL", constituentName: "Apple Inc.", weightPercent,
    country: "United States", sector: "Technology", currency: "USD", status,
    sourceType: "user_provided", sourceUrl: null, evidenceText: "User-provided holdings evidence.",
    effectiveDate: "2026-07-22", lastVerificationDate: "2026-07-23", createdAt: timestamp, updatedAt: timestamp,
  };
}

function profile(facts: FundFact[], holdings: FundHolding[]): FundProfile {
  return {
    id: "fund-voo", ticker: "VOO", fundName: "Vanguard S&P 500 ETF", issuerName: "Vanguard",
    securityType: "etf",
    structure: { leverageMultiplier: 1, inverse: false, dailyReset: false, coveredCall: false, activelyManaged: false },
    facts, holdings, createdAt: timestamp, updatedAt: timestamp, lastReviewedAt: timestamp,
  };
}

test("D1 fund store saves, reloads, lists, and preserves conflicting evidence", async () => {
  const database = new DatabaseSync(":memory:");
  const store = new D1FundProfileStore(new SQLiteD1Adapter(database) as never);
  await store.save(profile([fact("verified-strategy", "Track the S&P 500")], [holding("verified-aapl", 6.4)]));
  const loaded = await store.getByTicker("voo");
  assert.equal(loaded?.ticker, "VOO");
  assert.equal(loaded?.facts[0].status, "verified");
  assert.equal(loaded?.holdings[0].weightPercent, 6.4);
  assert.equal(loaded?.structure.leverageMultiplier, 1);

  await store.save({
    ...profile(
      [fact("suggested-strategy", "Actively managed", "unverified")],
      [holding("suggested-aapl", 4, "unverified")],
    ),
    updatedAt: "2026-07-23T05:00:00.000Z",
  });
  const reused = await store.getByTicker("VOO");
  assert.equal(reused?.facts.length, 2);
  assert.equal(reused?.holdings.length, 2);
  assert.equal(reused?.facts.find((item) => item.id === "verified-strategy")?.value, "Track the S&P 500");
  assert.equal(reused?.holdings.find((item) => item.id === "verified-aapl")?.weightPercent, 6.4);
  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].ticker, "VOO");
});

test("D1 fund store persists unknown structure fields and later fills one independently", async () => {
  const database = new DatabaseSync(":memory:");
  const store = new D1FundProfileStore(new SQLiteD1Adapter(database) as never);
  const initial = profile([fact("fund-type", "ETF")], []);
  initial.structure = {
    leverageMultiplier: null, inverse: null, dailyReset: null, coveredCall: null, activelyManaged: null,
  };
  await store.save(initial);
  assert.deepEqual((await store.getByTicker("VOO"))?.structure, initial.structure);

  const leverageFact = fact("structure-leverage", "1");
  leverageFact.category = "fund_structure";
  leverageFact.factKey = "leverageMultiplier";
  const update = profile([leverageFact], []);
  update.structure = {
    leverageMultiplier: 1, inverse: null, dailyReset: null, coveredCall: null, activelyManaged: null,
  };
  await store.save(update);
  const loaded = await store.getByTicker("VOO");
  assert.equal(loaded?.structure.leverageMultiplier, 1);
  assert.equal(loaded?.structure.inverse, null);
  assert.equal(loaded?.structure.coveredCall, null);
});

test("a new Alpha ETF profile removes only the legacy unformatted Alpha sector rows", async () => {
  const database = new DatabaseSync(":memory:");
  const store = new D1FundProfileStore(new SQLiteD1Adapter(database) as never);
  const legacy = fact("legacy-alpha-sector", "INFORMATION TECHNOLOGY: 0.189");
  legacy.category = "sector_exposure";
  legacy.factKey = "allocation_information-technology";
  legacy.sourceType = "structured_provider";
  legacy.sourceUrl = "https://www.alphavantage.co/documentation/#etf-profile";
  legacy.evidenceText = "Alpha Vantage structured profile sector allocation: INFORMATION TECHNOLOGY: 0.189";
  const userFact = fact("user-strategy", "Memory-focused companies");
  await store.save(profile([legacy, userFact], []));

  const normalized = fact("normalized-alpha-sector", "INFORMATION TECHNOLOGY: 18.9%");
  normalized.category = "sector_exposure";
  normalized.factKey = "allocation_information-technology";
  normalized.sourceType = "structured_provider";
  normalized.sourceUrl = "https://www.alphavantage.co/documentation/#etf-profile";
  normalized.evidenceText = "Alpha Vantage structured profile sector allocation: INFORMATION TECHNOLOGY: 18.9%";
  const alphaHolding = holding("alpha-mu", 12);
  alphaHolding.constituentTicker = "MU";
  alphaHolding.constituentName = "Micron Technology";
  alphaHolding.sourceType = "structured_provider";
  alphaHolding.sourceUrl = "https://www.alphavantage.co/documentation/#etf-profile";
  alphaHolding.evidenceText = "Alpha Vantage ETF_PROFILE holding: MU | Micron Technology | weight 12%";
  await store.save(profile([normalized], [alphaHolding]));

  const loaded = await store.getByTicker("VOO");
  assert.equal(loaded?.facts.some((item) => item.id === "legacy-alpha-sector"), false);
  assert.equal(loaded?.facts.some((item) => item.id === "normalized-alpha-sector"), true);
  assert.equal(loaded?.facts.some((item) => item.id === "user-strategy"), true);
  assert.equal(loaded?.holdings.some((item) => item.id === "alpha-mu"), true);
});
