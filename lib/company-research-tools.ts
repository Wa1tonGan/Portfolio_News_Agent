import type { CompanyFactSourceType } from "./company-profile-contracts.ts";

export const companyResearchSearchKinds = ["official", "filings", "exchange", "business"] as const;
export type CompanyResearchSearchKind = typeof companyResearchSearchKinds[number];

export type CompanySearchRequest = {
  id: string;
  kind: CompanyResearchSearchKind;
  topic: string;
};

export type CompanySearchResult = {
  id: string;
  title: string;
  url: string;
  snippet: string;
  sourceType: CompanyFactSourceType;
  trusted: boolean;
  relevanceScore?: number;
};

export type FetchedCompanySource = CompanySearchResult & {
  text: string;
  fetchedAt: string;
};

export type CompanyResearchToolLimits = {
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

const defaultLimits: CompanyResearchToolLimits = {
  maxSearches: 3,
  maxSearchResults: 18,
  maxPages: 4,
  searchTimeoutMs: 10_000,
  pageTimeoutMs: 12_000,
  maxSearchResponseBytes: 600_000,
  maxExtractResponseBytes: 900_000,
  maxExtractedCharactersPerPage: 4_000,
  maxExtractedCharactersTotal: 12_000,
};

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const TAVILY_SEARCH_ENDPOINT = "https://api.tavily.com/search";
const TAVILY_EXTRACT_ENDPOINT = "https://api.tavily.com/extract";

export class CompanyResearchToolError extends Error {
  readonly code: "invalid_request" | "not_configured" | "blocked_url" | "timeout" | "fetch_failed" | "unsupported_content" | "limit_exceeded";
  constructor(code: CompanyResearchToolError["code"], message: string) {
    super(message);
    this.name = "CompanyResearchToolError";
    this.code = code;
  }
}

const regulatorDomains = [
  "sec.gov",
  "companieshouse.gov.uk",
  "company-information.service.gov.uk",
  "sedarplus.ca",
];
const exchangeDomains = [
  "hkexnews.hk",
  "hkex.com.hk",
  "bursamalaysia.com",
  "asx.com.au",
  "londonstockexchange.com",
  "nasdaq.com",
  "nyse.com",
  "sgx.com",
];
const jin10Domains = ["jin10.com", "jin10.com.cn"];
const blockedDomains = [
  "localhost",
  "reddit.com",
  "x.com",
  "twitter.com",
  "facebook.com",
  "instagram.com",
  "tiktok.com",
  "youtube.com",
  "linkedin.com",
];

export function cleanDomain(value: string) {
  return value.trim().toLocaleLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

export function domainMatches(hostname: string, domain: string) {
  const host = cleanDomain(hostname);
  const target = cleanDomain(domain);
  return host === target || host.endsWith(`.${target}`);
}

function isIpAddress(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "");
  return host.includes(":") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || /^0x[0-9a-f]+$/i.test(host) || /^\d+$/.test(host);
}

export function normalizeOfficialDomains(values: string[] = []) {
  const domains = values.map((value) => {
    const raw = value.trim();
    if (!raw) return "";
    try {
      const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
      if (url.protocol !== "https:" || url.username || url.password || url.port || isIpAddress(url.hostname)) return "";
      return cleanDomain(url.hostname);
    } catch {
      return "";
    }
  }).filter(Boolean);
  return [...new Set(domains)].slice(0, 5);
}

export function validateCompanySourceUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CompanyResearchToolError("blocked_url", "Source URL is invalid.");
  }
  const host = cleanDomain(url.hostname);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new CompanyResearchToolError("blocked_url", "Only credential-free HTTPS source URLs on the default port are allowed.");
  }
  if (!host || isIpAddress(host) || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost") || host.endsWith(".home") || host.endsWith(".lan")) {
    throw new CompanyResearchToolError("blocked_url", "Local, private, and direct-IP source URLs are blocked.");
  }
  if (blockedDomains.some((domain) => domainMatches(host, domain))) {
    throw new CompanyResearchToolError("blocked_url", "This source domain is not permitted for company research.");
  }
  url.hash = "";
  return url.toString();
}

