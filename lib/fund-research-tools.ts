import type { FundFactSourceType } from "./fund-profile-contracts.ts";
import {
  cleanDomain,
  domainMatches,
  extractTavily,
  isObject,
  normalizeOfficialDomains,
  searchTavily,
  validateCompanySourceUrl,
  type FetchLike,
} from "./company-research-tools.ts";

export const fundResearchSearchKinds = ["official", "holdings", "prospectus", "regulator", "index"] as const;
export type FundResearchSearchKind = typeof fundResearchSearchKinds[number];

export type FundSearchRequest = {
  id: string;
  kind: FundResearchSearchKind;
  topic: string;
};

export type FundSearchResult = {
  id: string;
  title: string;
  url: string;
  snippet: string;
  sourceType: FundFactSourceType;
  trusted: boolean;
  relevanceScore?: number;
};

export type FetchedFundSource = FundSearchResult & {
  text: string;
  fetchedAt: string;
};

export type FundResearchToolLimits = {
  maxSearches: number;
  maxSearchResults: number;
  maxPages: number;
  searchTimeoutMs: number;
  pageTimeoutMs: number;
  maxSearchResponseBytes: number;
  maxExtractResponseBytes: number;
  maxExtractedCharactersPerPage: number;
  maxExtractedCharactersTotal: number;
};

const defaultLimits: FundResearchToolLimits = {
  maxSearches: 3,
  maxSearchResults: 20,
  maxPages: 5,
  searchTimeoutMs: 10_000,
  pageTimeoutMs: 12_000,
  maxSearchResponseBytes: 600_000,
  maxExtractResponseBytes: 1_000_000,
  maxExtractedCharactersPerPage: 5_000,
  maxExtractedCharactersTotal: 18_000,
};

const knownIssuerDomains = [
  "vanguard.com",
  "ishares.com",
  "blackrock.com",
  "ssga.com",
  "invesco.com",
  "schwabassetmanagement.com",
  "fidelity.com",
  "jpmorgan.com",
  "globalxetfs.com",
  "proshares.com",
  "direxion.com",
  "vaneck.com",
  "pimco.com",
  "wisdomtree.com",
  "ark-funds.com",
  "dimensional.com",
];

const regulatorDomains = ["sec.gov"];
const exchangeDomains = ["nasdaq.com", "nyse.com", "cboe.com"];
const indexProviderDomains = ["spglobal.com", "msci.com", "lseg.com", "ftserussell.com", "stoxx.com"];

export class FundResearchToolError extends Error {
  readonly code: "invalid_request" | "not_configured" | "blocked_url" | "limit_exceeded";
  constructor(code: FundResearchToolError["code"], message: string) {
    super(message);
    this.name = "FundResearchToolError";
    this.code = code;
  }
}

