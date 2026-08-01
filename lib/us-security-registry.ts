import type { D1DatabaseLike } from "./company-profile-store.ts";

export const usSecurityTypes = ["stock", "adr", "reit", "etf", "preferred", "closed_end_fund", "other"] as const;
export type UsSecurityType = typeof usSecurityTypes[number];

export type UsSecurity = {
  symbol: string;
  securityName: string;
  exchangeCode: string;
  exchangeName: string;
  securityType: UsSecurityType;
  isEtf: boolean;
  sourceDataset: "nasdaqlisted" | "otherlisted";
  sourceUpdatedAt: string;
  cachedAt: string;
};

export type SecurityRegistryStatus = {
  total: number;
  lastRefreshAt: string | null;
  sourceUpdatedAt: string | null;
  stale: boolean;
  refreshed: boolean;
  warning: string | null;
};

const NASDAQ_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt";
const OTHER_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt";
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_DIRECTORY_BYTES = 3_000_000;
const MAX_SECURITIES = 25_000;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type RegistryRow = UsSecurity & { nasdaqSymbol: string; cqsSymbol: string; refreshId: string };
type MetadataRow = { last_refresh_at: string; source_updated_at: string };

export class UsSecurityRegistryError extends Error {
  readonly code: "fetch_failed" | "timeout" | "invalid_source" | "not_found";
  constructor(code: UsSecurityRegistryError["code"], message: string) {
    super(message);
    this.name = "UsSecurityRegistryError";
    this.code = code;
  }
}

function cleanCell(value: string, max = 300) {
  return value.trim().replace(/\s+/g, " ").slice(0, max);
}

function exchangeName(code: string, marketCategory = "") {
  if (code === "NASDAQ") {
    if (marketCategory === "Q") return "Nasdaq Global Select Market";
    if (marketCategory === "G") return "Nasdaq Global Market";
    if (marketCategory === "S") return "Nasdaq Capital Market";
    return "Nasdaq";
  }
  return ({ A: "NYSE American", N: "New York Stock Exchange", P: "NYSE Arca", Z: "Cboe BZX", V: "Investors Exchange" } as Record<string, string>)[code] ?? code;
}

function classifySecurity(name: string, isEtf: boolean): UsSecurityType {
  if (isEtf) return "etf";
  const lower = name.toLocaleLowerCase();
  if (/american deposit(?:ary|ory)|\bads\b|\badr\b/.test(lower)) return "adr";
  if (/real estate investment trust|\breit\b|realty trust/.test(lower)) return "reit";
  if (/closed[- ]end|closed end fund/.test(lower)) return "closed_end_fund";
  if (/preferred|preference share|depositary shares.*preferred/.test(lower)) return "preferred";
  if (/\bwarrant|\bright(?:s)?\b|\bunit(?:s)?\b|\bnote(?:s)?\b|\bdebenture|\bbond\b/.test(lower)) return "other";
  return "stock";
}

