"use client";

import { ChangeEvent, DragEvent, useEffect, useRef, useState } from "react";
import { readSheet } from "read-excel-file/browser";
import { AnalysisDashboard, type AnalysisResult } from "./analysis-results";
import { WorkflowStudio } from "./workflow-studio";
import { isPlausibleUsSecuritySymbol } from "../lib/us-listed-ticker";
import type { PipelineActivity } from "../lib/analysis-pipeline-next";
import type { AlphaVantageAttempt } from "../lib/alpha-vantage";
import {
  initialProfilePreparationSummary,
  preparePortfolioProfileSet,
  type ProfilePreparationResearchResult,
} from "../lib/profile-preparation";

type SupportedSecurityType = "stock" | "adr" | "reit" | "etf" | "closed_end_fund";

type Holding = {
  ticker: string;
  companyName: string;
  quantity: number;
  averageCost: number;
  currency: string;
  currentPrice?: number;
  marketValue?: number;
  portfolioWeight?: number;
  securityType?: SupportedSecurityType;
  exchangeName?: string;
  registeredName?: string;
};

type SecurityLookupResponse = {
  matches: Array<{
    inputSymbol: string;
    security: {
      symbol: string;
      securityName: string;
      exchangeName: string;
      securityType: string;
      isEtf: boolean;
    };
  }>;
  missingSymbols: string[];
  status: { refreshed: boolean; stale: boolean; warning: string | null; sourceUpdatedAt: string | null };
  error?: string;
};

const supportedSecurityTypes = new Set<SupportedSecurityType>(["stock", "adr", "reit", "etf", "closed_end_fund"]);

async function resolveHoldings(holdings: Holding[]) {
  const response = await fetch("/api/securities/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ symbols: holdings.map((holding) => holding.ticker) }),
  });
  const data = await response.json() as SecurityLookupResponse;
  if (!response.ok) throw new Error(data.error || "美股身份验证失败。");
  const matches = new Map(data.matches.map((match) => [match.inputSymbol, match.security]));
  const unsupported = holdings.flatMap((holding) => {
    const type = matches.get(holding.ticker)?.securityType;
    return type && !supportedSecurityTypes.has(type as SupportedSecurityType) ? [`${holding.ticker} (${type})`] : [];
  });
  const unsupportedSymbols = new Set(unsupported.map((item) => item.split(" ")[0]));
  return {
    holdings: holdings.flatMap((holding) => {
      const identity = matches.get(holding.ticker);
      if (!identity || unsupportedSymbols.has(holding.ticker)) return [];
      return {
        ...holding,
        securityType: identity.securityType as SupportedSecurityType,
        exchangeName: identity.exchangeName,
        registeredName: identity.securityName,
      };
    }),
    skippedSymbols: [...data.missingSymbols, ...unsupported],
    status: data.status,
  };
}

type Jin10Status = {
  configured: boolean;
  connected: boolean;
  message?: string;
  protocolVersion?: string;
  serverName?: string;
  tools?: string[];
  resources?: string[];
};

type OllamaStatus = {
  connected: boolean;
  modelAvailable?: boolean;
  model?: string;
  installedModelCount?: number;
  message?: string;
  durationSeconds?: number;
  result?: {
    direction: string;
    impact: string;
    timeHorizon: string;
    confidence: number;
    summary: string;
    directEffect: string;
    indirectEffects: Array<{ channel: string; effect: string; direction: string }>;
    limitations: string[];
  };
};

type AlphaVantageStatus = {
  configured: boolean;
  connected: boolean;
  ticker?: string;
  endpoint?: "OVERVIEW" | "ETF_PROFILE";
  apiCalls: number;
  pagesFetched: number;
  modelUsed: boolean;
  fieldNames?: string[];
  usableFields?: string[];
  sectorCount?: number;
  holdingCount?: number;
  readyForBaseline?: boolean;
  requiresComplexFundResearch?: boolean;
  errorCode?: string;
  message: string;
};

type CompanyResearchResult = {
  status: "reused" | "updated" | "no_sources" | "no_facts";
  ticker: string;
  factsAdded: number;
  verifiedFactsAdded: number;
  unverifiedFactsAdded: number;
  pagesFetched: number;
  searchFailures: Array<{ requestId: string; message: string }>;
  fetchFailures: Array<{ sourceId: string; message: string }>;
  rejectedFacts: Array<{ factKey: string; reason: string }>;
  modelRetries: number;
  health: { complete: boolean; stale: boolean; reusable: boolean; missingCategories: string[]; conflicts: unknown[] } | null;
  provider?: "local_cache" | "alpha_vantage" | "controlled_web" | "alpha_vantage+controlled_web";
  structuredProviderIssue?: string | null;
  alphaAttempt?: AlphaVantageAttempt;
};

type FundResearchResult = {
  status: "reused" | "updated" | "no_sources" | "no_facts";
  ticker: string;
  factsAdded: number;
  verifiedFactsAdded: number;
  unverifiedFactsAdded: number;
  holdingsAdded: number;
  verifiedHoldingsAdded: number;
  unverifiedHoldingsAdded: number;
  pagesFetched: number;
  searchFailures: Array<{ requestId: string; message: string }>;
  fetchFailures: Array<{ sourceId: string; message: string }>;
  rejectedItems: Array<{ key: string; reason: string }>;
  modelRetries: number;
  coverageIssue: { code: string; message: string } | null;
  health: {
    complete: boolean;
    stale: boolean;
    reusable: boolean;
    missingCategories: string[];
    missingExposure: boolean;
    missingNature: boolean;
    missingStructureFields: string[];
    factConflicts: unknown[];
    holdingConflicts: unknown[];
  } | null;
  provider?: "local_cache" | "alpha_vantage" | "controlled_web" | "alpha_vantage+controlled_web";
  structuredProviderIssue?: string | null;
  alphaAttempt?: AlphaVantageAttempt;
};

type ProfileResearchResult = CompanyResearchResult | FundResearchResult;

type SystemOverview = {
  agents: Array<{ id: string; name: string; nameZh: string; model: string; engine: string; purpose: string }>;
  deterministicSteps: Array<{ id: string; nameZh: string; purpose: string }>;
};

type AnalysisRunStatus = "running" | "completed" | "failed" | "interrupted";

