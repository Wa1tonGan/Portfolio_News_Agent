import type { FundFact, FundHolding, FundProfile } from "./fund-profile-contracts.ts";
import { mergeFundProfiles, validateFundProfile } from "./fund-profile-contracts.ts";
import type { D1DatabaseLike } from "./company-profile-store.ts";

type D1PreparedStatementLike = ReturnType<D1DatabaseLike["prepare"]>;

type FundProfileRow = {
  id: string;
  ticker: string;
  fund_name: string;
  issuer_name: string | null;
  security_type: FundProfile["securityType"];
  leverage_multiplier: number;
  inverse: number;
  daily_reset: number;
  covered_call: number;
  actively_managed: number;
  leverage_known: number;
  inverse_known: number;
  daily_reset_known: number;
  covered_call_known: number;
  actively_managed_known: number;
  created_at: string;
  updated_at: string;
  last_reviewed_at: string;
};

type FundFactRow = {
  id: string;
  profile_id: string;
  category: FundFact["category"];
  fact_key: string;
  value: string;
  status: FundFact["status"];
  source_type: FundFact["sourceType"];
  source_url: string | null;
  evidence_text: string;
  effective_date: string | null;
  last_verification_date: string;
  created_at: string;
  updated_at: string;
};

type FundHoldingRow = {
  id: string;
  profile_id: string;
  constituent_ticker: string | null;
  constituent_name: string;
  weight_percent: number | null;
  country: string | null;
  sector: string | null;
  currency: string | null;
  status: FundHolding["status"];
  source_type: FundHolding["sourceType"];
  source_url: string | null;
  evidence_text: string;
  effective_date: string;
  last_verification_date: string;
  created_at: string;
  updated_at: string;
};

export interface FundProfileStore {
  getByTicker(ticker: string): Promise<FundProfile | null>;
  save(profile: FundProfile): Promise<FundProfile>;
}

function isLegacyAlphaSectorFact(fact: FundFact) {
  return fact.category === "sector_exposure"
    && fact.sourceType === "structured_provider"
    && fact.evidenceText.startsWith("Alpha Vantage structured profile sector allocation:")
    && /:\s*\d+(?:\.\d+)?$/.test(fact.value)
    && !fact.value.includes("%");
}

function hasNormalizedAlphaEtfData(profile: FundProfile) {
  return profile.holdings.some((holding) =>
    holding.sourceType === "structured_provider"
    && holding.evidenceText.startsWith("Alpha Vantage ETF_PROFILE holding:"))
    || profile.facts.some((fact) =>
      fact.category === "sector_exposure"
      && fact.sourceType === "structured_provider"
      && fact.evidenceText.startsWith("Alpha Vantage structured profile sector allocation:")
      && fact.value.includes("%"));
}

export class D1FundProfileStore implements FundProfileStore {
  private initialized = false;
  private readonly database: D1DatabaseLike;

  constructor(database: D1DatabaseLike) {
    this.database = database;
  }