function parseSourceTimestamp(value: string) {
  const match = value.match(/File Creation Time:\s*(\d{2})(\d{2})(\d{4})(\d{2}):(\d{2})/i);
  if (!match) return null;
  const [, month, day, year, hour, minute] = match;
  const wallClockUtc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  let instant = wallClockUtc;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(instant));
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value ?? 0);
    const representedAsUtc = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"));
    instant = wallClockUtc - (representedAsUtc - instant);
  }
  const parsed = new Date(instant);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function parseNasdaqDirectory(source: "nasdaqlisted" | "otherlisted", body: string, cachedAt: string, refreshId: string) {
  const lines = body.split(/\r?\n/).filter((line) => line.trim());
  const expectedHeader = source === "nasdaqlisted" ? "Symbol|Security Name|" : "ACT Symbol|Security Name|Exchange|";
  if (!lines[0]?.startsWith(expectedHeader)) throw new UsSecurityRegistryError("invalid_source", `Nasdaq ${source} returned an unexpected header.`);
  const footer = lines.findLast((line) => line.startsWith("File Creation Time:")) ?? "";
  const sourceUpdatedAt = parseSourceTimestamp(footer);
  if (!sourceUpdatedAt) throw new UsSecurityRegistryError("invalid_source", `Nasdaq ${source} did not include a valid creation time.`);
  const rows: RegistryRow[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith("File Creation Time:")) continue;
    const fields = line.split("|");
    if (source === "nasdaqlisted") {
      if (fields.length < 8 || fields[3] !== "N") continue;
      const symbol = cleanCell(fields[0], 30).toUpperCase();
      const securityName = cleanCell(fields[1]);
      const isEtf = fields[6] === "Y";
      if (!symbol || !securityName) continue;
      rows.push({
        symbol, securityName, exchangeCode: "NASDAQ", exchangeName: exchangeName("NASDAQ", fields[2]),
        securityType: classifySecurity(securityName, isEtf), isEtf, sourceDataset: source,
        sourceUpdatedAt, cachedAt, nasdaqSymbol: symbol, cqsSymbol: symbol, refreshId,
      });
    } else {
      if (fields.length < 8 || fields[6] !== "N") continue;
      const symbol = cleanCell(fields[0], 30).toUpperCase();
      const securityName = cleanCell(fields[1]);
      const isEtf = fields[4] === "Y";
      if (!symbol || !securityName) continue;
      rows.push({
        symbol, securityName, exchangeCode: cleanCell(fields[2], 10), exchangeName: exchangeName(fields[2]),
        securityType: classifySecurity(securityName, isEtf), isEtf, sourceDataset: source,
        sourceUpdatedAt, cachedAt, cqsSymbol: cleanCell(fields[3], 30).toUpperCase(),
        nasdaqSymbol: cleanCell(fields[7], 30).toUpperCase(), refreshId,
      });
    }
  }
  if (!rows.length || rows.length > MAX_SECURITIES) throw new UsSecurityRegistryError("invalid_source", `Nasdaq ${source} returned an invalid number of securities.`);
  return { rows, sourceUpdatedAt };
}

async function readBoundedResponse(response: Response) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_DIRECTORY_BYTES) throw new UsSecurityRegistryError("invalid_source", "Nasdaq directory response exceeded the size limit.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let result = "";
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > MAX_DIRECTORY_BYTES) {
      await reader.cancel();
      throw new UsSecurityRegistryError("invalid_source", "Nasdaq directory response exceeded the size limit.");
    }
    result += decoder.decode(part.value, { stream: true });
  }
  return result + decoder.decode();
}

async function fetchDirectory(url: string, fetcher: FetchLike, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, {
      method: "GET", redirect: "manual", signal: controller.signal,
      headers: { Accept: "text/plain", "User-Agent": "portfolio-news-impact-agent/0.1 local-noncommercial" },
    });
    if (response.status >= 300 && response.status < 400) {
      throw new UsSecurityRegistryError("invalid_source", "Nasdaq directory unexpectedly redirected.");
    }
    if (!response.ok) throw new UsSecurityRegistryError("fetch_failed", `Nasdaq directory returned HTTP ${response.status}.`);
    const contentType = (response.headers.get("content-type") ?? "").toLocaleLowerCase();
    if (contentType && !contentType.includes("text/plain") && !contentType.includes("octet-stream")) {
      throw new UsSecurityRegistryError("invalid_source", "Nasdaq directory returned an unsupported content type.");
    }
    return await readBoundedResponse(response);
  } catch (error) {
    if (error instanceof UsSecurityRegistryError) throw error;
    if (controller.signal.aborted || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))) {
      throw new UsSecurityRegistryError("timeout", "Nasdaq directory request timed out.");
    }
    throw new UsSecurityRegistryError("fetch_failed", "Nasdaq directory request failed.");
  } finally {
    clearTimeout(timer);
  }
}

function rowToSecurity(row: Record<string, unknown>): UsSecurity {
  return {
    symbol: String(row.symbol), securityName: String(row.security_name), exchangeCode: String(row.exchange_code),
    exchangeName: String(row.exchange_name), securityType: String(row.security_type) as UsSecurityType,
    isEtf: Number(row.is_etf) === 1, sourceDataset: String(row.source_dataset) as UsSecurity["sourceDataset"],
    sourceUpdatedAt: String(row.source_updated_at), cachedAt: String(row.cached_at),
  };
}

