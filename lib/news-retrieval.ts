import type { CompanyProfileContext } from "./company-profile-contracts.ts";
import type { FundProfileContext } from "./fund-profile-contracts.ts";
import type { Jin10StructuredResult } from "./jin10-mcp.ts";

export type SearchPlanTerm = {
  keyword: string;
  tickers: string[];
  basis: "registered_name" | "company_name" | "verified_alias" | "fund_name" | "fund_benchmark" | "fund_holding";
};

export type MacroSearchTopic = {
  keyword: string;
  tickers: string[];
  basis: string;
};

export type RetrievalKind = "flash" | "news" | "calendar";
export type RetrievalRoute = "latest_flash" | "latest_news" | "micro_search" | "macro_search" | "calendar";

export type RawNewsCandidate = {
  kind: RetrievalKind;
  item: Record<string, unknown>;
  retrievedBy: RetrievalRoute;
  matchedKeyword: string | null;
  relatedTickers: string[];
};

export type VerifiedNewsCandidate = {
  sourceId: string;
  kind: RetrievalKind;
  title: string;
  summary: string;
  time: string;
  url: string;
  retrievedBy: RetrievalRoute[];
  matchedKeywords: string[];
  relatedTickers: string[];
  freshness: "verified_timestamp" | "inherited_latest_time";
};

export type FreshnessRejectionReason = "missing_time" | "invalid_time" | "stale" | "future";

export type FreshnessResult = {
  accepted: VerifiedNewsCandidate[];
  rejected: Record<FreshnessRejectionReason, number>;
};

export type Jin10ListPage = {
  items: Record<string, unknown>[];
  nextCursor: string | null;
  hasMore: boolean;
};

type HoldingIdentity = {
  ticker: string;
  companyName: string;
  registeredName?: string;
  securityType?: "stock" | "adr" | "reit" | "etf" | "closed_end_fund";
};

const CORPORATE_SUFFIX = /\s+(?:incorporated|inc\.?|corporation|corp\.?|company|co\.?|limited|ltd\.?|plc|common stock|ordinary shares?|class [a-z] capital stock)\b.*$/i;
const FUND_SUFFIX = /\s+(?:etf|fund|trust|shares?)\b.*$/i;
const UTC8_MILLISECONDS = 8 * 60 * 60 * 1000;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function boundedText(value: unknown, max = 600) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value).slice(0, max);
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}

function uniqueStrings(values: string[]) {
  const seen = new Set<string>();
  return values.filter((value) => {
    const normalized = value.trim().toLocaleLowerCase();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function cleanSearchName(value: string, fund = false) {
  const withoutDirectoryLabels = value
    .replace(/\s+-\s+(?:common stock|ordinary shares?|american depositary shares?).*$/i, "")
    .replace(/\([^)]*(?:stock|shares?|etf)[^)]*\)/gi, "")
    .trim();
  const cleaned = withoutDirectoryLabels.replace(fund ? FUND_SUFFIX : CORPORATE_SUFFIX, "").trim();
  return (cleaned.length >= 3 ? cleaned : withoutDirectoryLabels).slice(0, 80);
}

function addTerm(
  target: Map<string, SearchPlanTerm>,
  keyword: string,
  ticker: string,
  basis: SearchPlanTerm["basis"],
) {
  const cleaned = boundedText(keyword, 80);
  if (cleaned.length < 2) return;
  const key = cleaned.toLocaleLowerCase();
  const existing = target.get(key);
  if (existing) {
    existing.tickers = uniqueStrings([...existing.tickers, ticker.toUpperCase()]);
    return;
  }
  target.set(key, { keyword: cleaned, tickers: [ticker.toUpperCase()], basis });
}

function roundRobinTerms(perTicker: Map<string, SearchPlanTerm[]>, maximum: number) {
  const queues = [...perTicker.values()].map((items) => [...items]);
  const selected: SearchPlanTerm[] = [];
  while (selected.length < maximum && queues.some((queue) => queue.length)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next) selected.push(next);
      if (selected.length >= maximum) break;
    }
  }
  const merged = new Map<string, SearchPlanTerm>();
  selected.forEach((term) => addTerm(merged, term.keyword, term.tickers[0], term.basis));
  return [...merged.values()];
}

