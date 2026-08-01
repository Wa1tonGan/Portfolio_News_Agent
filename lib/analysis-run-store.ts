import type { AnalysisPipelineResult, PipelineActivity, PortfolioHoldingInput } from "./analysis-pipeline-next.ts";
import type { D1DatabaseLike } from "./company-profile-store.ts";

export type AnalysisRunStatus = "running" | "completed" | "failed" | "interrupted";

type AnalysisRunRow = {
  id: string;
  status: AnalysisRunStatus;
  portfolio_json: string;
  result_json: string | null;
  error_text: string | null;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
};

type AnalysisActivityRow = {
  activity_json: string;
};

export type AnalysisRunRecord = {
  id: string;
  status: AnalysisRunStatus;
  portfolio: PortfolioHoldingInput[];
  result: AnalysisPipelineResult | null;
  activities: PipelineActivity[];
  error: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type AnalysisRunSummary = {
  id: string;
  status: AnalysisRunStatus;
  tickers: string[];
  holdingsCount: number;
  completedImpacts: number;
  technicalFailures: number;
  durationSeconds: number | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
};

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function boundedJson(value: unknown, label: string) {
  const serialized = JSON.stringify(value);
  if (serialized.length > 1_500_000) throw new Error(`${label} is too large to save safely.`);
  return serialized;
}

function rowToSummary(row: AnalysisRunRow): AnalysisRunSummary {
  const portfolio = parseJson<PortfolioHoldingInput[]>(row.portfolio_json, []);
  const result = row.result_json ? parseJson<AnalysisPipelineResult | null>(row.result_json, null) : null;
  return {
    id: row.id,
    status: row.status,
    tickers: portfolio.map((holding) => holding.ticker),
    holdingsCount: portfolio.length,
    completedImpacts: result?.counts.completedImpacts ?? 0,
    technicalFailures: result?.counts.technicalFailures ?? 0,
    durationSeconds: result?.durationSeconds ?? null,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    error: row.error_text,
  };
}

export class D1AnalysisRunStore {
  private initialized = false;
  private readonly database: D1DatabaseLike;

  constructor(database: D1DatabaseLike) {
    this.database = database;
  }

  private async ensureSchema() {
    if (this.initialized) return;
    await this.database.batch([
      this.database.prepare(`CREATE TABLE IF NOT EXISTS analysis_runs (
        id TEXT PRIMARY KEY NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'interrupted')),
        portfolio_json TEXT NOT NULL,
        result_json TEXT,
        error_text TEXT,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      )`),
      this.database.prepare("CREATE INDEX IF NOT EXISTS analysis_runs_started_idx ON analysis_runs(started_at)"),
      this.database.prepare("CREATE INDEX IF NOT EXISTS analysis_runs_status_idx ON analysis_runs(status)"),
      this.database.prepare(`CREATE TABLE IF NOT EXISTS analysis_activities (
        id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        activity_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, sequence)
      )`),
      this.database.prepare("CREATE UNIQUE INDEX IF NOT EXISTS analysis_activities_run_sequence_idx ON analysis_activities(run_id, sequence)"),
    ]);
    this.initialized = true;
  }

  async createRun(id: string, portfolio: PortfolioHoldingInput[]) {
    await this.ensureSchema();
    const now = new Date().toISOString();
    await this.database.batch([
      this.database.prepare(`INSERT INTO analysis_runs
        (id, status, portfolio_json, result_json, error_text, started_at, updated_at, completed_at)
        VALUES (?, 'running', ?, NULL, NULL, ?, ?, NULL)`)
        .bind(id, boundedJson(portfolio, "Portfolio"), now, now),
    ]);
  }

  async appendActivity(runId: string, sequence: number, activity: PipelineActivity) {
    await this.ensureSchema();
    const now = new Date().toISOString();
    await this.database.batch([
      this.database.prepare(`INSERT OR IGNORE INTO analysis_activities
        (id, run_id, sequence, activity_json, created_at) VALUES (?, ?, ?, ?, ?)`)
        .bind(`${runId}:${sequence}`, runId, sequence, boundedJson(activity, "Analysis activity"), now),
      this.database.prepare("UPDATE analysis_runs SET updated_at = ? WHERE id = ? AND status = 'running'")
        .bind(now, runId),
    ]);
  }

  async completeRun(runId: string, result: AnalysisPipelineResult) {
    await this.ensureSchema();
    const now = new Date().toISOString();
    await this.database.batch([
      this.database.prepare(`UPDATE analysis_runs
        SET status = 'completed', result_json = ?, error_text = NULL, updated_at = ?, completed_at = ?
        WHERE id = ?`)
        .bind(boundedJson(result, "Analysis result"), now, now, runId),
    ]);
  }

  async failRun(runId: string, message: string) {
    await this.ensureSchema();
    const now = new Date().toISOString();
    await this.database.batch([
      this.database.prepare(`UPDATE analysis_runs
        SET status = 'failed', error_text = ?, updated_at = ?, completed_at = ?
        WHERE id = ? AND status = 'running'`)
        .bind(message.slice(0, 4_000), now, now, runId),
    ]);
  }

  async interruptRun(runId: string, message = "浏览器连接中断或电脑进入睡眠，分析没有产生最终结果。") {
    await this.ensureSchema();
    const now = new Date().toISOString();
    await this.database.batch([
      this.database.prepare(`UPDATE analysis_runs
        SET status = 'interrupted', error_text = ?, updated_at = ?, completed_at = ?
        WHERE id = ? AND status = 'running'`)
        .bind(message.slice(0, 4_000), now, now, runId),
    ]);
  }

  async markStaleRunsInterrupted(maxIdleMinutes = 30) {
    await this.ensureSchema();
    const cutoff = new Date(Date.now() - Math.max(5, maxIdleMinutes) * 60_000).toISOString();
    const now = new Date().toISOString();
    await this.database.batch([
      this.database.prepare(`UPDATE analysis_runs
        SET status = 'interrupted',
            error_text = COALESCE(error_text, '本地服务或电脑中断，分析没有产生最终结果。'),
            updated_at = ?, completed_at = ?
        WHERE status = 'running' AND updated_at < ?`)
        .bind(now, now, cutoff),
    ]);
  }

  private async getRow(id: string) {
    await this.ensureSchema();
    return this.database.prepare(`SELECT id, status, portfolio_json, result_json, error_text,
      started_at, updated_at, completed_at FROM analysis_runs WHERE id = ? LIMIT 1`)
      .bind(id).first<AnalysisRunRow>();
  }

  async getById(id: string): Promise<AnalysisRunRecord | null> {
    const row = await this.getRow(id);
    if (!row) return null;
    const activityRows = await this.database.prepare(
      "SELECT activity_json FROM analysis_activities WHERE run_id = ? ORDER BY sequence"
    ).bind(id).all<AnalysisActivityRow>();
    return {
      id: row.id,
      status: row.status,
      portfolio: parseJson<PortfolioHoldingInput[]>(row.portfolio_json, []),
      result: row.result_json ? parseJson<AnalysisPipelineResult | null>(row.result_json, null) : null,
      activities: activityRows.results.flatMap((activity) => {
        const parsed = parseJson<PipelineActivity | null>(activity.activity_json, null);
        return parsed ? [parsed] : [];
      }),
      error: row.error_text,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }

  async list(limit = 20): Promise<AnalysisRunSummary[]> {
    await this.markStaleRunsInterrupted();
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = await this.database.prepare(`SELECT id, status, portfolio_json, result_json, error_text,
      started_at, updated_at, completed_at FROM analysis_runs ORDER BY started_at DESC LIMIT ?`)
      .bind(safeLimit).all<AnalysisRunRow>();
    return rows.results.map(rowToSummary);
  }

  async getLatest(): Promise<AnalysisRunRecord | null> {
    await this.markStaleRunsInterrupted();
    const row = await this.database.prepare("SELECT id FROM analysis_runs ORDER BY started_at DESC LIMIT 1")
      .first<{ id: string }>();
    return row ? this.getById(row.id) : null;
  }

  async getLatestCompleted(): Promise<AnalysisRunRecord | null> {
    await this.ensureSchema();
    const row = await this.database.prepare(
      "SELECT id FROM analysis_runs WHERE status = 'completed' ORDER BY started_at DESC LIMIT 1"
    ).first<{ id: string }>();
    return row ? this.getById(row.id) : null;
  }
}