  private async ensureSchema() {
    if (this.initialized) return;
    await this.database.batch([
      this.database.prepare(`CREATE TABLE IF NOT EXISTS fund_profiles (
        id TEXT PRIMARY KEY NOT NULL,
        ticker TEXT NOT NULL UNIQUE,
        fund_name TEXT NOT NULL,
        issuer_name TEXT,
        security_type TEXT NOT NULL CHECK (security_type IN ('etf', 'closed_end_fund')),
        leverage_multiplier REAL NOT NULL,
        inverse INTEGER NOT NULL,
        daily_reset INTEGER NOT NULL,
        covered_call INTEGER NOT NULL,
        actively_managed INTEGER NOT NULL,
        leverage_known INTEGER NOT NULL DEFAULT 0,
        inverse_known INTEGER NOT NULL DEFAULT 0,
        daily_reset_known INTEGER NOT NULL DEFAULT 0,
        covered_call_known INTEGER NOT NULL DEFAULT 0,
        actively_managed_known INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_reviewed_at TEXT NOT NULL
      )`),
      this.database.prepare(`CREATE TABLE IF NOT EXISTS fund_facts (
        id TEXT PRIMARY KEY NOT NULL,
        profile_id TEXT NOT NULL REFERENCES fund_profiles(id) ON DELETE CASCADE,
        category TEXT NOT NULL,
        fact_key TEXT NOT NULL,
        value TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('verified', 'unverified')),
        source_type TEXT NOT NULL,
        source_url TEXT,
        evidence_text TEXT NOT NULL,
        effective_date TEXT,
        last_verification_date TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`),
      this.database.prepare(`CREATE TABLE IF NOT EXISTS fund_holdings (
        id TEXT PRIMARY KEY NOT NULL,
        profile_id TEXT NOT NULL REFERENCES fund_profiles(id) ON DELETE CASCADE,
        constituent_ticker TEXT,
        constituent_name TEXT NOT NULL,
        weight_percent REAL,
        country TEXT,
        sector TEXT,
        currency TEXT,
        status TEXT NOT NULL CHECK (status IN ('verified', 'unverified')),
        source_type TEXT NOT NULL,
        source_url TEXT,
        evidence_text TEXT NOT NULL,
        effective_date TEXT NOT NULL,
        last_verification_date TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`),
      this.database.prepare("CREATE INDEX IF NOT EXISTS fund_facts_profile_idx ON fund_facts(profile_id)"),
      this.database.prepare("CREATE INDEX IF NOT EXISTS fund_facts_lookup_idx ON fund_facts(profile_id, category, fact_key, effective_date)"),
      this.database.prepare("CREATE INDEX IF NOT EXISTS fund_holdings_profile_idx ON fund_holdings(profile_id)"),
      this.database.prepare("CREATE INDEX IF NOT EXISTS fund_holdings_lookup_idx ON fund_holdings(profile_id, constituent_ticker, constituent_name, effective_date)"),
    ]);
    const columns = await this.database.prepare("PRAGMA table_info(fund_profiles)").all<{ name: string }>();
    const existingColumns = new Set(columns.results.map((column) => column.name));
    const compatibilityColumns = [
      ["leverage_known", "INTEGER NOT NULL DEFAULT 0"],
      ["inverse_known", "INTEGER NOT NULL DEFAULT 0"],
      ["daily_reset_known", "INTEGER NOT NULL DEFAULT 0"],
      ["covered_call_known", "INTEGER NOT NULL DEFAULT 0"],
      ["actively_managed_known", "INTEGER NOT NULL DEFAULT 0"],
    ] as const;
    const additions = compatibilityColumns
      .filter(([name]) => !existingColumns.has(name))
      .map(([name, definition]) => this.database.prepare(`ALTER TABLE fund_profiles ADD COLUMN ${name} ${definition}`));
    if (additions.length) {
      await this.database.batch(additions);
      await this.database.batch([
        this.database.prepare(`UPDATE fund_profiles
          SET leverage_known = 1, inverse_known = 1, daily_reset_known = 1, covered_call_known = 1, actively_managed_known = 1
          WHERE EXISTS (
            SELECT 1 FROM fund_facts
            WHERE fund_facts.profile_id = fund_profiles.id AND fund_facts.category = 'fund_structure'
          )`),
      ]);
    }
    this.initialized = true;
  }