export function buildMicroSearchTerms(args: {
  holdings: HoldingIdentity[];
  companyProfiles: CompanyProfileContext[];
  fundProfiles: FundProfileContext[];
  maximumTerms?: number;
}) {
  const companies = new Map(args.companyProfiles.map((profile) => [profile.ticker, profile]));
  const funds = new Map(args.fundProfiles.map((profile) => [profile.ticker, profile]));
  const perTicker = new Map<string, SearchPlanTerm[]>();

  for (const holding of args.holdings) {
    const ticker = holding.ticker.toUpperCase();
    const local = new Map<string, SearchPlanTerm>();
    const isFund = holding.securityType === "etf" || holding.securityType === "closed_end_fund";
    if (isFund) {
      const profile = funds.get(ticker);
      addTerm(local, cleanSearchName(profile?.fundName || holding.registeredName || holding.companyName, true), ticker, "fund_name");
      profile?.facts
        .filter((fact) => fact.status === "verified" && fact.category === "benchmark")
        .slice(0, 1)
        .forEach((fact) => addTerm(local, fact.value, ticker, "fund_benchmark"));
      profile?.holdings
        .filter((item) => item.status === "verified")
        .sort((a, b) => (b.weightPercent ?? 0) - (a.weightPercent ?? 0))
        .slice(0, 1)
        .forEach((item) => addTerm(local, item.constituentName, ticker, "fund_holding"));
      profile?.facts
        .filter((fact) => fact.status === "verified" && ["strategy", "sector_exposure", "commodity_exposure"].includes(fact.category))
        .slice(0, 1)
        .forEach((fact) => addTerm(local, fact.value, ticker, "fund_benchmark"));
    } else {
      if (holding.registeredName) addTerm(local, cleanSearchName(holding.registeredName), ticker, "registered_name");
      companies.get(ticker)?.facts
        .filter((fact) => fact.status === "verified" && fact.category === "aliases")
        .slice(0, 2)
        .forEach((fact) => addTerm(local, fact.value, ticker, "verified_alias"));
      addTerm(local, cleanSearchName(holding.companyName), ticker, "company_name");
    }
    perTicker.set(ticker, [...local.values()].slice(0, isFund ? 3 : 2));
  }

  return roundRobinTerms(perTicker, Math.max(1, args.maximumTerms ?? 10));
}

const macroMatchers: Array<{ pattern: RegExp; keywords: string[]; basis: string }> = [
  { pattern: /oil|petroleum|energy|原油|石油|opec/i, keywords: ["原油", "欧佩克"], basis: "oil exposure" },
  { pattern: /gold|precious metal|黄金/i, keywords: ["黄金"], basis: "gold exposure" },
  { pattern: /copper|base metal|铜/i, keywords: ["铜"], basis: "copper exposure" },
  { pattern: /japan|jpy|yen|日本|日元/i, keywords: ["日元", "日本央行"], basis: "Japan or JPY exposure" },
  { pattern: /china|cnh|cny|中国|人民币/i, keywords: ["人民币", "中国经济"], basis: "China or CNY exposure" },
  { pattern: /korea|krw|韩国|韩元/i, keywords: ["韩国经济", "韩国芯片"], basis: "Korea exposure" },
  { pattern: /semiconductor|chip|半导体|芯片/i, keywords: ["半导体政策", "芯片限制"], basis: "semiconductor exposure" },
  { pattern: /bank|financial|银行|金融/i, keywords: ["美债收益率"], basis: "financial-sector exposure" },
  { pattern: /reit|real estate|property|房地产/i, keywords: ["美债收益率"], basis: "real-estate rate exposure" },
  { pattern: /bond|treasury|duration|credit|债券|国债|久期/i, keywords: ["美债收益率"], basis: "fixed-income exposure" },
  { pattern: /export|tariff|关税|出口/i, keywords: ["美国关税"], basis: "trade exposure" },
];

function exposureText(company: CompanyProfileContext | undefined, fund: FundProfileContext | undefined) {
  const companyText = company?.facts
    .filter((fact) => fact.status === "verified" && ["sector", "industry", "regions", "currency_exposures", "commodity_exposures", "macro_exposures"].includes(fact.category))
    .map((fact) => `${fact.factKey} ${fact.value}`) ?? [];
  const fundText = fund?.facts
    .filter((fact) => fact.status === "verified" && [
      "strategy", "sector_exposure", "country_exposure", "currency_exposure", "commodity_exposure",
      "interest_rate_exposure", "credit_exposure", "asset_class_exposure",
    ].includes(fact.category))
    .map((fact) => `${fact.factKey} ${fact.value}`) ?? [];
  return [...companyText, ...fundText].join(" ");
}