type AnalysisRunSummary = {
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

type AnalysisRunRecord = {
  id: string;
  status: AnalysisRunStatus;
  result: AnalysisResult | null;
  activities: PipelineActivity[];
  error: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
};

type AnalysisHistoryResponse = {
  runs: AnalysisRunSummary[];
  latest: AnalysisRunRecord | null;
  latestCompleted: AnalysisRunRecord | null;
  error?: string;
};

const defaultSystemOverview: SystemOverview = {
  agents: [
    { id: "company-research", name: "公司研究", nameZh: "公司研究", model: "qwen3.5:4b", engine: "Ollama", purpose: "规划搜索、选择来源，并从固定证据段落 ID 提取事实。" },
    { id: "fund-research", name: "基金研究", nameZh: "基金研究", model: "qwen3.5:4b", engine: "Ollama", purpose: "从基金官网、说明书和持仓来源提取有日期的基金资料。" },
    { id: "micro", name: "微观关联", nameZh: "微观关联", model: "qwen3.5:4b", engine: "Ollama", purpose: "寻找公司、产品、客户与竞争关联。" },
    { id: "macro", name: "宏观关联", nameZh: "宏观关联", model: "qwen3.5:4b", engine: "Ollama", purpose: "寻找利率、汇率、商品、政策与地缘传导。" },
    { id: "impact", name: "影响分析", nameZh: "影响分析", model: "qwen3.5:4b", engine: "Ollama", purpose: "解释入选新闻对业务可能利好或利空的原因，并直接形成结果。" },
  ],
  deterministicSteps: [],
};

function clientActivity(
  stage: PipelineActivity["stage"], status: PipelineActivity["status"], label: string,
  detail: string, model: string | null, metrics?: PipelineActivity["metrics"],
): PipelineActivity {
  return {
    id: `browser-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(), stage, status, label, detail, model, metrics,
  };
}

function alphaAttemptActivity(ticker: string, attempt?: AlphaVantageAttempt) {
  if (!attempt || attempt.status === "skipped_local_cache") return null;
  const successful = attempt.status === "success";
  const failed = attempt.status === "failed" || attempt.status === "not_configured";
  const endpoint = attempt.endpoint ?? "not called";
  return clientActivity(
    "profile",
    successful ? "completed" : failed ? "failed" : "info",
    `${ticker} Alpha Vantage ${endpoint}`,
    attempt.message ?? `Alpha Vantage 状态：${attempt.status}。`,
    null,
    {
      alphaApiCalls: attempt.apiCalls,
      factsAdded: attempt.factsAdded,
      pagesFetched: 0,
      modelUsed: false,
      alphaStatus: attempt.status,
    },
  );
}

const requiredColumns = [
  "ticker",
  "company_name",
  "quantity",
  "average_cost",
  "currency",
];

const sampleHoldings: Holding[] = [
  {
    ticker: "AAPL",
    companyName: "Apple",
    quantity: 10,
    averageCost: 185.5,
    currency: "USD",
    currentPrice: 191.2,
    marketValue: 1912,
    portfolioWeight: 28.1,
  },
  {
    ticker: "MSFT",
    companyName: "Microsoft",
    quantity: 5,
    averageCost: 410,
    currency: "USD",
    currentPrice: 430,
    marketValue: 2150,
    portfolioWeight: 31.6,
  },
  {
    ticker: "XOM",
    companyName: "Exxon Mobil",
    quantity: 20,
    averageCost: 125,
    currency: "USD",
    currentPrice: 137,
    marketValue: 2740,
    portfolioWeight: 40.3,
  },
];

const headerAliases: Record<string, keyof Holding> = {
  ticker: "ticker",
  symbol: "ticker",
  company_name: "companyName",
  company: "companyName",
  name: "companyName",
  quantity: "quantity",
  shares: "quantity",
  average_cost: "averageCost",
  avg_cost: "averageCost",
  cost: "averageCost",
  currency: "currency",
  current_price: "currentPrice",
  price: "currentPrice",
  market_value: "marketValue",
  value: "marketValue",
  percent_of_portfolio: "portfolioWeight",
  portfolio_weight: "portfolioWeight",
  weight: "portfolioWeight",
};

function normalizeHeader(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/%/g, "percent")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function parseNumber(value: unknown) {
  if (typeof value === "number") return value;
  const cleaned = String(value ?? "")
    .trim()
    .replace(/,/g, "")
    .replace(/%$/, "")
    .replace(/^\+/, "");
  return cleaned && cleaned !== "--" ? Number(cleaned) : Number.NaN;
}

function parseOptionalNumber(value: unknown) {
  const parsed = parseNumber(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function priorityFor(weight?: number) {
  if (weight === undefined) return { label: "未排序", className: "unranked" };
  if (weight >= 10) return { label: "高", className: "high" };
  if (weight >= 3) return { label: "中", className: "medium" };
  return { label: "低", className: "low" };
}

function analysisRunStatusLabel(status: AnalysisRunStatus) {
  if (status === "running") return "运行中";
  if (status === "completed") return "已完成";
  if (status === "failed") return "技术失败";
  return "已中断";
}

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell.trim());
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function rowsToHoldings(rows: unknown[][]) {
  if (rows.length < 2) {
    throw new Error("文件必须包含标题行和至少一个持仓。");
  }

  const mappedHeaders = rows[0].map((header) => {
    const normalized = normalizeHeader(header);
    return headerAliases[normalized];
  });

  const missing = requiredColumns.filter((column) => {
    const field = headerAliases[column];
    return !mappedHeaders.includes(field);
  });

  if (missing.length) {
    throw new Error(`缺少栏位：${missing.join("、")}`);
  }

  const holdings: Holding[] = [];
  const skippedSymbols: string[] = [];
  rows.slice(1).filter((row) => row.some((cell) => String(cell ?? "").trim())).forEach((row, rowIndex) => {
    const raw: Partial<Record<keyof Holding, unknown>> = {};
    mappedHeaders.forEach((field, columnIndex) => {
      if (field) raw[field] = row[columnIndex];
    });

    const quantity = parseNumber(raw.quantity);
    const averageCost = parseNumber(raw.averageCost);
    const currentPrice = parseOptionalNumber(raw.currentPrice);
    const marketValue = parseOptionalNumber(raw.marketValue);
    const portfolioWeight = parseOptionalNumber(raw.portfolioWeight);
    const ticker = String(raw.ticker ?? "").trim().toUpperCase();
    const companyName = String(raw.companyName ?? "").trim();
    const currency = String(raw.currency ?? "").trim().toUpperCase();

    if (!ticker || !companyName || !currency || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(averageCost) || averageCost < 0) {
      throw new Error(`第 ${rowIndex + 2} 行包含缺失或无效的数值。`);
    }

    if (!isPlausibleUsSecuritySymbol(ticker)) {
      skippedSymbols.push(ticker);
      return;
    }

    if (portfolioWeight !== undefined && (portfolioWeight < 0 || portfolioWeight > 100)) {
      throw new Error(`第 ${rowIndex + 2} 行的投资组合百分比无效。`);
    }

    holdings.push({ ticker, companyName, quantity, averageCost, currency, currentPrice, marketValue, portfolioWeight });
  });
  return { holdings, skippedSymbols };
}

export function PortfolioUpload() {
  const inputRef = useRef<HTMLInputElement>(null);
  const profilePreparationRunRef = useRef(0);
  const initialSecurityResolutionRef = useRef(false);
  const [holdings, setHoldings] = useState<Holding[]>(sampleHoldings);
  const [fileName, setFileName] = useState("sample-portfolio.csv");
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [jin10Status, setJin10Status] = useState<Jin10Status | null>(null);
  const [checkingJin10, setCheckingJin10] = useState(false);
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [checkingOllama, setCheckingOllama] = useState(false);
  const [alphaStatus, setAlphaStatus] = useState<AlphaVantageStatus | null>(null);
  const [checkingAlpha, setCheckingAlpha] = useState(false);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState("");
  const [runningAnalysis, setRunningAnalysis] = useState(false);
  const [analysisElapsedSeconds, setAnalysisElapsedSeconds] = useState(0);
  const [researchTicker, setResearchTicker] = useState(sampleHoldings[0].ticker);
  const [officialDomain, setOfficialDomain] = useState("");
  const [researchingProfile, setResearchingProfile] = useState(false);
  const [researchResult, setResearchResult] = useState<ProfileResearchResult | null>(null);
  const [researchError, setResearchError] = useState("");
  const [profilePreparation, setProfilePreparation] = useState(() => initialProfilePreparationSummary([]));
  const [skippedSymbols, setSkippedSymbols] = useState<string[]>([]);
  const [systemOverview, setSystemOverview] = useState<SystemOverview>(defaultSystemOverview);
  const [analysisActivities, setAnalysisActivities] = useState<PipelineActivity[]>([]);
  const [analysisHistory, setAnalysisHistory] = useState<AnalysisRunSummary[]>([]);
  const [analysisHistoryLoading, setAnalysisHistoryLoading] = useState(true);
  const [selectedAnalysisRunId, setSelectedAnalysisRunId] = useState("");
  const [analysisHistoryNotice, setAnalysisHistoryNotice] = useState("");

  useEffect(() => {
    if (!runningAnalysis) return;

    const timer = window.setInterval(() => {
      setAnalysisElapsedSeconds((seconds) => seconds + 1);
    }, 1_000);

    return () => window.clearInterval(timer);
  }, [runningAnalysis]);

  useEffect(() => {
    let active = true;
    void fetch("/api/analysis/history?limit=12", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as AnalysisHistoryResponse;
        if (!response.ok || body.error) throw new Error(body.error || "无法读取分析历史。");
        return body;
      })
      .then((body) => {
        if (!active) return;
        setAnalysisHistory(body.runs);
        const recordToRestore = body.latest?.result ? body.latest : body.latestCompleted;
        if (recordToRestore?.result) {
          setAnalysis(recordToRestore.result);
          setAnalysisActivities(recordToRestore.activities);
          setSelectedAnalysisRunId(recordToRestore.id);
        }
        if (body.latest && body.latest.status !== "completed") {
          setAnalysisHistoryNotice(
            body.latest.error
              ? `最近一次分析${analysisRunStatusLabel(body.latest.status)}：${body.latest.error}`
              : `最近一次分析${analysisRunStatusLabel(body.latest.status)}。`,
          );
        }
      })
      .catch((caught) => {
        if (active) setAnalysisHistoryNotice(caught instanceof Error ? caught.message : "无法读取分析历史。");
      })
      .finally(() => {
        if (active) setAnalysisHistoryLoading(false);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (initialSecurityResolutionRef.current) return;
    initialSecurityResolutionRef.current = true;
    void resolveHoldings(sampleHoldings).then((verified) => {
      setHoldings(verified.holdings);
      setAnalysisActivities((current) => [...current, clientActivity(
        "registry", "completed", "验证示例持仓的美股身份",
        `已确认 ${verified.holdings.length} 个持仓；跳过 ${verified.skippedSymbols.length} 个。`, null,
        { holdings: verified.holdings.length, skipped: verified.skippedSymbols.length, registryStale: verified.status.stale },
      )]);
    }).catch((caught) => {
      setAnalysisActivities((current) => [...current, clientActivity(
        "registry", "failed", "验证示例持仓的美股身份",
        caught instanceof Error ? caught.message : "美股身份验证失败。", null,
      )]);
    });
  }, []);

  useEffect(() => {
    let active = true;
    void fetch("/api/system/overview", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<SystemOverview> : Promise.reject(new Error("无法读取系统概览。")))
      .then((overview) => { if (active) setSystemOverview(overview); })
      .catch(() => undefined);
    return () => { active = false; };
  }, []);

  async function preparePortfolioProfiles(items: Holding[]) {
    const runId = ++profilePreparationRunRef.current;
    const initial = initialProfilePreparationSummary(items);
    const companyModel = systemOverview.agents.find((agent) => agent.id === "company-research")?.model ?? "qwen3.5:4b";
    const fundModel = systemOverview.agents.find((agent) => agent.id === "fund-research")?.model ?? "qwen3.5:4b";
    setProfilePreparation(initial);
    setAnalysisActivities((current) => [...current, clientActivity(
      "profile", items.length ? "started" : "info", "自动准备公司与基金资料",
      `依次检查 ${initial.companies} 家公司和 ${initial.funds} 个 ETF/基金；完整资料直接复用，其他资料按证券类型运行受控研究。`,
      null,
      { companies: initial.companies, funds: initial.funds },
    )]);

    await preparePortfolioProfileSet({
      holdings: items,
      shouldContinue: () => profilePreparationRunRef.current === runId,
      onItemStart: (summary, holding, kind) => {
        if (profilePreparationRunRef.current !== runId) return;
        setAnalysisActivities((current) => [...current, clientActivity(
          "profile",
          "started",
          `${holding.ticker} 开始准备${kind === "fund" ? "基金" : "公司"}资料`,
          `第 ${summary.completed + 1}/${summary.total} 项：先检查本地数据库，再调用 Alpha Vantage；只有资料不足时才进入较慢的 Tavily 与 Ollama 回退。`,
          null,
          { current: summary.completed + 1, total: summary.total },
        )]);
      },
      lookup: async (holding, kind) => {
        const response = await fetch(
          kind === "fund"
            ? `/api/fund-profiles/${encodeURIComponent(holding.ticker)}`
            : `/api/company-profiles/${encodeURIComponent(holding.ticker)}`,
          { cache: "no-store" },
        );
        if (response.status === 404) return { reusable: false };
        const data = await response.json() as { health?: { reusable?: boolean }; error?: string };
        if (!response.ok) throw new Error(data.error || `${kind === "fund" ? "基金" : "公司"}资料查询失败。`);
        return { reusable: data.health?.reusable === true };
      },
      research: async (holding, kind) => {
        const response = await fetch(kind === "fund" ? "/api/fund-profiles/research" : "/api/company-profiles/research", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(kind === "fund"
            ? {
              ticker: holding.ticker,
              fundName: holding.registeredName ?? holding.companyName,
              securityType: holding.securityType,
            }
            : {
              ticker: holding.ticker,
              companyName: holding.registeredName ?? holding.companyName,
            }),
        });
        const data = await response.json() as ProfilePreparationResearchResult | { error?: string };
        if (!response.ok || "error" in data) {
          throw new Error("error" in data && data.error ? data.error : `${kind === "fund" ? "基金" : "公司"}研究失败。`);
        }
        return data as ProfilePreparationResearchResult;
      },
      onProgress: (summary, outcome) => {
        if (profilePreparationRunRef.current !== runId) return;
        setProfilePreparation(summary);
        const isFund = outcome.kind === "fund";
        const model = isFund ? fundModel : companyModel;
        const labelType = isFund ? "基金" : "公司";
        if (outcome.state === "reused") {
          setAnalysisActivities((current) => [...current, clientActivity(
            "profile", "completed", `${outcome.holding.ticker} 复用${labelType}资料`,
            "本地基础资料已足够用于新闻搜索，并且未过期、没有冲突，无需重新搜索网页。",
            outcome.result ? model : null,
          )]);
          return;
        }
        if (outcome.state === "updated" && outcome.result) {
          const result = outcome.result;
          const structuredOnly = result.provider === "alpha_vantage";
          const alphaActivity = alphaAttemptActivity(outcome.holding.ticker, result.alphaAttempt);
          const completionActivity = clientActivity(
            "profile", "completed", `${outcome.holding.ticker} 自动${labelType}研究`,
            structuredOnly
              ? `结构化 API 完成：1 次 API 调用、0 个网页、无模型；新增 ${result.factsAdded} 条基础事实。`
              : `受控网页回退读取 ${result.pagesFetched} 个网页并运行 ${model}；新增 ${result.factsAdded} 条事实${isFund ? `、${result.holdingsAdded ?? 0} 条持仓` : ""}${result.modelRetries ? `；证据提取自动重试 ${result.modelRetries} 次` : ""}。`,
            structuredOnly ? null : model,
            {
              alphaApiCalls: result.alphaAttempt?.apiCalls ?? 0,
              pagesFetched: result.pagesFetched,
              modelUsed: !structuredOnly,
              factsAdded: result.factsAdded,
              verifiedFacts: result.verifiedFactsAdded,
              ...(isFund ? { holdingsAdded: result.holdingsAdded ?? 0 } : {}),
            },
          );
          setAnalysisActivities((current) => [
            ...current,
            ...(alphaActivity ? [alphaActivity] : []),
            completionActivity,
          ]);
          return;
        }
        if (outcome.state === "coverage_issue" && outcome.result) {
          const result = outcome.result;
          const structuredOnly = result.provider === "alpha_vantage";
          const alphaActivity = alphaAttemptActivity(outcome.holding.ticker, result.alphaAttempt);
          const coverageActivity = clientActivity(
            "profile", "info", `${outcome.holding.ticker} ${labelType}基础资料不足`,
            result.coverageIssue?.message
              ?? `研究状态 ${result.status}；没有足够的新证据可写入，本地已有验证资料保持不变。`,
            structuredOnly ? null : model,
            {
              alphaApiCalls: result.alphaAttempt?.apiCalls ?? 0,
              pagesFetched: result.pagesFetched,
              modelUsed: !structuredOnly,
              factsAdded: result.factsAdded,
            },
          );
          setAnalysisActivities((current) => [
            ...current,
            ...(alphaActivity ? [alphaActivity] : []),
            coverageActivity,
          ]);
          return;
        }
        setAnalysisActivities((current) => [...current, clientActivity(
          "profile", "failed", `${outcome.holding.ticker} ${labelType}资料技术失败`,
          outcome.error ?? "资料准备失败。",
          model,
        )]);
      },
    });
  }

  async function handleFile(file?: File) {
    if (!file) return;
    setError("");
    setAnalysisActivities([]);

    try {
      const extension = file.name.split(".").pop()?.toLowerCase();
      let rows: unknown[][];

      if (extension === "csv") {
        rows = parseCsv(await file.text());
      } else if (extension === "xlsx") {
        rows = await readSheet(file);
      } else {
        throw new Error("Please choose a .csv or .xlsx file.");
      }

      const parsed = rowsToHoldings(rows);
      if (!parsed.holdings.length) throw new Error("No possible US-listed symbols were found in the file.");
      const verified = await resolveHoldings(parsed.holdings);
      if (!verified.holdings.length) throw new Error("No supported US-listed holdings were found. Foreign and unsupported symbols were skipped.");
      setHoldings(verified.holdings);
      setSkippedSymbols([...parsed.skippedSymbols, ...verified.skippedSymbols]);
      setAnalysisActivities((current) => [...current, clientActivity(
        "registry", "completed", "读取并验证新投资组合",
        `载入 ${verified.holdings.length} 个已确认的美股持仓；其他国家或未支持的 ${parsed.skippedSymbols.length + verified.skippedSymbols.length} 行已跳过。`, null,
        { holdings: verified.holdings.length, skipped: parsed.skippedSymbols.length + verified.skippedSymbols.length, registryStale: verified.status.stale },
      )]);
      setResearchTicker(verified.holdings[0].ticker);
      setResearchResult(null);
      setAlphaStatus(null);
      setResearchError("");
      setFileName(file.name);
      setAnalysis(null);
      setAnalysisError("");
      void preparePortfolioProfiles(verified.holdings);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法读取这个文件。");
    }
  }

  function onFileChange(event: ChangeEvent<HTMLInputElement>) {
    void handleFile(event.target.files?.[0]);
    event.target.value = "";
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void handleFile(event.dataTransfer.files?.[0]);
  }

  async function checkJin10Connection() {
    setCheckingJin10(true);
    try {
      const response = await fetch("/api/jin10/status", { cache: "no-store" });
      const status = await response.json() as Jin10Status;
      setJin10Status(status);
    } catch {
      setJin10Status({ configured: false, connected: false, message: "无法运行本地连接检查。" });
    } finally {
      setCheckingJin10(false);
    }
  }

  async function checkOllama(runTest = false) {
    setCheckingOllama(true);
    try {
      const response = await fetch("/api/ollama/status", { method: runTest ? "POST" : "GET", cache: "no-store" });
      const status = await response.json() as OllamaStatus;
      setOllamaStatus(status);
    } catch {
      setOllamaStatus({ connected: false, message: "无法运行本地 Ollama 检查。" });
    } finally {
      setCheckingOllama(false);
    }
  }

  async function checkAlphaOnly() {
    const holding = holdings.find((item) => item.ticker === researchTicker);
    if (!holding?.securityType) return;
    setCheckingAlpha(true);
    setAlphaStatus(null);
    try {
      const response = await fetch("/api/alpha-vantage/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: holding.ticker, securityType: holding.securityType }),
      });
      const status = await response.json() as AlphaVantageStatus | { error?: string };
      if ("error" in status) throw new Error(status.error || "Alpha Vantage 测试失败。");
      const result = status as AlphaVantageStatus;
      setAlphaStatus(result);
      setAnalysisActivities((current) => [...current, clientActivity(
        "profile",
        result.connected ? "completed" : "failed",
        `${holding.ticker} Alpha-only test`,
        result.message,
        null,
        {
          alphaApiCalls: result.apiCalls,
          pagesFetched: result.pagesFetched,
          modelUsed: result.modelUsed,
          readyForBaseline: result.readyForBaseline ?? false,
        },
      )]);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Alpha Vantage 测试失败。";
      setAlphaStatus({
        configured: true,
        connected: false,
        apiCalls: 1,
        pagesFetched: 0,
        modelUsed: false,
        message,
      });
      setAnalysisActivities((current) => [...current, clientActivity(
        "profile", "failed", `${holding.ticker} Alpha-only test`, message, null,
        { alphaApiCalls: 1, pagesFetched: 0, modelUsed: false },
      )]);
    } finally {
      setCheckingAlpha(false);
    }
  }

  async function refreshAnalysisHistory(selectLatest = false) {
    setAnalysisHistoryLoading(true);
    try {
      const response = await fetch("/api/analysis/history?limit=12", { cache: "no-store" });
      const body = await response.json() as AnalysisHistoryResponse;
      if (!response.ok || body.error) throw new Error(body.error || "无法读取分析历史。");
      setAnalysisHistory(body.runs);
      if (selectLatest && body.latest) {
        setSelectedAnalysisRunId(body.latest.id);
        setAnalysisActivities(body.latest.activities);
        setAnalysis(body.latest.result);
        setAnalysisHistoryNotice(body.latest.status === "completed"
          ? ""
          : body.latest.error ?? `这次分析${analysisRunStatusLabel(body.latest.status)}。`);
      }
    } finally {
      setAnalysisHistoryLoading(false);
    }
  }

  async function openAnalysisRun(runId: string) {
    setAnalysisHistoryLoading(true);
    setAnalysisHistoryNotice("");
    try {
      const response = await fetch(`/api/analysis/history/${encodeURIComponent(runId)}`, { cache: "no-store" });
      const run = await response.json() as AnalysisRunRecord & { error?: string };
      if (!response.ok || ("error" in run && !run.id)) throw new Error(run.error || "无法读取分析记录。");
      setSelectedAnalysisRunId(run.id);
      setAnalysisActivities(run.activities);
      setAnalysis(run.result);
      if (run.status !== "completed") {
        setAnalysisHistoryNotice(run.error ?? `这次分析${analysisRunStatusLabel(run.status)}，没有产生金融判断。`);
      }
      document.getElementById(run.result ? "results" : "history")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (caught) {
      setAnalysisHistoryNotice(caught instanceof Error ? caught.message : "无法读取分析记录。");
    } finally {
      setAnalysisHistoryLoading(false);
    }
  }

  async function runPortfolioAnalysis() {
    setAnalysisElapsedSeconds(0);
    setRunningAnalysis(true);
    setAnalysisError("");
    setAnalysisHistoryNotice("");
    setSelectedAnalysisRunId("");
    setAnalysis(null);
    try {
      const response = await fetch("/api/analysis/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ holdings }),
      });
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new Error(data.error || "分析失败。");
      }
      if (!response.body) throw new Error("浏览器无法读取实时分析记录。");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalResult: AnalysisResult | null = null;
      let streamError = "";

      const readLine = (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line) as
          | { type: "activity"; activity: PipelineActivity }
          | { type: "result"; result: AnalysisResult; runId: string }
          | { type: "error"; error: string };
        if (event.type === "activity") setAnalysisActivities((current) => [...current, event.activity]);
        else if (event.type === "result") {
          finalResult = event.result;
          setSelectedAnalysisRunId(event.runId);
        }
        else streamError = event.error;
      };

      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        lines.forEach(readLine);
        if (done) break;
      }
      readLine(buffer);
      if (streamError) throw new Error(streamError);
      if (!finalResult) throw new Error("分析结束时没有收到通过验证的最终结果。");
      setAnalysis(finalResult);
    } catch (caught) {
      setAnalysisError(caught instanceof Error ? caught.message : "投资组合分析失败。");
    } finally {
      setRunningAnalysis(false);
      void refreshAnalysisHistory(true).catch((caught) => {
        setAnalysisHistoryNotice(caught instanceof Error ? caught.message : "无法更新分析历史。");
      });
    }
  }

  async function researchCompanyProfile() {
    const holding = holdings.find((item) => item.ticker === researchTicker);
    if (!holding) return;
    const isFund = holding.securityType === "etf" || holding.securityType === "closed_end_fund";
    setResearchingProfile(true);
    setResearchError("");
    setResearchResult(null);
    const researchAgentId = isFund ? "fund-research" : "company-research";
    const researchModel = systemOverview.agents.find((agent) => agent.id === researchAgentId)?.model ?? "qwen3.5:4b";
    setAnalysisActivities((current) => [...current, clientActivity(
      "profile", "started", `${holding.ticker} 手动${isFund ? "基金" : "公司"}研究`,
      isFund
        ? "先读取 Alpha Vantage 基金资料；资料不足时再搜索基金官网、说明书与持仓。"
        : "先读取 Alpha Vantage 公司概况；资料不足时再规划受控网页搜索。",
      null,
    )]);
    try {
      const response = await fetch(isFund ? "/api/fund-profiles/research" : "/api/company-profiles/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isFund
          ? {
            ticker: holding.ticker,
            fundName: holding.registeredName ?? holding.companyName,
            securityType: holding.securityType,
            officialDomains: officialDomain.trim() ? [officialDomain.trim()] : [],
          }
          : {
            ticker: holding.ticker,
            companyName: holding.registeredName ?? holding.companyName,
            officialDomains: officialDomain.trim() ? [officialDomain.trim()] : [],
          }),
      });
      const data = await response.json() as ProfileResearchResult | { error?: string };
      if (!response.ok || "error" in data) throw new Error("error" in data && data.error ? data.error : `${isFund ? "基金" : "公司"}研究失败。`);
      const research = data as ProfileResearchResult;
      setResearchResult(research);
      const fundResearch = "holdingsAdded" in research ? research : null;
      const coverageMessage = fundResearch?.coverageIssue?.message;
      const providerLabel = research.provider === "alpha_vantage"
        ? "Alpha Vantage"
        : research.provider === "alpha_vantage+controlled_web"
          ? "Alpha Vantage + 受控网页"
          : research.provider === "local_cache"
            ? "本地缓存"
            : "受控网页";
      const alphaActivity = alphaAttemptActivity(holding.ticker, research.alphaAttempt);
      const researchActivity = clientActivity(
        "profile", research.status === "no_sources" || research.status === "no_facts" ? "info" : "completed",
        `${holding.ticker} 手动${isFund ? "基金" : "公司"}研究`,
        coverageMessage
          ?? `${providerLabel}；状态 ${research.status}；Alpha API ${research.alphaAttempt?.apiCalls ?? 0} 次；网页 ${research.pagesFetched} 页；${research.provider === "alpha_vantage" || research.provider === "local_cache" ? "未运行模型" : `运行 ${researchModel}`}；新增 ${research.factsAdded} 条事实${fundResearch ? `、${fundResearch.holdingsAdded} 条持仓` : ""}。`,
        research.provider === "alpha_vantage" || research.provider === "local_cache" ? null : researchModel,
        {
          alphaApiCalls: research.alphaAttempt?.apiCalls ?? 0,
          pagesFetched: research.pagesFetched,
          modelUsed: research.provider !== "alpha_vantage" && research.provider !== "local_cache",
          factsAdded: research.factsAdded,
          verifiedFacts: research.verifiedFactsAdded,
          ...(fundResearch ? { holdingsAdded: fundResearch.holdingsAdded } : {}),
        },
      );
      setAnalysisActivities((current) => [
        ...current,
        ...(alphaActivity ? [alphaActivity] : []),
        researchActivity,
      ]);
      setAnalysis(null);
    } catch (caught) {
      setResearchError(caught instanceof Error ? caught.message : `${isFund ? "基金" : "公司"}研究失败。`);
      setAnalysisActivities((current) => [...current, clientActivity(
        "profile", "failed", `${holding.ticker} 手动${isFund ? "基金" : "公司"}研究`,
        caught instanceof Error ? caught.message : `${isFund ? "基金" : "公司"}研究失败。`, researchModel,
      )]);
    } finally {
      setResearchingProfile(false);
    }
  }

  const currencies = new Set(holdings.map((holding) => holding.currency));
  const totalsByCurrency = holdings.reduce<Record<string, number>>((totals, holding) => {
    if (holding.marketValue !== undefined) {
      totals[holding.currency] = (totals[holding.currency] ?? 0) + holding.marketValue;
    }
    return totals;
  }, {});
  const hasBrokerWeights = holdings.some((holding) => holding.portfolioWeight !== undefined);
  const selectedResearchHolding = holdings.find((holding) => holding.ticker === researchTicker);
  const selectedResearchIsFund = selectedResearchHolding?.securityType === "etf" || selectedResearchHolding?.securityType === "closed_end_fund";
  const fundResearchResult = researchResult && "holdingsAdded" in researchResult ? researchResult : null;
  const configuredModel = (agentId: string) =>
    systemOverview.agents.find((agent) => agent.id === agentId)?.model ?? "未配置";
  const runButtonLabel = runningAnalysis
    ? "正在分析…"
    : profilePreparation.running
      ? `准备资料 ${profilePreparation.completed}/${profilePreparation.total}`
      : "运行工作流";
  const runButtonDisabled = runningAnalysis || profilePreparation.running;
  const jin10Connected = Boolean(jin10Status?.connected);
  const jin10Configured = Boolean(jin10Status?.configured);
  const ollamaConnected = Boolean(ollamaStatus?.connected);
  const ollamaReady = Boolean(ollamaStatus?.connected && ollamaStatus.modelAvailable);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">PN</span>
          <div>
            <strong>投资组合新闻影响</strong>
            <span>新闻影响研究</span>
          </div>
        </div>
        <nav className="topbar-actions">
          <a href="#workflow">工作流</a>
          <a href="#setup">设置</a>
          <a href="#history">历史</a>
          <a href="#results">结果</a>
          <a href="/local-data">资料库</a>
        </nav>
      </header>

      <WorkflowStudio
        agents={systemOverview.agents}
        activities={analysisActivities}
        running={runningAnalysis}
        elapsedSeconds={analysisElapsedSeconds}
        holdingsCount={holdings.length}
        profilesRunning={profilePreparation.running}
        profilesCompleted={profilePreparation.completed}
        profileFailures={profilePreparation.failures}
        analysisReady={Boolean(analysis)}
        runError={analysisError}
      />

      <section className="setup-console" id="setup">
        <header className="setup-console-heading">
          <div>
            <span>系统设置</span>
            <h2>资料、连接与研究工具</h2>
            <p>日常使用只需上传投资组合，再在本区底部运行工作流。其他检查工具按需要展开。</p>
          </div>
          <div className="setup-health">
            <span className={holdings.length ? "ready" : ""}><i />投资组合 {holdings.length ? "已载入" : "未载入"}</span>
            <span className={jin10Connected ? "ready" : ""}><i />金十 {jin10Connected ? "已连接" : "未检查"}</span>
            <span className={ollamaReady ? "ready" : ""}><i />Ollama {ollamaReady ? "可用" : "未检查"}</span>
          </div>
        </header>

        <details className="setup-module" open>
          <summary>
            <span className="setup-module-number">01</span>
            <div><strong>投资组合</strong><small>上传文件、验证美股身份并检查持仓</small></div>
            <span className="setup-module-state">{holdings.length} 个持仓</span>
          </summary>
          <div className="setup-module-content portfolio-setup-grid">
            <div className="upload-pane">
              <div className="module-pane-heading"><strong>上传投资组合</strong><a href="/sample-portfolio.csv" download>下载示例文件</a></div>
              <input
                ref={inputRef}
                className="visually-hidden"
                type="file"
                accept=".csv,.xlsx"
                onChange={onFileChange}
                aria-label="选择投资组合文件"
              />
              <div
                className={`drop-zone${dragging ? " is-dragging" : ""}`}
                onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
              >
                <div className="upload-icon">↑</div>
                <h3>把文件拖放到这里</h3>
                <p>支持 CSV 或 Excel（.xlsx），最大 5 MB</p>
                <button type="button" onClick={() => inputRef.current?.click()}>选择文件</button>
              </div>
              {error ? <div className="error-message" role="alert">{error}</div> : null}
              <details className="format-guide">
                <summary>查看文件栏位要求</summary>
                <h3>必填栏位</h3>
                <div className="column-tags">{requiredColumns.map((column) => <code key={column}>{column}</code>)}</div>
                <h3 className="optional-heading">建议提供的栏位</h3>
                <div className="column-tags"><code>market_value</code><code>%_of_portfolio</code><code>current_price</code></div>
                <p>只载入已确认的美国上市证券；其他国家的行会被跳过，不会令整个文件失败。与美股持仓有可靠连接的全球新闻仍可进入分析。</p>
              </details>
              {profilePreparation.total ? <div className="registry-note">
                <p><strong>资料准备：</strong> {profilePreparation.running
                  ? `${profilePreparation.completed}/${profilePreparation.total}（${profilePreparation.companies} 家公司，${profilePreparation.funds} 个基金）`
                  : `${profilePreparation.researched} 个新研究 · ${profilePreparation.reused} 个复用 · ${profilePreparation.coverageIssues} 个资料不足 · ${profilePreparation.failures} 个技术失败`}</p>
              </div> : null}
            </div>

            <div className="preview-pane">
              <div className="module-pane-heading"><strong>持仓预览</strong><span className="file-name">{fileName}</span></div>
              <div className="summary-row">
                <div><strong>{holdings.length}</strong><span>持仓</span></div>
                <div><strong>{currencies.size}</strong><span>货币</span></div>
                <div><strong>{skippedSymbols.length}</strong><span>已跳过</span></div>
              </div>
              {skippedSymbols.length ? <div className="skip-message" role="status">
                <strong>只载入已确认的美国上市持仓。</strong>
                <span>已跳过：{skippedSymbols.join("、")}</span>
              </div> : null}
              {Object.keys(totalsByCurrency).length ? (
                <div className="currency-totals" aria-label="按货币计算的持仓市值">
                  <span>持仓市值</span>
                  {Object.entries(totalsByCurrency).map(([currency, total]) => (
                    <strong key={currency}>{currency} {total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
                  ))}
                </div>
              ) : null}
              <div className="table-wrap">
                <table>
                  <thead><tr><th>代码</th><th>名称</th><th>类型</th><th>交易所</th><th>数量</th><th>市值</th><th>权重</th><th>规模优先级</th></tr></thead>
                  <tbody>
                    {holdings.map((holding) => {
                      const priority = priorityFor(holding.portfolioWeight);
                      return (
                        <tr key={`${holding.ticker}-${holding.companyName}`}>
                          <td><strong>{holding.ticker}</strong></td>
                          <td>{holding.companyName}</td>
                          <td>{holding.securityType === "stock" ? "股票" : holding.securityType === "adr" ? "美国存托凭证" : holding.securityType === "reit" ? "房地产投资信托" : holding.securityType === "etf" ? "交易所买卖基金" : holding.securityType === "closed_end_fund" ? "封闭式基金" : "核对中"}</td>
                          <td>{holding.exchangeName ?? "—"}</td>
                          <td>{holding.quantity.toLocaleString()}</td>
                          <td>{holding.marketValue === undefined ? "—" : `${holding.currency} ${holding.marketValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}</td>
                          <td>{holding.portfolioWeight === undefined ? "—" : `${holding.portfolioWeight.toFixed(2)}%`}</td>
                          <td><span className={`priority-badge ${priority.className}`}>{priority.label}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="priority-explainer"><strong>规模优先级</strong>只使用投资组合权重。新闻筛选还会考虑相关性、预期业务影响和模型置信度。{!hasBrokerWeights ? " 请提供 %_of_portfolio 栏位以启用权重排序。" : ""}</p>
            </div>
          </div>
          <div className="portfolio-run-action">
            <div>
              <strong>下一步：运行新闻影响工作流</strong>
              <p>上传并确认持仓后，从这里开始运行，不需要回到上方图表。</p>
            </div>
            <button type="button" onClick={() => void runPortfolioAnalysis()} disabled={runButtonDisabled}>
              {runButtonLabel}
            </button>
          </div>
        </details>

        <div className="setup-module-grid">
          <details className="setup-module">
            <summary>
              <span className="setup-module-number">02</span>
              <div><strong>金十资讯连接</strong><small>一步检查令牌与 MCP 连接</small></div>
              <span className={`setup-module-state ${jin10Connected ? "ready" : ""}`}>{jin10Connected ? "已连接" : "未检查"}</span>
            </summary>
            <div className="setup-compact-content">
              <p>访问令牌不会显示在网页、投资组合文件或浏览器储存空间中。按一下即可确认状态。</p>
              <div className="connection-checklist">
                <div className={`connection-check-item ${jin10Configured ? "ok" : ""}`}><span />访问令牌 {jin10Configured ? "已配置" : "未配置"}</div>
                <div className={`connection-check-item ${jin10Connected ? "ok" : ""}`}><span />MCP 通道 {jin10Connected ? "已连接" : "未连接"}</div>
              </div>
              <div className="connection-heading"><span className={`connection-light${jin10Connected ? " connected" : ""}`} /><strong>{jin10Connected ? "连接正常" : jin10Configured ? "连接失败" : "尚未连接"}</strong></div>
              <p aria-live="polite">{jin10Status?.message ?? (jin10Status?.connected
                ? `${jin10Status.serverName ?? "金十 MCP"} · ${jin10Status.tools?.length ?? 0} 个工具 · ${jin10Status.resources?.length ?? 0} 个资源`
                : "请先加入访问令牌，再检查 MCP 连接。")}</p>
              {jin10Connected ? <small>协议版本 {jin10Status?.protocolVersion}</small> : null}
              <button type="button" onClick={() => void checkJin10Connection()} disabled={checkingJin10}>{checkingJin10 ? "检查中…" : "立即检查"}</button>
            </div>
          </details>

          <details className="setup-module">
            <summary>
              <span className="setup-module-number">03</span>
              <div><strong>Ollama 模型</strong><small>一步检查服务与模型状态</small></div>
              <span className={`setup-module-state ${ollamaReady ? "ready" : ""}`}>{ollamaReady ? "可用" : "未检查"}</span>
            </summary>
            <div className="setup-compact-content">
              <p>Qwen 3.5 在本机运行。安全测试只使用虚构情境，不会读取你的投资组合，也不会调用云端模型。</p>
              <div className="connection-checklist">
                <div className={`connection-check-item ${ollamaConnected ? "ok" : ""}`}><span />Ollama 服务 {ollamaConnected ? "在线" : "离线"}</div>
                <div className={`connection-check-item ${ollamaReady ? "ok" : ""}`}><span />目标模型 {ollamaReady ? "可用" : "未就绪"}</div>
              </div>
              <div className="model-specs">
                <span>{configuredModel("company-research")} · 资料研究</span>
                <span>{configuredModel("micro")} · 微观与宏观</span>
                <span>{configuredModel("impact")} · 影响分析</span>
              </div>
              <div className="connection-heading"><span className={`connection-light${ollamaReady ? " connected" : ""}`} /><strong>{ollamaReady ? "模型可用" : "尚未检查"}</strong></div>
              <p aria-live="polite">{ollamaStatus?.message ?? "先检查 Ollama 服务；如有需要，再运行一次模型安全测试。"}</p>
              {ollamaStatus?.model ? <small>{ollamaStatus.model}{ollamaStatus.durationSeconds ? ` · ${ollamaStatus.durationSeconds} 秒` : ""}</small> : null}
              {ollamaStatus?.result ? <div className="test-result">
                <div><span>方向</span><strong>{ollamaStatus.result.direction}</strong></div>
                <div><span>影响</span><strong>{ollamaStatus.result.impact}</strong></div>
                <div><span>置信度</span><strong>{ollamaStatus.result.confidence}%</strong></div>
                <p>{ollamaStatus.result.summary}</p>
              </div> : null}
              <div className="connection-actions">
                <button type="button" className="secondary-button" onClick={() => void checkOllama(false)} disabled={checkingOllama}>检查服务</button>
                <button type="button" onClick={() => void checkOllama(true)} disabled={checkingOllama}>{checkingOllama ? "处理中…" : "运行模型测试"}</button>
              </div>
            </div>
          </details>
        </div>

        <details className="setup-module">
          <summary>
            <span className="setup-module-number">04</span>
            <div><strong>手动资料研究工具</strong><small>自动准备失败或资料不足时，才需要手动使用</small></div>
            <span className={`setup-module-state ${researchResult?.status === "updated" || researchResult?.status === "reused" ? "ready" : ""}`}>{researchingProfile ? "研究中" : researchResult ? "已有结果" : "按需使用"}</span>
          </summary>
          <div className="setup-module-content research-setup-grid">
            <div className="research-explainer">
              <strong>{selectedResearchIsFund ? "建立一个 ETF 或基金资料档案" : "建立一个公司资料档案"}</strong>
              <p>{selectedResearchIsFund
                ? "系统先读取 Alpha Vantage 的结构化基金资料；只有主要暴露或复杂结构仍不清楚时，才使用受控网页研究。找不到可靠来源时不会猜测。"
                : "系统先读取 Alpha Vantage 的公司概况；只有行业或业务性质仍不足时，才运行受控 Tavily 网页研究。完整且未过期的本地资料会直接复用。"}</p>
              <div className="model-specs"><span>Alpha Vantage 优先</span><span>复用本地资料</span><span>Tavily + 4B 备用</span><span>必须提供证据</span></div>
              {researchResult ? (
                <div className="test-result profile-result">
                  <div><span>状态</span><strong>{researchResult.status === "reused" ? "已复用" : researchResult.status === "updated" ? "已更新" : researchResult.status === "no_sources" ? "没有来源" : "没有新事实"}</strong></div>
                  <div><span>资料路径</span><strong>{researchResult.provider === "alpha_vantage" ? "Alpha Vantage" : researchResult.provider === "alpha_vantage+controlled_web" ? "Alpha + 受控网页" : researchResult.provider === "local_cache" ? "本地资料" : "受控网页"}</strong></div>
                  <div><span>Alpha 调用</span><strong>{researchResult.alphaAttempt?.apiCalls ?? 0}</strong></div>
                  <div><span>网页数量</span><strong>{researchResult.pagesFetched}</strong></div>
                  <div><span>是否使用模型</span><strong>{researchResult.provider === "alpha_vantage" || researchResult.provider === "local_cache" ? "否" : "Qwen 4B"}</strong></div>
                  <div><span>新增事实</span><strong>{researchResult.factsAdded}</strong></div>
                  {fundResearchResult ? <div><span>新增持仓</span><strong>{fundResearchResult.holdingsAdded}</strong></div> : null}
                  <p>{researchResult.verifiedFactsAdded} 条已验证 · {researchResult.unverifiedFactsAdded} 条未验证
                    {fundResearchResult ? ` · ${fundResearchResult.verifiedHoldingsAdded} 条已验证持仓` : ""}
                    {researchResult.modelRetries ? ` · 模型自动重试 ${researchResult.modelRetries} 次` : ""}
                    {researchResult.health ? researchResult.health.complete ? " · 基础资料可用于新闻搜索" : researchResult.health.missingCategories.length ? ` · 仍缺少 ${researchResult.health.missingCategories.join("、")}` : " · 基础资料仍不足" : " · 尚无本地档案"}
                  </p>
                  {researchResult.searchFailures.length ? <p className="technical-message">搜索技术问题：{researchResult.searchFailures[0].message}</p> : null}
                  {researchResult.fetchFailures.length ? <p className="technical-message">网页读取问题：{researchResult.fetchFailures[0].message}</p> : null}
                  {fundResearchResult?.coverageIssue ? <p className="technical-message">资料覆盖问题：{fundResearchResult.coverageIssue.message}</p> : null}
                </div>
              ) : null}
            </div>
            <div className="research-controls">
              <label htmlFor="research-holding">持仓</label>
              <select id="research-holding" value={researchTicker} onChange={(event) => { setResearchTicker(event.target.value); setResearchResult(null); setAlphaStatus(null); setResearchError(""); }} disabled={researchingProfile || checkingAlpha}>
                {holdings.map((holding) => <option key={holding.ticker} value={holding.ticker}>{holding.ticker} · {holding.companyName}</option>)}
              </select>
              <label htmlFor="official-domain">{selectedResearchIsFund ? "基金发行方官网域名" : "公司官网域名"} <small>可选</small></label>
              <input id="official-domain" value={officialDomain} onChange={(event) => setOfficialDomain(event.target.value)} placeholder="example.com" disabled={researchingProfile} />
              <p aria-live="polite">{researchError || (researchingProfile
                ? "先检查结构化资料；只有资料不足时才运行受控网页研究。"
                : selectedResearchIsFund
                  ? "找不到可靠基金资料时，系统会保留现有已验证资料并显示覆盖问题。"
                  : "你提供的公司官网可以作为可信来源；其他未知网站会降低可信程度。")}</p>
              {alphaStatus ? <div className="alpha-status">
                <span>Alpha：{alphaStatus.connected ? "连接正常" : "连接失败"}</span>
                <span>端点：{alphaStatus.endpoint ?? "未调用"}</span>
                <span>接口调用：{alphaStatus.apiCalls}</span>
                <span>模型：{alphaStatus.modelUsed ? "已使用" : "未使用"}</span>
                <p>{alphaStatus.message}</p>
              </div> : null}
              <div className="connection-actions">
                <button type="button" className="secondary-button" onClick={() => void checkAlphaOnly()} disabled={researchingProfile || checkingAlpha || !researchTicker}>{checkingAlpha ? "测试中…" : "只测试 Alpha"}</button>
                <button type="button" onClick={() => void researchCompanyProfile()} disabled={researchingProfile || checkingAlpha || !researchTicker}>{researchingProfile ? "研究中…" : `研究选定${selectedResearchIsFund ? "基金" : "公司"}`}</button>
              </div>
            </div>
          </div>
        </details>
      </section>

      <section className="analysis-history" id="history" aria-label="分析历史">
        <header>
          <div>
            <span>自动保存</span>
            <h2>分析历史</h2>
            <p>完成结果和节点活动会自动保存，页面重新载入后仍可重新打开。</p>
          </div>
          <button type="button" onClick={() => void refreshAnalysisHistory(false).catch((caught) => {
            setAnalysisHistoryNotice(caught instanceof Error ? caught.message : "无法读取分析历史。");
          })} disabled={analysisHistoryLoading}>
            {analysisHistoryLoading ? "读取中…" : "重新读取"}
          </button>
        </header>
        {analysisHistoryNotice ? <div className="history-notice" role="status"><strong>技术状态</strong><span>{analysisHistoryNotice}</span></div> : null}
        {analysisHistory.length ? (
          <div className="history-list">
            {analysisHistory.map((run) => (
              <button
                type="button"
                className={`history-record ${run.status}${selectedAnalysisRunId === run.id ? " selected" : ""}`}
                key={run.id}
                onClick={() => void openAnalysisRun(run.id)}
                disabled={analysisHistoryLoading}
              >
                <span className="history-record-time">{new Date(run.startedAt).toLocaleString("zh-CN", { hour12: false })}</span>
                <strong>{run.tickers.join("、") || `${run.holdingsCount} 个持仓`}</strong>
                <span className="history-record-meta">
                  {run.status === "completed"
                    ? `${run.completedImpacts} 个完成判断${run.technicalFailures ? ` · ${run.technicalFailures} 个技术问题` : ""}${run.durationSeconds !== null ? ` · ${Math.round(run.durationSeconds)} 秒` : ""}`
                    : run.error ?? "没有产生最终金融判断"}
                </span>
                <span className={`history-status ${run.status}`}>{analysisRunStatusLabel(run.status)}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="history-empty">{analysisHistoryLoading ? "正在读取本地分析记录…" : "还没有保存的分析记录。完成第一次分析后会显示在这里。"}</div>
        )}
      </section>

      {analysis ? <div id="results"><AnalysisDashboard result={analysis} runId={selectedAnalysisRunId} /></div> : null}
    </div>
  );
}
