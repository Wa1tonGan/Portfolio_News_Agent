import type { CompanyFact, CompanyProfile } from "./company-profile-contracts.ts";
import { mergeCompanyProfiles, validateCompanyProfile } from "./company-profile-contracts.ts";

type D1PreparedStatementLike = {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
};

export type D1DatabaseLike = {
  prepare(sql: string): D1PreparedStatementLike;
  batch(statements: D1PreparedStatementLike[]): Promise<unknown[]>;
};

type CompanyProfileRow = {
  id: string;
  ticker: string;
  company_name: string;
  created_at: string;
  updated_at: string;
  last_reviewed_at: string;
};

type CompanyFactRow = {
  id: string;
  profile_id: string;
  category: CompanyFact["category"];
  fact_key: string;
  value: string;
  status: CompanyFact["status"];
  source_type: CompanyFact["sourceType"];
  source_url: string | null;
  evidence_text: string;
  last_verification_date: string;
  created_at: string;
  updated_at: string;
};

export interface CompanyProfileStore {
  getByTicker(ticker: string): Promise<CompanyProfile | null>;
  save(profile: CompanyProfile): Promise<CompanyProfile>;
}

export class D1CompanyProfileStore implements CompanyProfileStore {
  private initialized = false;
  private readonly database: D1DatabaseLike;

  constructor(database: D1DatabaseLike) {
    this.database = database;
  }

  private async ensureSchema() {
    if (this.initialized) return;
    await this.database.batch([
      this.database.prepare(`CREATE TABLE IF NOT EXISTS company_profiles (
        id TEXT PRIMARY KEY NOT NULL,
        ticker TEXT NOT NULL UNIQUE,
        company_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_reviewed_at TEXT NOT NULL
      )`),
      this.database.prepare(`CREATE TABLE IF NOT EXISTS company_facts (
        id TEXT PRIMARY KEY NOT NULL,
        profile_id TEXT NOT NULL REFERENCES company_profiles(id) ON DELETE CASCADE,
        category TEXT NOT NULL,
        fact_key TEXT NOT NULL,
        value TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('verified', 'unverified')),
        source_type TEXT NOT NULL,
        source_url TEXT,
        evidence_text TEXT NOT NULL,
        last_verification_date TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`),
      this.database.prepare("CREATE INDEX IF NOT EXISTS company_facts_profile_idx ON company_facts(profile_id)"),
      this.database.prepare("CREATE INDEX IF NOT EXISTS company_facts_lookup_idx ON company_facts(profile_id, category, fact_key)"),
    ]);
    this.initialized = true;
  }

  async getByTicker(rawTicker: string): Promise<CompanyProfile | null> {
    await this.ensureSchema();
    const ticker = rawTicker.trim().toUpperCase();
    const profile = await this.database.prepare(
      "SELECT id, ticker, company_name, created_at, updated_at, last_reviewed_at FROM company_profiles WHERE ticker = ? LIMIT 1"
    ).bind(ticker).first<CompanyProfileRow>();
    if (!profile) return null;
    const rows = await this.database.prepare(
      "SELECT id, profile_id, category, fact_key, value, status, source_type, source_url, evidence_text, last_verification_date, created_at, updated_at FROM company_facts WHERE profile_id = ? ORDER BY category, fact_key, id"
    ).bind(profile.id).all<CompanyFactRow>();
    return {
      id: profile.id,
      ticker: profile.ticker,
      companyName: profile.company_name,
      facts: rows.results.map((fact) => ({
        id: fact.id,
        category: fact.category,
        factKey: fact.fact_key,
        value: fact.value,
        status: fact.status,
        sourceType: fact.source_type,
        sourceUrl: fact.source_url,
        evidenceText: fact.evidence_text,
        lastVerificationDate: fact.last_verification_date,
        createdAt: fact.created_at,
        updatedAt: fact.updated_at,
      })),
      createdAt: profile.created_at,
      updatedAt: profile.updated_at,
      lastReviewedAt: profile.last_reviewed_at,
    };
  }

  async list(limit = 100): Promise<CompanyProfile[]> {
    await this.ensureSchema();
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = await this.database.prepare(
      "SELECT ticker FROM company_profiles ORDER BY ticker LIMIT ?"
    ).bind(safeLimit).all<{ ticker: string }>();
    const profiles = await Promise.all(rows.results.map((row) => this.getByTicker(row.ticker)));
    return profiles.filter((profile): profile is CompanyProfile => Boolean(profile));
  }

  async save(incoming: CompanyProfile): Promise<CompanyProfile> {
    await this.ensureSchema();
    const validation = validateCompanyProfile(incoming);
    if (!validation.valid) throw new Error(`Invalid company profile: ${validation.errors.join(" ")}`);
    const existing = await this.getByTicker(incoming.ticker);
    const merged = mergeCompanyProfiles(existing, incoming);
    const statements: D1PreparedStatementLike[] = [
      this.database.prepare(`INSERT INTO company_profiles (id, ticker, company_name, created_at, updated_at, last_reviewed_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(ticker) DO UPDATE SET company_name = excluded.company_name, updated_at = excluded.updated_at, last_reviewed_at = excluded.last_reviewed_at`)
        .bind(merged.id, merged.ticker, merged.companyName, merged.createdAt, merged.updatedAt, merged.lastReviewedAt),
    ];
    const existingIds = new Set(existing?.facts.map((fact) => fact.id) ?? []);
    merged.facts.filter((fact) => !existingIds.has(fact.id)).forEach((fact) => {
      statements.push(this.database.prepare(`INSERT OR IGNORE INTO company_facts
        (id, profile_id, category, fact_key, value, status, source_type, source_url, evidence_text, last_verification_date, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(fact.id, merged.id, fact.category, fact.factKey, fact.value, fact.status, fact.sourceType, fact.sourceUrl,
          fact.evidenceText, fact.lastVerificationDate, fact.createdAt, fact.updatedAt));
    });
    await this.database.batch(statements);
    return (await this.getByTicker(merged.ticker))!;
  }
}