export function classifyCompanySource(value: string, officialDomains: string[] = []): { sourceType: CompanyFactSourceType; trusted: boolean } {
  const url = new URL(validateCompanySourceUrl(value));
  const host = cleanDomain(url.hostname);
  const path = url.pathname.toLocaleLowerCase();
  const official = normalizeOfficialDomains(officialDomains).some((domain) => domainMatches(host, domain));
  if (official) {
    const investorRelations = /(?:investor|investors|investor-relations|\bir\b)/.test(path) || host.startsWith("ir.") || host.startsWith("investor.") || host.startsWith("investors.");
    return { sourceType: investorRelations ? "investor_relations" : "official_company", trusted: true };
  }
  if (regulatorDomains.some((domain) => domainMatches(host, domain))) {
    return { sourceType: host.endsWith("sec.gov") && /(?:archives|ixviewer)/.test(path) ? "company_filing" : "regulator", trusted: true };
  }
  if (exchangeDomains.some((domain) => domainMatches(host, domain))) return { sourceType: "exchange_announcement", trusted: true };
  if (jin10Domains.some((domain) => domainMatches(host, domain))) return { sourceType: "jin10", trusted: true };
  return { sourceType: "reputable_external", trusted: false };
}

function decodeHtml(value: string) {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_match, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity.toLocaleLowerCase()] ?? " ";
  });
}

function htmlToText(value: string) {
  return decodeHtml(value)
    .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function parseTavilySearchResults(value: unknown, officialDomains: string[]) {
  const results: Omit<CompanySearchResult, "id">[] = [];
  if (!isObject(value) || !Array.isArray(value.results)) {
    throw new CompanyResearchToolError("fetch_failed", "Tavily returned an invalid search response.");
  }
  for (const item of value.results) {
    if (!isObject(item) || typeof item.url !== "string" || typeof item.title !== "string") continue;
    try {
      const normalizedUrl = validateCompanySourceUrl(item.url);
      const source = classifyCompanySource(normalizedUrl, officialDomains);
      const snippet = typeof item.content === "string" ? item.content : "";
      results.push({
        title: htmlToText(item.title).slice(0, 300),
        url: normalizedUrl,
        snippet: htmlToText(snippet).slice(0, 500),
        relevanceScore: typeof item.score === "number" && Number.isFinite(item.score) ? Math.max(0, Math.min(1, item.score)) : undefined,
        ...source,
      });
    } catch {
      // Unsafe or unsupported search results are intentionally omitted.
    }
  }
  return results;
}

async function readLimitedBody(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared && declared > maxBytes) throw new CompanyResearchToolError("limit_exceeded", "Source response is larger than the permitted limit.");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new CompanyResearchToolError("limit_exceeded", "Source response exceeded the permitted limit.");
    }
    text += decoder.decode(part.value, { stream: true });
  }
  return text + decoder.decode();
}