export class D1UsSecurityRegistry {
  private initialized = false;
  private readonly database: D1DatabaseLike;
  private readonly fetcher: FetchLike;
  private readonly maxAgeMs: number;
  private readonly requestTimeoutMs: number;

  constructor(database: D1DatabaseLike, options: { fetcher?: FetchLike; maxAgeMs?: number; requestTimeoutMs?: number } = {}) {
    this.database = database;
    this.fetcher = options.fetcher ?? fetch;
    this.maxAgeMs = Math.max(60_000, options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
    this.requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? 20_000);
  }

  private async ensureSchema() {
    if (this.initialized) return;
    await this.database.batch([
      this.database.prepare(`CREATE TABLE IF NOT EXISTS us_securities (
        symbol TEXT PRIMARY KEY NOT NULL, nasdaq_symbol TEXT NOT NULL, cqs_symbol TEXT NOT NULL,
        security_name TEXT NOT NULL, exchange_code TEXT NOT NULL, exchange_name TEXT NOT NULL,
        security_type TEXT NOT NULL, is_etf INTEGER NOT NULL, source_dataset TEXT NOT NULL,
        source_updated_at TEXT NOT NULL, cached_at TEXT NOT NULL, refresh_id TEXT NOT NULL
      )`),
      this.database.prepare("CREATE INDEX IF NOT EXISTS us_securities_lookup_idx ON us_securities(nasdaq_symbol, cqs_symbol)"),
      this.database.prepare("CREATE INDEX IF NOT EXISTS us_securities_type_idx ON us_securities(security_type)"),
      this.database.prepare(`CREATE TABLE IF NOT EXISTS security_registry_metadata (
        registry_key TEXT PRIMARY KEY NOT NULL, last_refresh_at TEXT NOT NULL, source_updated_at TEXT NOT NULL
      )`),
    ]);
    this.initialized = true;
  }

  private async count() {
    await this.ensureSchema();
    const row = await this.database.prepare("SELECT COUNT(*) AS total FROM us_securities").first<{ total: number }>();
    return Number(row?.total ?? 0);
  }

  private async metadata() {
    await this.ensureSchema();
    return this.database.prepare("SELECT last_refresh_at, source_updated_at FROM security_registry_metadata WHERE registry_key = 'nasdaq-us' LIMIT 1").first<MetadataRow>();
  }

  async refresh() {
    await this.ensureSchema();
    const cachedAt = new Date().toISOString();
    const refreshId = crypto.randomUUID();
    const [nasdaqBody, otherBody] = await Promise.all([
      fetchDirectory(NASDAQ_LISTED_URL, this.fetcher, this.requestTimeoutMs),
      fetchDirectory(OTHER_LISTED_URL, this.fetcher, this.requestTimeoutMs),
    ]);
    const nasdaq = parseNasdaqDirectory("nasdaqlisted", nasdaqBody, cachedAt, refreshId);
    const other = parseNasdaqDirectory("otherlisted", otherBody, cachedAt, refreshId);
    const rows = [...nasdaq.rows, ...other.rows];
    if (!rows.length || rows.length > MAX_SECURITIES) throw new UsSecurityRegistryError("invalid_source", "Combined Nasdaq registry size is invalid.");
    for (let index = 0; index < rows.length; index += 100) {
      const statements = rows.slice(index, index + 100).map((row) => this.database.prepare(`INSERT INTO us_securities
        (symbol, nasdaq_symbol, cqs_symbol, security_name, exchange_code, exchange_name, security_type, is_etf, source_dataset, source_updated_at, cached_at, refresh_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol) DO UPDATE SET nasdaq_symbol=excluded.nasdaq_symbol, cqs_symbol=excluded.cqs_symbol,
        security_name=excluded.security_name, exchange_code=excluded.exchange_code, exchange_name=excluded.exchange_name,
        security_type=excluded.security_type, is_etf=excluded.is_etf, source_dataset=excluded.source_dataset,
        source_updated_at=excluded.source_updated_at, cached_at=excluded.cached_at, refresh_id=excluded.refresh_id`)
        .bind(row.symbol, row.nasdaqSymbol, row.cqsSymbol, row.securityName, row.exchangeCode, row.exchangeName,
          row.securityType, row.isEtf ? 1 : 0, row.sourceDataset, row.sourceUpdatedAt, row.cachedAt, row.refreshId));
      await this.database.batch(statements);
    }
    const sourceUpdatedAt = [nasdaq.sourceUpdatedAt, other.sourceUpdatedAt].sort().at(-1)!;
    await this.database.batch([
      this.database.prepare("DELETE FROM us_securities WHERE refresh_id <> ?").bind(refreshId),
      this.database.prepare(`INSERT INTO security_registry_metadata (registry_key, last_refresh_at, source_updated_at)
        VALUES ('nasdaq-us', ?, ?) ON CONFLICT(registry_key) DO UPDATE SET
        last_refresh_at=excluded.last_refresh_at, source_updated_at=excluded.source_updated_at`).bind(cachedAt, sourceUpdatedAt),
    ]);
    return { total: rows.length, lastRefreshAt: cachedAt, sourceUpdatedAt };
  }