export function buildMacroSearchTopics(args: {
  holdings: HoldingIdentity[];
  companyProfiles: CompanyProfileContext[];
  fundProfiles: FundProfileContext[];
  maximumTopics?: number;
}) {
  const allTickers = args.holdings.map((holding) => holding.ticker.toUpperCase());
  const topics = new Map<string, MacroSearchTopic>();
  const add = (keyword: string, tickers: string[], basis: string) => {
    const existing = topics.get(keyword);
    if (existing) existing.tickers = uniqueStrings([...existing.tickers, ...tickers]);
    else topics.set(keyword, { keyword, tickers: uniqueStrings(tickers), basis });
  };
  [
    ["美联储", "universal US monetary policy"],
    ["美国CPI", "universal US inflation"],
    ["美国利率", "universal US rates"],
    ["美元", "universal US dollar"],
    ["美国关税", "universal US trade policy"],
    ["原油", "universal energy-price transmission"],
    ["地缘政治", "universal geopolitical risk"],
    ["美国经济", "universal US growth"],
  ].forEach(([keyword, basis]) => add(keyword, allTickers, basis));

  const companies = new Map(args.companyProfiles.map((profile) => [profile.ticker, profile]));
  const funds = new Map(args.fundProfiles.map((profile) => [profile.ticker, profile]));
  for (const holding of args.holdings) {
    const ticker = holding.ticker.toUpperCase();
    const haystack = `${holding.companyName} ${holding.registeredName ?? ""} ${exposureText(companies.get(ticker), funds.get(ticker))}`;
    macroMatchers.forEach((matcher) => {
      if (matcher.pattern.test(haystack)) matcher.keywords.forEach((keyword) => add(keyword, [ticker], matcher.basis));
    });
  }
  return [...topics.values()].slice(0, Math.max(1, args.maximumTopics ?? 10));
}

export function parseJin10ListPage(result: Jin10StructuredResult): Jin10ListPage {
  const structured = result.structuredContent;
  if (result.isError || !isObject(structured) || !isObject(structured.data)) {
    return { items: [], nextCursor: null, hasMore: false };
  }
  return {
    items: Array.isArray(structured.data.items) ? structured.data.items.filter(isObject) : [],
    nextCursor: boundedText(structured.data.next_cursor, 300) || null,
    hasMore: structured.data.has_more === true,
  };
}

export function parseJin10Calendar(result: Jin10StructuredResult) {
  const structured = result.structuredContent;
  if (result.isError || !isObject(structured) || !Array.isArray(structured.data)) return [];
  return structured.data.filter(isObject);
}

export function utc8Day(timestamp: number) {
  return new Date(timestamp + UTC8_MILLISECONDS).toISOString().slice(0, 10);
}