export async function searchTavily(
  query: string,
  apiKey: string,
  fetcher: FetchLike,
  options: { timeoutMs: number; maxBytes: number; maxResults: number; includeDomains?: string[]; searchDepth: "basic" | "advanced"; topic: "general" | "finance" },
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetcher(TAVILY_SEARCH_ENDPOINT, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        topic: options.topic,
        search_depth: options.searchDepth,
        ...(options.searchDepth === "advanced" ? { chunks_per_source: 3 } : {}),
        max_results: Math.min(10, Math.max(1, options.maxResults)),
        include_answer: false,
        include_raw_content: false,
        ...(options.includeDomains?.length ? { include_domains: options.includeDomains } : {}),
      }),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new CompanyResearchToolError("fetch_failed", "Tavily search unexpectedly redirected.");
    }
    if (response.status === 401 || response.status === 403) {
      throw new CompanyResearchToolError("fetch_failed", "Tavily rejected the configured API key.");
    }
    if (response.status === 429) {
      throw new CompanyResearchToolError("fetch_failed", "Tavily search quota or rate limit was reached.");
    }
    if (!response.ok) throw new CompanyResearchToolError("fetch_failed", `Tavily search returned HTTP ${response.status}.`);
    const contentType = (response.headers.get("content-type") ?? "").toLocaleLowerCase();
    if (!contentType.includes("application/json")) {
      throw new CompanyResearchToolError("unsupported_content", "Tavily returned a non-JSON search response.");
    }
    const body = await readLimitedBody(response, options.maxBytes);
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new CompanyResearchToolError("fetch_failed", "Tavily returned invalid JSON.");
    }
  } catch (error) {
    if (error instanceof CompanyResearchToolError) throw error;
    if (controller.signal.aborted || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))) {
      throw new CompanyResearchToolError("timeout", "Tavily search request timed out.");
    }
    const code = error instanceof Error && isObject(error.cause) && typeof error.cause.code === "string" ? error.cause.code : "";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      throw new CompanyResearchToolError("fetch_failed", `Tavily search DNS lookup failed (${code}).`);
    }
    throw new CompanyResearchToolError("fetch_failed", code ? `Tavily search request failed (${code}).` : "Tavily search request failed.");
  } finally {
    clearTimeout(timer);
  }
}

export async function extractTavily(
  urls: string[], apiKey: string, fetcher: FetchLike,
  options: { timeoutMs: number; maxBytes: number; query?: string },
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetcher(TAVILY_EXTRACT_ENDPOINT, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        urls,
        query: options.query ?? "company overview sector industry main products and services",
        chunks_per_source: 5,
        extract_depth: "advanced",
        format: "text",
        include_images: false,
        timeout: Math.min(60, Math.max(1, Math.ceil(options.timeoutMs / 1_000))),
      }),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new CompanyResearchToolError("fetch_failed", "Tavily Extract unexpectedly redirected.");
    }
    if (response.status === 401 || response.status === 403) {
      throw new CompanyResearchToolError("fetch_failed", "Tavily rejected the configured API key for Extract.");
    }
    if (response.status === 429) {
      throw new CompanyResearchToolError("fetch_failed", "Tavily Extract quota or rate limit was reached.");
    }
    if (response.status === 432 || response.status === 433) {
      throw new CompanyResearchToolError("fetch_failed", `Tavily Extract usage limit was reached (HTTP ${response.status}).`);
    }
    if (!response.ok) throw new CompanyResearchToolError("fetch_failed", `Tavily Extract returned HTTP ${response.status}.`);
    const contentType = (response.headers.get("content-type") ?? "").toLocaleLowerCase();
    if (!contentType.includes("application/json")) {
      throw new CompanyResearchToolError("unsupported_content", "Tavily Extract returned a non-JSON response.");
    }
    const body = await readLimitedBody(response, options.maxBytes);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new CompanyResearchToolError("fetch_failed", "Tavily Extract returned invalid JSON.");
    }
    if (!isObject(parsed) || !Array.isArray(parsed.results) || !Array.isArray(parsed.failed_results)) {
      throw new CompanyResearchToolError("fetch_failed", "Tavily Extract returned an invalid response shape.");
    }
    return parsed;
  } catch (error) {
    if (error instanceof CompanyResearchToolError) throw error;
    if (controller.signal.aborted || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))) {
      throw new CompanyResearchToolError("timeout", "Tavily Extract request timed out.");
    }
    const code = error instanceof Error && isObject(error.cause) && typeof error.cause.code === "string" ? error.cause.code : "";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
      throw new CompanyResearchToolError("fetch_failed", `Tavily Extract DNS lookup failed (${code}).`);
    }
    throw new CompanyResearchToolError("fetch_failed", code ? `Tavily Extract request failed (${code}).` : "Tavily Extract request failed.");
  } finally {
    clearTimeout(timer);
  }
}

function searchSuffix(kind: CompanyResearchSearchKind) {
  if (kind === "official") return "company overview business products services industry";
  if (kind === "filings") return "SEC filing 10-K business overview products services segments";
  if (kind === "exchange") return "exchange filing annual report business operations products services";
  return "company overview industry main products services";
}

