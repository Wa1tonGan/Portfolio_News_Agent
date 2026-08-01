type FetchLike = typeof fetch;

export type AlphaVantageFunction = "OVERVIEW" | "ETF_PROFILE";

export type AlphaVantageAttempt = {
  status: "skipped_local_cache" | "not_configured" | "success" | "insufficient" | "failed";
  endpoint: AlphaVantageFunction | null;
  apiCalls: number;
  factsAdded: number;
  errorCode: AlphaVantageError["code"] | null;
  message: string | null;
};

export type AlphaVantageResponseSummary = {
  endpoint: AlphaVantageFunction;
  fieldNames: string[];
  usableFields: string[];
  sectorCount: number;
  holdingCount: number;
  readyForBaseline: boolean;
  requiresComplexFundResearch: boolean;
};

export class AlphaVantageError extends Error {
  readonly code: "not_configured" | "timeout" | "authentication" | "rate_limit" | "invalid_response" | "request_failed";
  constructor(code: AlphaVantageError["code"], message: string) {
    super(message);
    this.name = "AlphaVantageError";
    this.code = code;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function present(value: unknown) {
  return (typeof value === "string" && Boolean(value.trim()))
    || (typeof value === "number" && Number.isFinite(value))
    || typeof value === "boolean";
}

function positiveFlag(value: unknown) {
  return value === true
    || value === 1
    || (typeof value === "string" && /^(?:true|yes|y|1|leveraged)$/i.test(value.trim()));
}

function safeNetworkDetail(error: unknown, apiKey: string) {
  const record = isObject(error) ? error : null;
  const cause = record && isObject(record.cause) ? record.cause : null;
  const raw = [
    error instanceof Error ? error.name : "",
    error instanceof Error ? error.message : "",
    typeof cause?.code === "string" ? cause.code : "",
    typeof cause?.message === "string" ? cause.message : "",
  ].filter(Boolean).join(": ");
  return raw
    .replaceAll(apiKey, "[redacted]")
    .replace(/([?&]apikey=)[^&\s)]+/gi, "$1[redacted]")
    .slice(0, 240);
}

export function summarizeAlphaVantageResponse(
  endpoint: AlphaVantageFunction,
  response: Record<string, unknown>,
): AlphaVantageResponseSummary {
  const fieldNames = Object.keys(response).slice(0, 50);
  if (endpoint === "OVERVIEW") {
    const expected = ["Symbol", "Name", "Description", "Exchange", "Country", "Sector", "Industry", "OfficialSite"];
    const usableFields = expected.filter((key) => present(response[key]));
    return {
      endpoint,
      fieldNames,
      usableFields,
      sectorCount: 0,
      holdingCount: 0,
      readyForBaseline: ["Sector", "Industry", "Description"].every((key) => usableFields.includes(key)),
      requiresComplexFundResearch: false,
    };
  }
  const sectors = Array.isArray(response.sectors) ? response.sectors : [];
  const holdings = Array.isArray(response.holdings) ? response.holdings : [];
  const expected = ["net_assets", "net_expense_ratio", "portfolio_turnover", "dividend_yield", "inception_date", "leveraged"];
  const usableFields = expected.filter((key) => present(response[key]));
  const requiresComplexFundResearch = positiveFlag(response.leveraged);
  const hasNature = ["benchmark", "trackingIndex", "tracking_index", "index", "description", "investmentStrategy", "investment_strategy"]
    .some((key) => present(response[key]))
    || holdings.length >= 3;
  return {
    endpoint,
    fieldNames,
    usableFields,
    sectorCount: sectors.length,
    holdingCount: holdings.length,
    readyForBaseline: (sectors.length > 0 || holdings.length > 0) && hasNature && !requiresComplexFundResearch,
    requiresComplexFundResearch,
  };
}

async function readLimitedJson(response: Response, maxBytes: number) {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new AlphaVantageError("invalid_response", "Alpha Vantage returned an oversized profile response.");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (text.length > maxBytes) throw new AlphaVantageError("invalid_response", "Alpha Vantage returned an oversized profile response.");
    return JSON.parse(text) as unknown;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new AlphaVantageError("invalid_response", "Alpha Vantage returned an oversized profile response.");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  chunks.forEach((chunk) => {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return JSON.parse(new TextDecoder().decode(combined)) as unknown;
}

export class AlphaVantageClient {
  private readonly apiKey: string;
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: {
    apiKey?: string;
    fetcher?: FetchLike;
    timeoutMs?: number;
    maxResponseBytes?: number;
  } = {}) {
    this.apiKey = (options.apiKey ?? process.env.ALPHA_VANTAGE_API_KEY ?? "").trim();
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = Math.max(1_000, Math.min(30_000, options.timeoutMs ?? 15_000));
    this.maxResponseBytes = Math.max(10_000, Math.min(3_000_000, options.maxResponseBytes ?? 2_000_000));
  }

  async request(functionName: AlphaVantageFunction, rawTicker: string): Promise<Record<string, unknown> | null> {
    if (!this.apiKey) {
      throw new AlphaVantageError("not_configured", "Alpha Vantage is not configured.");
    }
    const ticker = rawTicker.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9._-]{0,29}$/.test(ticker)) {
      throw new AlphaVantageError("request_failed", "Alpha Vantage requires a valid ticker.");
    }
    const url = new URL("https://www.alphavantage.co/query");
    url.searchParams.set("function", functionName);
    url.searchParams.set("symbol", ticker);
    url.searchParams.set("apikey", this.apiKey);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(url.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (response.status === 401 || response.status === 403) {
        throw new AlphaVantageError("authentication", "Alpha Vantage rejected the configured API key.");
      }
      if (response.status === 429) {
        throw new AlphaVantageError("rate_limit", "Alpha Vantage rate limit was reached.");
      }
      if (!response.ok) {
        throw new AlphaVantageError("request_failed", `Alpha Vantage returned HTTP ${response.status}.`);
      }
      const contentType = (response.headers.get("content-type") ?? "").toLocaleLowerCase();
      if (!contentType.includes("application/json")) {
        throw new AlphaVantageError("invalid_response", "Alpha Vantage returned a non-JSON profile response.");
      }
      let parsed: unknown;
      try {
        parsed = await readLimitedJson(response, this.maxResponseBytes);
      } catch (error) {
        if (error instanceof AlphaVantageError) throw error;
        throw new AlphaVantageError("invalid_response", "Alpha Vantage returned invalid JSON.");
      }
      if (!isObject(parsed)) throw new AlphaVantageError("invalid_response", "Alpha Vantage returned an invalid profile response.");
      const message = [parsed.Note, parsed.Information, parsed["Error Message"]]
        .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
      if (message) {
        if (/rate|frequency|limit|requests per day|premium/i.test(message)) {
          throw new AlphaVantageError("rate_limit", "Alpha Vantage free-tier limit was reached.");
        }
        if (/api key|apikey|invalid key/i.test(message)) {
          throw new AlphaVantageError("authentication", "Alpha Vantage rejected the configured API key.");
        }
        throw new AlphaVantageError("request_failed", "Alpha Vantage could not return this profile.");
      }
      return Object.keys(parsed).length ? parsed : null;
    } catch (error) {
      if (error instanceof AlphaVantageError) throw error;
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw new AlphaVantageError("timeout", "Alpha Vantage profile request timed out.");
      }
      const detail = safeNetworkDetail(error, this.apiKey);
      throw new AlphaVantageError(
        "request_failed",
        detail ? `Alpha Vantage profile request failed (${detail}).` : "Alpha Vantage profile request failed.",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  getCompanyOverview(ticker: string) {
    return this.request("OVERVIEW", ticker);
  }

  getEtfProfile(ticker: string) {
    return this.request("ETF_PROFILE", ticker);
  }
}