export function parseJin10Time(value: unknown, asOf: Date) {
  const text = boundedText(value, 100);
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(text)) {
    const parsed = Date.parse(`${text.replace(" ", "T")}+08:00`);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (/^\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(text)) {
    const parsed = Date.parse(`${utc8Day(asOf.getTime()).slice(0, 4)}-${text.replace(" ", "T")}+08:00`);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (/^\d{2}:\d{2}(?::\d{2})?$/.test(text)) {
    const parsed = Date.parse(`${utc8Day(asOf.getTime())}T${text}+08:00`);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function candidateFields(candidate: RawNewsCandidate) {
  const item = candidate.item;
  const content = boundedText(item.content, 1200);
  const introduction = boundedText(item.introduction, 1200);
  const title = boundedText(item.title, 600) || content.slice(0, 140);
  const url = boundedText(item.url, 500);
  const sourceId = boundedText(item.id, 160) || url.match(/(?:detail|details)\/(\d+)/)?.[1] || "";
  return {
    sourceId,
    title: title || `Jin10 ${candidate.kind}`,
    summary: introduction || content || title,
    url,
    rawTime: item.time ?? item.pub_time,
  };
}

function candidateKey(kind: RetrievalKind, sourceId: string, title: string) {
  if (sourceId) return `${kind}:${sourceId}`;
  let hash = 2166136261;
  for (const character of title) hash = ((hash * 31) + character.charCodeAt(0)) >>> 0;
  return `${kind}:text-${hash.toString(36)}`;
}

export function verifyFreshNews(args: {
  latest: RawNewsCandidate[];
  searched: RawNewsCandidate[];
  calendar: RawNewsCandidate[];
  asOf?: Date;
  futureToleranceMinutes?: number;
}) {
  const asOf = args.asOf ?? new Date();
  const asOfMs = asOf.getTime();
  const today = utc8Day(asOfMs);
  const futureCutoff = asOfMs + Math.max(0, args.futureToleranceMinutes ?? 5) * 60_000;
  const latestTimes = new Map<string, number>();
  for (const candidate of args.latest) {
    const fields = candidateFields(candidate);
    const parsed = parseJin10Time(fields.rawTime, asOf);
    if (parsed !== null && utc8Day(parsed) === today && parsed <= futureCutoff && fields.sourceId) {
      latestTimes.set(`${candidate.kind}:${fields.sourceId}`, parsed);
    }
  }

  const rejected: FreshnessResult["rejected"] = { missing_time: 0, invalid_time: 0, stale: 0, future: 0 };
  const accepted = new Map<string, VerifiedNewsCandidate>();
  const all = [...args.searched, ...args.calendar, ...args.latest];
  for (const candidate of all) {
    const fields = candidateFields(candidate);
    const hasRawTime = boundedText(fields.rawTime, 100).length > 0;
    let parsed = parseJin10Time(fields.rawTime, asOf);
    let freshness: VerifiedNewsCandidate["freshness"] = "verified_timestamp";
    if (parsed === null && fields.sourceId) {
      parsed = latestTimes.get(`${candidate.kind}:${fields.sourceId}`) ?? null;
      if (parsed !== null) freshness = "inherited_latest_time";
    }
    if (parsed === null) {
      rejected[hasRawTime ? "invalid_time" : "missing_time"] += 1;
      continue;
    }
    if (parsed > futureCutoff) {
      rejected.future += 1;
      continue;
    }
    if (utc8Day(parsed) !== today) {
      rejected.stale += 1;
      continue;
    }
    const key = candidateKey(candidate.kind, fields.sourceId, fields.title);
    const existing = accepted.get(key);
    const next: VerifiedNewsCandidate = {
      sourceId: fields.sourceId,
      kind: candidate.kind,
      title: fields.title,
      summary: fields.summary,
      time: new Date(parsed).toISOString(),
      url: fields.url,
      retrievedBy: [candidate.retrievedBy],
      matchedKeywords: candidate.matchedKeyword ? [candidate.matchedKeyword] : [],
      relatedTickers: candidate.relatedTickers,
      freshness,
    };
    if (!existing) accepted.set(key, next);
    else accepted.set(key, {
      ...existing,
      title: existing.title.length >= next.title.length ? existing.title : next.title,
      summary: existing.summary.length >= next.summary.length ? existing.summary : next.summary,
      url: existing.url || next.url,
      retrievedBy: uniqueStrings([...existing.retrievedBy, ...next.retrievedBy]) as RetrievalRoute[],
      matchedKeywords: uniqueStrings([...existing.matchedKeywords, ...next.matchedKeywords]),
      relatedTickers: uniqueStrings([...existing.relatedTickers, ...next.relatedTickers]),
      freshness: existing.freshness === "verified_timestamp" || next.freshness === "verified_timestamp"
        ? "verified_timestamp"
        : "inherited_latest_time",
    });
  }

  return {
    accepted: [...accepted.values()].sort((a, b) => Date.parse(b.time) - Date.parse(a.time)),
    rejected,
  } satisfies FreshnessResult;
}

export function selectRetrievalBatch(candidates: VerifiedNewsCandidate[], maximum: number) {
  const safeMaximum = Math.max(1, Math.floor(maximum));
  const macroBudget = safeMaximum <= 4 ? 1 : Math.ceil(safeMaximum * 0.4);
  const microBudget = safeMaximum <= 4 ? 1 : Math.max(1, Math.floor(safeMaximum * 0.25));
  const calendarBudget = safeMaximum >= 3 ? 1 : 0;
  const latestBudget = Math.max(0, safeMaximum - macroBudget - microBudget - calendarBudget);
  const groups: Array<{ routes: RetrievalRoute[]; budget: number }> = [
    { routes: ["macro_search"], budget: macroBudget },
    { routes: ["micro_search"], budget: microBudget },
    { routes: ["calendar"], budget: calendarBudget },
    { routes: ["latest_flash", "latest_news"], budget: latestBudget },
  ];
  const selected: VerifiedNewsCandidate[] = [];
  const used = new Set<string>();
  for (const group of groups) {
    let added = 0;
    for (const next of candidates) {
      if (added >= group.budget || selected.length >= safeMaximum) break;
      if (!next.retrievedBy.some((route) => group.routes.includes(route))) continue;
      const key = candidateKey(next.kind, next.sourceId, next.title);
      if (used.has(key)) continue;
      used.add(key);
      selected.push(next);
      added += 1;
    }
  }
  for (const next of candidates) {
    if (selected.length >= safeMaximum) break;
    const key = candidateKey(next.kind, next.sourceId, next.title);
    if (used.has(key)) continue;
    used.add(key);
    selected.push(next);
  }
  return selected.sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
}

export function calendarToCandidate(item: Record<string, unknown>): RawNewsCandidate | null {
  const title = boundedText(item.title, 600);
  const actual = boundedText(item.actual, 120);
  if (!title || !actual) return null;
  const previous = boundedText(item.previous, 120);
  const consensus = boundedText(item.consensus, 120);
  const affect = boundedText(item.affect_txt, 300);
  return {
    kind: "calendar",
    retrievedBy: "calendar",
    matchedKeyword: null,
    relatedTickers: [],
    item: {
      id: `calendar-${boundedText(item.pub_time, 100)}-${title}`,
      title,
      pub_time: item.pub_time,
      content: [
        previous ? `前值 ${previous}` : "",
        consensus ? `预期 ${consensus}` : "",
        `公布 ${actual}`,
        affect,
      ].filter(Boolean).join("；"),
    },
  };
}