function cleanText(value: string) {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function validateFundSourceUrl(value: string) {
  try {
    return validateCompanySourceUrl(value);
  } catch (error) {
    throw new FundResearchToolError("blocked_url", error instanceof Error ? error.message : "Fund source URL is blocked.");
  }
}

export function classifyFundSource(
  value: string,
  officialDomains: string[] = [],
  hint = "",
): { sourceType: FundFactSourceType; trusted: boolean } {
  const url = new URL(validateFundSourceUrl(value));
  const host = cleanDomain(url.hostname);
  const pathAndHint = `${url.pathname} ${hint}`.toLocaleLowerCase();
  const suppliedOfficial = normalizeOfficialDomains(officialDomains).some((domain) => domainMatches(host, domain));
  const knownIssuer = knownIssuerDomains.some((domain) => domainMatches(host, domain));
  if (regulatorDomains.some((domain) => domainMatches(host, domain))) {
    return { sourceType: /prospectus|485bpos|497k|497\b/.test(pathAndHint) ? "prospectus" : "regulator", trusted: true };
  }
  if (indexProviderDomains.some((domain) => domainMatches(host, domain))) {
    return { sourceType: "index_provider", trusted: true };
  }
  if (exchangeDomains.some((domain) => domainMatches(host, domain))) {
    return { sourceType: "exchange_announcement", trusted: true };
  }
  if (suppliedOfficial || knownIssuer) {
    if (/holdings?|constituents?|portfolio[-_ ]?data|daily[-_ ]?positions?/.test(pathAndHint)) {
      return { sourceType: "official_holdings", trusted: true };
    }
    if (/prospectus|summary[-_ ]?prospectus|statutory/.test(pathAndHint)) {
      return { sourceType: "prospectus", trusted: true };
    }
    if (/facts?[-_ ]?sheet|fund[-_ ]?facts|product[-_ ]?brief/.test(pathAndHint)) {
      return { sourceType: "official_factsheet", trusted: true };
    }
    return { sourceType: "official_fund_page", trusted: true };
  }
  return { sourceType: "reputable_external", trusted: false };
}

function parseSearchResults(value: unknown, officialDomains: string[]) {
  if (!isObject(value) || !Array.isArray(value.results)) return [];
  const results: Omit<FundSearchResult, "id">[] = [];
  value.results.forEach((item) => {
    if (!isObject(item) || typeof item.url !== "string" || typeof item.title !== "string") return;
    try {
      const url = validateFundSourceUrl(item.url);
      const title = cleanText(item.title).slice(0, 300);
      const source = classifyFundSource(url, officialDomains, title);
      results.push({
        title,
        url,
        snippet: cleanText(typeof item.content === "string" ? item.content : "").slice(0, 600),
        relevanceScore: typeof item.score === "number" && Number.isFinite(item.score)
          ? Math.max(0, Math.min(1, item.score))
          : undefined,
        ...source,
      });
    } catch {
      // Unsafe search results are intentionally omitted.
    }
  });
  return results;
}

function searchSuffix(kind: FundResearchSearchKind) {
  if (kind === "official") return "official fund page factsheet investment objective benchmark strategy exposures";
  if (kind === "holdings") return "official holdings constituents weights portfolio effective date";
  if (kind === "prospectus") return "prospectus investment strategy leverage derivatives daily reset risks";
  if (kind === "regulator") return "SEC filing N-1A 485BPOS 497 fund registration statement";
  return "official index methodology constituents sector country weights";
}

function sourcePriority(sourceType: FundFactSourceType) {
  const order: FundFactSourceType[] = [
    "official_holdings", "official_factsheet", "prospectus", "official_fund_page", "regulator",
    "exchange_announcement", "index_provider", "structured_provider", "reputable_external", "user_provided", "local_document", "model_memory",
  ];
  return order.indexOf(sourceType);
}

function usefulness(result: Pick<FundSearchResult, "title" | "url">) {
  const value = `${result.title} ${result.url}`.toLocaleLowerCase();
  if (/holdings?|facts?[-_ ]?sheet|prospectus|fund[-_ ]?profile|product[-_ ]?page/.test(value)) return 0;
  if (/privacy|terms|cookie|careers|newsroom/.test(value)) return 2;
  return 1;
}

export class ControlledFundResearchTools {
  private readonly fetcher: FetchLike;
  private readonly tavilyApiKey: string;
  readonly limits: FundResearchToolLimits;

  constructor(options: { fetcher?: FetchLike; limits?: Partial<FundResearchToolLimits>; tavilyApiKey?: string } = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.tavilyApiKey = (options.tavilyApiKey ?? process.env.TAVILY_API_KEY ?? "").trim();
    this.limits = { ...defaultLimits, ...options.limits };
  }

  async searchFundSources(args: {
    ticker: string;
    fundName: string;
    requests: FundSearchRequest[];
    officialDomains?: string[];
  }) {
    if (!this.tavilyApiKey) {
      throw new FundResearchToolError("not_configured", "Tavily fund research is not configured. Add TAVILY_API_KEY to .env.local and restart the app.");
    }
    if (!args.requests.length || args.requests.length > this.limits.maxSearches) {
      throw new FundResearchToolError("limit_exceeded", `Fund research requires between 1 and ${this.limits.maxSearches} searches.`);
    }
    const officialDomains = normalizeOfficialDomains(args.officialDomains);
    const collected: Omit<FundSearchResult, "id">[] = [];
    const failures: Array<{ requestId: string; message: string }> = [];
    for (const request of args.requests) {
      const topic = request.topic.trim().replace(/\s+/g, " ");
      if (!request.id.trim() || !fundResearchSearchKinds.includes(request.kind) || !topic || topic.length > 100
        || /https?:|www\.|site:|filetype:|["'`<>\\]/i.test(topic)) {
        throw new FundResearchToolError("invalid_request", "The model requested an invalid fund search.");
      }
      const query = `"${args.fundName.slice(0, 160)}" "${args.ticker.slice(0, 30)}" ${topic} ${searchSuffix(request.kind)}`
        .replace(/\s+/g, " ").trim();
      try {
        const response = await searchTavily(query, this.tavilyApiKey, this.fetcher, {
          timeoutMs: this.limits.searchTimeoutMs,
          maxBytes: this.limits.maxSearchResponseBytes,
          maxResults: this.limits.maxSearchResults,
          ...(request.kind === "official" && officialDomains.length ? { includeDomains: officialDomains } : {}),
          searchDepth: "advanced",
          topic: request.kind === "official" || request.kind === "index" ? "general" : "finance",
        });
        collected.push(...parseSearchResults(response, officialDomains));
      } catch (error) {
        failures.push({ requestId: request.id, message: error instanceof Error ? error.message : "Fund search failed." });
      }
    }
    const unique = new Map<string, Omit<FundSearchResult, "id">>();
    collected.forEach((result) => {
      const existing = unique.get(result.url);
      if (!existing || (result.relevanceScore ?? 0) > (existing.relevanceScore ?? 0)) unique.set(result.url, result);
    });
    const results = [...unique.values()]
      .sort((a, b) => sourcePriority(a.sourceType) - sourcePriority(b.sourceType)
        || usefulness(a) - usefulness(b)
        || (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0)
        || a.url.localeCompare(b.url))
      .slice(0, this.limits.maxSearchResults)
      .map((result, index) => ({ ...result, id: `fund-source-${index + 1}` }));
    return { results, failures };
  }

  async fetchFundSources(args: {
    results: FundSearchResult[];
    sourceIds: string[];
    officialDomains?: string[];
  }) {
    const uniqueIds = [...new Set(args.sourceIds)];
    if (uniqueIds.length !== args.sourceIds.length || uniqueIds.length > this.limits.maxPages) {
      throw new FundResearchToolError("limit_exceeded", `At most ${this.limits.maxPages} unique fund pages may be fetched.`);
    }
    const resultMap = new Map(args.results.map((result) => [result.id, result]));
    if (uniqueIds.some((id) => !resultMap.has(id))) {
      throw new FundResearchToolError("invalid_request", "The model requested a fund source that was not returned by controlled search.");
    }
    if (!this.tavilyApiKey) {
      throw new FundResearchToolError("not_configured", "Tavily Extract is not configured. Add TAVILY_API_KEY to .env.local and restart the app.");
    }
    const officialDomains = normalizeOfficialDomains(args.officialDomains);
    const selected = uniqueIds.map((id) => resultMap.get(id)!);
    const sources: FetchedFundSource[] = [];
    const failures: Array<{ sourceId: string; message: string }> = [];
    let extraction: Record<string, unknown>;
    try {
      extraction = await extractTavily(
        selected.map((result) => validateFundSourceUrl(result.url)),
        this.tavilyApiKey,
        this.fetcher,
        {
          timeoutMs: Math.max(this.limits.pageTimeoutMs, 35_000),
          maxBytes: this.limits.maxExtractResponseBytes,
          query: "fund objective benchmark strategy holdings weights asset sector country currency commodity interest rate credit leverage inverse daily reset covered call",
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tavily Extract failed for fund sources.";
      return { sources, failures: selected.map((result) => ({ sourceId: result.id, message })) };
    }

    const extractedByUrl = new Map<string, Record<string, unknown>>();
    for (const item of extraction.results as unknown[]) {
      if (!isObject(item) || typeof item.url !== "string") continue;
      try { extractedByUrl.set(validateFundSourceUrl(item.url), item); } catch { /* Unsafe URL omitted. */ }
    }
    const failedByUrl = new Map<string, string>();
    for (const item of extraction.failed_results as unknown[]) {
      if (!isObject(item) || typeof item.url !== "string") continue;
      try {
        failedByUrl.set(
          validateFundSourceUrl(item.url),
          typeof item.error === "string" && item.error.trim()
            ? item.error.trim().slice(0, 300)
            : "Tavily could not extract this fund source.",
        );
      } catch { /* Unsafe URL omitted. */ }
    }
    selected.forEach((result) => {
      const requestedUrl = validateFundSourceUrl(result.url);
      const extracted = extractedByUrl.get(requestedUrl);
      if (!extracted || typeof extracted.raw_content !== "string" || !extracted.raw_content.trim()) {
        failures.push({ sourceId: result.id, message: failedByUrl.get(requestedUrl) ?? "Tavily Extract returned no usable fund text." });
        return;
      }
      const returnedUrl = validateFundSourceUrl(typeof extracted.url === "string" ? extracted.url : requestedUrl);
      if (cleanDomain(new URL(returnedUrl).hostname) !== cleanDomain(new URL(requestedUrl).hostname)) {
        failures.push({ sourceId: result.id, message: "Tavily Extract returned fund content from a different domain." });
        return;
      }
      sources.push({
        ...result,
        url: returnedUrl,
        ...classifyFundSource(returnedUrl, officialDomains, result.title),
        text: extracted.raw_content.replace(/\s+/g, " ").trim().slice(0, this.limits.maxExtractedCharactersPerPage),
        fetchedAt: new Date().toISOString(),
      });
    });
    let remaining = this.limits.maxExtractedCharactersTotal;
    return {
      sources: sources.map((source) => {
        const text = source.text.slice(0, Math.max(0, remaining));
        remaining -= text.length;
        return { ...source, text };
      }).filter((source) => source.text.length > 0),
      failures,
    };
  }
}