  async getByTicker(rawTicker: string): Promise<FundProfile | null> {
    await this.ensureSchema();
    const ticker = rawTicker.trim().toUpperCase();
    const profile = await this.database.prepare(
      `SELECT id, ticker, fund_name, issuer_name, security_type, leverage_multiplier, inverse, daily_reset,
        covered_call, actively_managed, leverage_known, inverse_known, daily_reset_known, covered_call_known,
        actively_managed_known, created_at, updated_at, last_reviewed_at
       FROM fund_profiles WHERE ticker = ? LIMIT 1`
    ).bind(ticker).first<FundProfileRow>();
    if (!profile) return null;
    const [factRows, holdingRows] = await Promise.all([
      this.database.prepare(
        `SELECT id, profile_id, category, fact_key, value, status, source_type, source_url, evidence_text,
          effective_date, last_verification_date, created_at, updated_at
         FROM fund_facts WHERE profile_id = ? ORDER BY category, fact_key, effective_date, id`
      ).bind(profile.id).all<FundFactRow>(),
      this.database.prepare(
        `SELECT id, profile_id, constituent_ticker, constituent_name, weight_percent, country, sector, currency,
          status, source_type, source_url, evidence_text, effective_date, last_verification_date, created_at, updated_at
         FROM fund_holdings WHERE profile_id = ? ORDER BY effective_date DESC, weight_percent DESC, constituent_name, id`
      ).bind(profile.id).all<FundHoldingRow>(),
    ]);
    return {
      id: profile.id,
      ticker: profile.ticker,
      fundName: profile.fund_name,
      issuerName: profile.issuer_name,
      securityType: profile.security_type,
      structure: {
        leverageMultiplier: profile.leverage_known ? profile.leverage_multiplier : null,
        inverse: profile.inverse_known ? Boolean(profile.inverse) : null,
        dailyReset: profile.daily_reset_known ? Boolean(profile.daily_reset) : null,
        coveredCall: profile.covered_call_known ? Boolean(profile.covered_call) : null,
        activelyManaged: profile.actively_managed_known ? Boolean(profile.actively_managed) : null,
      },
      facts: factRows.results.map((fact) => ({
        id: fact.id,
        category: fact.category,
        factKey: fact.fact_key,
        value: fact.value,
        status: fact.status,
        sourceType: fact.source_type,
        sourceUrl: fact.source_url,
        evidenceText: fact.evidence_text,
        effectiveDate: fact.effective_date,
        lastVerificationDate: fact.last_verification_date,
        createdAt: fact.created_at,
        updatedAt: fact.updated_at,
      })),
      holdings: holdingRows.results.map((holding) => ({
        id: holding.id,
        constituentTicker: holding.constituent_ticker,
        constituentName: holding.constituent_name,
        weightPercent: holding.weight_percent,
        country: holding.country,
        sector: holding.sector,
        currency: holding.currency,
        status: holding.status,
        sourceType: holding.source_type,
        sourceUrl: holding.source_url,
        evidenceText: holding.evidence_text,
        effectiveDate: holding.effective_date,
        lastVerificationDate: holding.last_verification_date,
        createdAt: holding.created_at,
        updatedAt: holding.updated_at,
      })),
      createdAt: profile.created_at,
      updatedAt: profile.updated_at,
      lastReviewedAt: profile.last_reviewed_at,
    };
  }

  async list(limit = 100): Promise<FundProfile[]> {
    await this.ensureSchema();
    const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
    const rows = await this.database.prepare("SELECT ticker FROM fund_profiles ORDER BY ticker LIMIT ?")
      .bind(safeLimit).all<{ ticker: string }>();
    const profiles = await Promise.all(rows.results.map((row) => this.getByTicker(row.ticker)));
    return profiles.filter((profile): profile is FundProfile => Boolean(profile));
  }

