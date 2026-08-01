import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { D1AnalysisRunStore } from "../lib/analysis-run-store.ts";

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

const portfolio = [{
  ticker: "AAPL",
  companyName: "Apple Inc.",
  currency: "USD",
  portfolioWeight: 100,
}] as const;

const completedResult = {
  generatedAt: "2026-07-28T10:05:00.000Z",
  durationSeconds: 42.5,
  counts: { completedImpacts: 2, technicalFailures: 0 },
} as never;

test("analysis runs and activities survive a new store instance", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const database = new SQLiteD1Adapter(sqlite);
  const store = new D1AnalysisRunStore(database as never);
  await store.createRun("analysis-1234567890-test", [...portfolio]);
  await store.appendActivity("analysis-1234567890-test", 1, {
    id: "activity-1",
    at: "2026-07-28T10:00:00.000Z",
    stage: "micro",
    status: "completed",
    label: "微观关联完成",
    detail: "完成一批分析。",
    model: "qwen3.5:4b",
  });
  await store.completeRun("analysis-1234567890-test", completedResult);

  const reloaded = await new D1AnalysisRunStore(database as never).getById("analysis-1234567890-test");
  assert.equal(reloaded?.status, "completed");
  assert.equal(reloaded?.portfolio[0].ticker, "AAPL");
  assert.equal(reloaded?.activities[0].label, "微观关联完成");
  assert.equal(reloaded?.result?.durationSeconds, 42.5);

  const history = await new D1AnalysisRunStore(database as never).list();
  assert.equal(history[0].completedImpacts, 2);
  assert.equal(history[0].tickers[0], "AAPL");
});

test("an interrupted analysis remains technical and has no financial result", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const database = new SQLiteD1Adapter(sqlite);
  const store = new D1AnalysisRunStore(database as never);
  await store.createRun("analysis-1234567890-sleep", [...portfolio]);
  await store.interruptRun("analysis-1234567890-sleep");

  const interrupted = await store.getById("analysis-1234567890-sleep");
  assert.equal(interrupted?.status, "interrupted");
  assert.equal(interrupted?.result, null);
  assert.match(interrupted?.error ?? "", /中断|睡眠/);
});