  async ensureFresh(): Promise<SecurityRegistryStatus> {
    await this.ensureSchema();
    const [metadata, total] = await Promise.all([this.metadata(), this.count()]);
    const fresh = metadata && total > 0 && Date.now() - Date.parse(metadata.last_refresh_at) <= this.maxAgeMs;
    if (fresh) return { total, lastRefreshAt: metadata.last_refresh_at, sourceUpdatedAt: metadata.source_updated_at, stale: false, refreshed: false, warning: null };
    try {
      const refreshed = await this.refresh();
      return { ...refreshed, stale: false, refreshed: true, warning: null };
    } catch (error) {
      if (total > 0 && metadata) {
        return {
          total, lastRefreshAt: metadata.last_refresh_at, sourceUpdatedAt: metadata.source_updated_at,
          stale: true, refreshed: false, warning: error instanceof Error ? error.message : "Registry refresh failed.",
        };
      }
      throw error;
    }
  }

  async lookup(rawSymbols: string[]) {
    const status = await this.ensureFresh();
    const unique = [...new Set(rawSymbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))].slice(0, 100);
    const results = await Promise.all(unique.map(async (symbol) => {
      const row = await this.database.prepare(`SELECT symbol, security_name, exchange_code, exchange_name, security_type,
        is_etf, source_dataset, source_updated_at, cached_at FROM us_securities
        WHERE symbol = ? OR nasdaq_symbol = ? OR cqs_symbol = ? LIMIT 1`).bind(symbol, symbol, symbol).first<Record<string, unknown>>();
      return row ? rowToSecurity(row) : null;
    }));
    return {
      status,
      matches: unique.flatMap((inputSymbol, index) => results[index] ? [{ inputSymbol, security: results[index] as UsSecurity }] : []),
      securities: results.filter((item): item is UsSecurity => Boolean(item)),
      missingSymbols: unique.filter((symbol, index) => !results[index]),
    };
  }

  async inspect() {
    await this.ensureSchema();
    const [metadata, totalRow, typeRows] = await Promise.all([
      this.metadata(),
      this.database.prepare("SELECT COUNT(*) AS total FROM us_securities").first<{ total: number }>(),
      this.database.prepare("SELECT security_type, COUNT(*) AS total FROM us_securities GROUP BY security_type ORDER BY security_type").all<{ security_type: UsSecurityType; total: number }>(),
    ]);
    return {
      total: Number(totalRow?.total ?? 0), lastRefreshAt: metadata?.last_refresh_at ?? null,
      sourceUpdatedAt: metadata?.source_updated_at ?? null,
      types: typeRows.results.map((row) => ({ securityType: row.security_type, total: Number(row.total) })),
    };
  }
}