function sourcePriority(result: Pick<CompanySearchResult, "sourceType">) {
  const order: CompanyFactSourceType[] = ["official_company", "investor_relations", "company_filing", "regulator", "exchange_announcement", "jin10", "structured_provider", "reputable_external", "user_provided", "local_document", "model_memory"];
  return order.indexOf(result.sourceType);
}

function pageUsefulness(result: Pick<CompanySearchResult, "title" | "url">) {
  const value = `${result.title} ${result.url}`.toLocaleLowerCase();
  if (/(?:annual[- ]report|10-k|company[- ]overview|about[- ]us|business[- ]overview|form[- ]10)/.test(value)) return 0;
  if (/(?:governance|committee|privacy|terms|cookie|board-and-governance)/.test(value)) return 2;
  return 1;
}

export class ControlledCompanyResearchTools {
  private readonly fetcher: FetchLike;
  private readonly tavilyApiKey: string;
  readonly limits: CompanyResearchToolLimits;

  constructor(options: { fetcher?: FetchLike; limits?: Partial<CompanyResearchToolLimits>; tavilyApiKey?: string } = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.tavilyApiKey = (options.tavilyApiKey ?? process.env.TAVILY_API_KEY ?? "").trim();
    this.limits = { ...defaultLimits, ...options.limits };
  }

