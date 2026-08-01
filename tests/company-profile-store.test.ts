import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { CompanyFact, CompanyProfile } from "../lib/company-profile-contracts.ts";
import { D1CompanyProfileStore } from "../lib/company-profile-store.ts";

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

const timestamp = "2026-07-21T08:00:00.000Z";
function fact(id: string, value: string, status: CompanyFact["status"] = "verified"): CompanyFact {
  return {
    id, category: "sector", factKey: "primary", value, status,
    sourceType: "user_provided", sourceUrl: null, evidenceText: "User-provided local evidence.",
    lastVerificationDate: "2026-07-21", createdAt: timestamp, updatedAt: timestamp,
  };
}
function profile(facts: CompanyFact[]): CompanyProfile {
  return { id: "profile-aapl", ticker: "AAPL", companyName: "Apple Inc.", facts, createdAt: timestamp, updatedAt: timestamp, lastReviewedAt: timestamp };
}

test("D1 profile store saves, reloads, reuses, and preserves a conflicting suggestion", async () => {
  const database = new DatabaseSync(":memory:");
  const store = new D1CompanyProfileStore(new SQLiteD1Adapter(database) as never);
  await store.save(profile([fact("verified-sector", "Technology")]));
  const loaded = await store.getByTicker("aapl");
  assert.equal(loaded?.facts[0].status, "verified");
  await store.save({ ...profile([fact("suggested-sector", "Consumer discretionary", "unverified")]), updatedAt: "2026-07-21T09:00:00.000Z" });
  const reused = await store.getByTicker("AAPL");
  assert.equal(reused?.facts.length, 2);
  assert.equal(reused?.facts.find((item) => item.id === "verified-sector")?.value, "Technology");
  const listed = await store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].ticker, "AAPL");
});