  async save(incoming: FundProfile): Promise<FundProfile> {
    await this.ensureSchema();
    const validation = validateFundProfile(incoming);
    if (!validation.valid) throw new Error(`Invalid fund profile: ${validation.errors.join(" ")}`);
    const storedExisting = await this.getByTicker(incoming.ticker);
    const migratedLegacyFactIds = storedExisting && hasNormalizedAlphaEtfData(incoming)
      ? storedExisting.facts.filter(isLegacyAlphaSectorFact).map((fact) => fact.id)
      : [];
    const existing = storedExisting && migratedLegacyFactIds.length
      ? {
        ...storedExisting,
        facts: storedExisting.facts.filter((fact) => !migratedLegacyFactIds.includes(fact.id)),
      }
      : storedExisting;
    const merged = mergeFundProfiles(existing, incoming);
    const statements: D1PreparedStatementLike[] = migratedLegacyFactIds.map((id) =>
      this.database.prepare("DELETE FROM fund_facts WHERE id = ? AND profile_id = ?").bind(id, merged.id));
    statements.push(
      this.database.prepare(`INSERT INTO fund_profiles
        (id, ticker, fund_name, issuer_name, security_type, leverage_multiplier, inverse, daily_reset, covered_call,
         actively_managed, leverage_known, inverse_known, daily_reset_known, covered_call_known,
         actively_managed_known, created_at, updated_at, last_reviewed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ticker) DO UPDATE SET fund_name = excluded.fund_name, issuer_name = excluded.issuer_name,
          leverage_multiplier = excluded.leverage_multiplier, inverse = excluded.inverse, daily_reset = excluded.daily_reset,
          covered_call = excluded.covered_call, actively_managed = excluded.actively_managed,
          leverage_known = excluded.leverage_known, inverse_known = excluded.inverse_known,
          daily_reset_known = excluded.daily_reset_known, covered_call_known = excluded.covered_call_known,
          actively_managed_known = excluded.actively_managed_known,
          updated_at = excluded.updated_at, last_reviewed_at = excluded.last_reviewed_at`)
        .bind(
          merged.id, merged.ticker, merged.fundName, merged.issuerName, merged.securityType,
          merged.structure.leverageMultiplier ?? 1, merged.structure.inverse ? 1 : 0, merged.structure.dailyReset ? 1 : 0,
          merged.structure.coveredCall ? 1 : 0, merged.structure.activelyManaged ? 1 : 0,
          merged.structure.leverageMultiplier === null ? 0 : 1, merged.structure.inverse === null ? 0 : 1,
          merged.structure.dailyReset === null ? 0 : 1, merged.structure.coveredCall === null ? 0 : 1,
          merged.structure.activelyManaged === null ? 0 : 1,
          merged.createdAt, merged.updatedAt, merged.lastReviewedAt,
        ),
    );
    const existingFactIds = new Set(existing?.facts.map((fact) => fact.id) ?? []);
    merged.facts.filter((fact) => !existingFactIds.has(fact.id)).forEach((fact) => {
      statements.push(this.database.prepare(`INSERT OR IGNORE INTO fund_facts
        (id, profile_id, category, fact_key, value, status, source_type, source_url, evidence_text, effective_date,
         last_verification_date, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          fact.id, merged.id, fact.category, fact.factKey, fact.value, fact.status, fact.sourceType,
          fact.sourceUrl, fact.evidenceText, fact.effectiveDate, fact.lastVerificationDate, fact.createdAt, fact.updatedAt,
        ));
    });
    const existingHoldingIds = new Set(existing?.holdings.map((holding) => holding.id) ?? []);
    merged.holdings.filter((holding) => !existingHoldingIds.has(holding.id)).forEach((holding) => {
      statements.push(this.database.prepare(`INSERT OR IGNORE INTO fund_holdings
        (id, profile_id, constituent_ticker, constituent_name, weight_percent, country, sector, currency, status,
         source_type, source_url, evidence_text, effective_date, last_verification_date, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(
          holding.id, merged.id, holding.constituentTicker, holding.constituentName, holding.weightPercent,
          holding.country, holding.sector, holding.currency, holding.status, holding.sourceType, holding.sourceUrl,
          holding.evidenceText, holding.effectiveDate, holding.lastVerificationDate, holding.createdAt, holding.updatedAt,
        ));
    });
    await this.database.batch(statements);
    return (await this.getByTicker(merged.ticker))!;
  }
}