  async searchCompanySources(args: {
    ticker: string;
    companyName: string;
    requests: CompanySearchRequest[];
    officialDomains?: string[];
  }) {
    if (!this.tavilyApiKey) {
      throw new CompanyResearchToolError("not_configured", "Tavily search is not configured. Add TAVILY_API_KEY to .env.local and restart the app.");
    }
    if (!args.requests.length || args.requests.length > this.limits.maxSearches) {
      throw new CompanyResearchToolError("limit_exceeded", `Research requires between 1 and ${this.limits.maxSearches} searches.`);
    }
    const officialDomains = normalizeOfficialDomains(args.officialDomains);
    const failures: Array<{ requestId: string; message: string }> = [];
    const collected: Omit<CompanySearchResult, "id">[] = [];
    for (const request of args.requests) {
      const topic = request.topic.trim().replace(/\s+/g, " ");
      if (!request.id.trim() || !companyResearchSearchKinds.includes(request.kind) || !topic || topic.length > 100 ||
        /https?:|www\.|site:|filetype:|["'`<>\\]/i.test(topic)) {
        throw new CompanyResearchToolError("invalid_request", "The model requested an invalid company search.");
      }
      const tickerTerm = request.kind === "official" ? "" : `"${args.ticker.slice(0, 30)}"`;
      const query = `"${args.companyName.slice(0, 120)}" ${tickerTerm} ${topic} ${searchSuffix(request.kind)}`.replace(/\s+/g, " ").trim();
      try {
        const response = await searchTavily(query, this.tavilyApiKey, this.fetcher, {
          timeoutMs: this.limits.searchTimeoutMs,
          maxBytes: this.limits.maxSearchResponseBytes,
          maxResults: this.limits.maxSearchResults,
          ...(request.kind === "official" && officialDomains.length ? { includeDomains: officialDomains } : {}),
          searchDepth: request.kind === "official" || request.kind === "filings" ? "advanced" : "basic",
          topic: request.kind === "official" ? "general" : "finance",
        });
        collected.push(...parseTavilySearchResults(response, officialDomains));
      } catch (error) {
        failures.push({ requestId: request.id, message: error instanceof Error ? error.message : "Search failed." });
      }
    }
    const unique = new Map<string, Omit<CompanySearchResult, "id">>();
    collected.forEach((result) => {
      const existing = unique.get(result.url);
      if (!existing || (result.relevanceScore ?? 0) > (existing.relevanceScore ?? 0)) unique.set(result.url, result);
    });
    const results = [...unique.values()]
      .sort((a, b) => sourcePriority(a) - sourcePriority(b) || pageUsefulness(a) - pageUsefulness(b) || (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0) || a.url.localeCompare(b.url))
      .slice(0, this.limits.maxSearchResults)
      .map((result, index) => ({ ...result, id: `source-${index + 1}` }));
    return { results, failures };
  }

  async fetchCompanySources(args: { results: CompanySearchResult[]; sourceIds: string[]; officialDomains?: string[] }) {
    const uniqueIds = [...new Set(args.sourceIds)];
    if (uniqueIds.length !== args.sourceIds.length || uniqueIds.length > this.limits.maxPages) {
      throw new CompanyResearchToolError("limit_exceeded", `At most ${this.limits.maxPages} unique source pages may be fetched.`);
    }
    const resultMap = new Map(args.results.map((result) => [result.id, result]));
    if (uniqueIds.some((id) => !resultMap.has(id))) throw new CompanyResearchToolError("invalid_request", "The model requested a URL that was not returned by the controlled search.");
    if (!this.tavilyApiKey) {
      throw new CompanyResearchToolError("not_configured", "Tavily Extract is not configured. Add TAVILY_API_KEY to .env.local and restart the app.");
    }
    const officialDomains = normalizeOfficialDomains(args.officialDomains);
    const selected = uniqueIds.map((id) => resultMap.get(id)!);
    const sources: FetchedCompanySource[] = [];
    const failures: Array<{ sourceId: string; message: string }> = [];
    let extraction: Record<string, unknown>;
    try {
      extraction = await extractTavily(
        selected.map((result) => validateCompanySourceUrl(result.url)),
        this.tavilyApiKey,
        this.fetcher,
        { timeoutMs: Math.max(this.limits.pageTimeoutMs, 35_000), maxBytes: this.limits.maxExtractResponseBytes },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Tavily Extract failed.";
      return { sources, failures: selected.map((result) => ({ sourceId: result.id, message })) };
    }

    const extractedByUrl = new Map<string, Record<string, unknown>>();
    for (const item of extraction.results as unknown[]) {
      if (!isObject(item) || typeof item.url !== "string") continue;
      try { extractedByUrl.set(validateCompanySourceUrl(item.url), item); } catch { /* Unsafe returned URLs are omitted. */ }
    }
    const failedByUrl = new Map<string, string>();
    for (const item of extraction.failed_results as unknown[]) {
      if (!isObject(item) || typeof item.url !== "string") continue;
      try {
        const message = typeof item.error === "string" && item.error.trim() ? item.error.trim().slice(0, 300) : "Tavily could not extract this source.";
        failedByUrl.set(validateCompanySourceUrl(item.url), message);
      } catch { /* Unsafe returned URLs are omitted. */ }
    }
    selected.forEach((result) => {
      const requestedUrl = validateCompanySourceUrl(result.url);
      const extracted = extractedByUrl.get(requestedUrl);
      if (!extracted || typeof extracted.raw_content !== "string" || !extracted.raw_content.trim()) {
        failures.push({ sourceId: result.id, message: failedByUrl.get(requestedUrl) ?? "Tavily Extract returned no usable source text." });
        return;
      }
      const returnedUrl = validateCompanySourceUrl(typeof extracted.url === "string" ? extracted.url : requestedUrl);
      if (cleanDomain(new URL(returnedUrl).hostname) !== cleanDomain(new URL(requestedUrl).hostname)) {
        failures.push({ sourceId: result.id, message: "Tavily Extract returned content from a different domain." });
        return;
      }
      const classification = classifyCompanySource(returnedUrl, officialDomains);
      sources.push({
        ...result,
        url: returnedUrl,
        ...classification,
        text: extracted.raw_content.replace(/\s+/g, " ").trim().slice(0, this.limits.maxExtractedCharactersPerPage),
        fetchedAt: new Date().toISOString(),
      });
    });
    let remaining = this.limits.maxExtractedCharactersTotal;
    const boundedSources = sources.map((source) => {
      const text = source.text.slice(0, Math.max(0, remaining));
      remaining -= text.length;
      return { ...source, text };
    }).filter((source) => source.text.length > 0);
    return { sources: boundedSources, failures };
  }
}
