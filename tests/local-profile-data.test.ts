import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { clearResearchedProfileData } from "../lib/local-profile-data.ts";

class SQLiteStatementAdapter {
  private values: unknown[] = [];
  private readonly database: DatabaseSync;
  private readonly sql: string;
  constructor(database: DatabaseSync, sql: string) {
    this.database = database;
    this.sql = sql;
  }
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

test("clearing researched profiles deletes only profile data and preserves the security directory", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const database = new SQLiteD1Adapter(sqlite);

  // Let the reset helper initialize the profile tables, then seed one row in every deletable table.
  await clearResearchedProfileData(database as never);
  sqlite.exec(`
    CREATE TABLE us_securities (ticker TEXT PRIMARY KEY);
    INSERT INTO us_securities (ticker) VALUES ('AAPL');
    INSERT INTO company_profiles VALUES ('company-aapl', 'AAPL', 'Apple Inc.', 'now', 'now', 'now');
    INSERT INTO company_facts VALUES (
      'company-fact', 'company-aapl', 'sector', 'primary', 'Technology', 'verified',
      'user_provided', NULL, 'Local evidence', '2026-07-24', 'now', 'now'
    );
    INSERT INTO fund_profiles (
      id, ticker, fund_name, issuer_name, security_type, leverage_multiplier, inverse, daily_reset,
      covered_call, actively_managed, leverage_known, inverse_known, daily_reset_known, covered_call_known,
      actively_managed_known, created_at, updated_at, last_reviewed_at
    ) VALUES (
      'fund-voo', 'VOO', 'Vanguard S&P 500 ETF', 'Vanguard', 'etf', 1, 0, 0, 0, 0,
      1, 1, 1, 1, 1, 'now', 'now', 'now'
    );
    INSERT INTO fund_facts VALUES (
      'fund-fact', 'fund-voo', 'strategy', 'primary', 'Tracks the S&P 500', 'verified',
      'user_provided', NULL, 'Local evidence', NULL, '2026-07-24', 'now', 'now'
    );
    INSERT INTO fund_holdings VALUES (
      'fund-holding', 'fund-voo', 'AAPL', 'Apple Inc.', 6.5, 'United States', 'Technology', 'USD',
      'verified', 'user_provided', NULL, 'Local evidence', '2026-07-24', '2026-07-24', 'now', 'now'
    );
  `);

  const deleted = await clearResearchedProfileData(database as never);
  assert.deepEqual(deleted, {
    companyProfiles: 1,
    companyFacts: 1,
    fundProfiles: 1,
    fundFacts: 1,
    fundHoldings: 1,
  });
  for (const table of ["company_profiles", "company_facts", "fund_profiles", "fund_facts", "fund_holdings"]) {
    const row = sqlite.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as { total: number };
    assert.equal(row.total, 0);
  }
  assert.equal((sqlite.prepare("SELECT COUNT(*) AS total FROM us_securities").get() as { total: number }).total, 1);
});
