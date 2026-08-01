import { getD1Database } from "../../../../db";
import {
  AlphaVantageClient,
  AlphaVantageError,
  type AlphaVantageAttempt,
} from "../../../../lib/alpha-vantage";
import { normalizeOfficialDomains } from "../../../../lib/company-research-tools";
import { assessFundProfile } from "../../../../lib/fund-profile-contracts";
import { cleanFundTicker } from "../../../../lib/fund-profile-input";
import { D1FundProfileStore } from "../../../../lib/fund-profile-store";
import { FundResearchAgent, type FundResearchResult } from "../../../../lib/fund-research-agent";
import { ControlledFundResearchTools } from "../../../../lib/fund-research-tools";
import { getOllamaConfiguration, OllamaClient, OllamaError } from "../../../../lib/ollama";
import {
  prepareFundFromAlphaVantage,
  type StructuredFundPreparation,
} from "../../../../lib/structured-profile-preparation";

export const dynamic = "force-dynamic";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function alphaResult(ticker: string, preparation: StructuredFundPreparation, alphaAttempt: AlphaVantageAttempt) {
  return {
    status: preparation.factsAdded || preparation.holdingsAdded ? "updated" : "no_sources",
    ticker,
    profile: preparation.profile,
    health: preparation.health,
    searchesRequested: 0,
    searchResults: 0,
    pagesRequested: 0,
    pagesFetched: 0,
    searchFailures: [],
    fetchFailures: [],
    factsAdded: preparation.factsAdded,
    verifiedFactsAdded: preparation.factsAdded,
    unverifiedFactsAdded: 0,
    holdingsAdded: preparation.holdingsAdded,
    verifiedHoldingsAdded: preparation.holdingsAdded,
    unverifiedHoldingsAdded: 0,
    rejectedItems: [],
    modelRetries: 0,
    coverageIssue: preparation.health?.complete
      ? null
      : {
        code: "no_supported_evidence" as const,
        message: "Alpha Vantage returned some fund data, but the fund strategy/theme, primary exposure, or required complex-fund structure is still missing.",
      },
    sources: preparation.factsAdded || preparation.holdingsAdded ? [{
      id: "alpha-vantage-profile",
      title: "Alpha Vantage Structured Profile",
      url: "https://www.alphavantage.co/documentation/#etf-profile",
      sourceType: "structured_provider",
      trusted: true,
    }] : [],
    provider: "alpha_vantage",
    alphaAttempt,
  } satisfies FundResearchResult & { provider: string; alphaAttempt: AlphaVantageAttempt };
}

export async function POST(request: Request) {
  let ticker = "";
  let fundName = "";
  let securityType: "etf" | "closed_end_fund" = "etf";
  let officialDomains: string[] = [];
  try {
    const body: unknown = await request.json();
    if (!isObject(body)) throw new Error("Fund research input must be an object.");
    ticker = cleanFundTicker(body.ticker);
    fundName = typeof body.fundName === "string" ? body.fundName.trim().slice(0, 200) : "";
    if (body.securityType !== "etf" && body.securityType !== "closed_end_fund") {
      throw new Error("Fund security type must be ETF or closed-end fund.");
    }
    securityType = body.securityType;
    officialDomains = normalizeOfficialDomains(Array.isArray(body.officialDomains)
      ? body.officialDomains.filter((value): value is string => typeof value === "string")
      : []);
    if (!ticker || !fundName) throw new Error("A valid ticker and fund name are required.");
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Fund research input is invalid." }, { status: 400 });
  }

  try {
    const store = new D1FundProfileStore(getD1Database());
    const existing = await store.getByTicker(ticker);
    if (existing && assessFundProfile(existing).reusable) {
      return Response.json({
        status: "reused", ticker, profile: existing, health: assessFundProfile(existing),
        searchesRequested: 0, searchResults: 0, pagesRequested: 0, pagesFetched: 0,
        searchFailures: [], fetchFailures: [], factsAdded: 0, verifiedFactsAdded: 0, unverifiedFactsAdded: 0,
        holdingsAdded: 0, verifiedHoldingsAdded: 0, unverifiedHoldingsAdded: 0,
        rejectedItems: [], modelRetries: 0, coverageIssue: null, sources: [], provider: "local_cache",
        alphaAttempt: {
          status: "skipped_local_cache", endpoint: null, apiCalls: 0, factsAdded: 0, errorCode: null,
          message: "Reusable local profile found; Alpha Vantage was not called.",
        } satisfies AlphaVantageAttempt,
      });
    }

    const alphaApiKey = process.env.ALPHA_VANTAGE_API_KEY?.trim() ?? "";
    const tavilyApiKey = process.env.TAVILY_API_KEY?.trim() ?? "";
    let structured: StructuredFundPreparation | null = null;
    let structuredProviderIssue: string | null = null;
    let alphaAttempt: AlphaVantageAttempt = {
      status: alphaApiKey ? "insufficient" : "not_configured",
      endpoint: alphaApiKey ? (securityType === "etf" ? "ETF_PROFILE" : "OVERVIEW") : null,
      apiCalls: 0,
      factsAdded: 0,
      errorCode: alphaApiKey ? null : "not_configured",
      message: alphaApiKey ? null : "Alpha Vantage is not configured in the running app.",
    };
    if (alphaApiKey) {
      try {
        structured = await prepareFundFromAlphaVantage({
          ticker,
          fundName,
          securityType,
          client: new AlphaVantageClient({ apiKey: alphaApiKey }),
          store,
        });
        alphaAttempt = {
          status: structured.health?.reusable ? "success" : "insufficient",
          endpoint: securityType === "etf" ? "ETF_PROFILE" : "OVERVIEW",
          apiCalls: 1,
          factsAdded: structured.factsAdded,
          errorCode: null,
          message: structured.health?.reusable
            ? "Alpha Vantage returned enough structured fund fields."
            : "Alpha Vantage returned a response, but strategy/theme, exposure, or complex-fund mechanics are still incomplete.",
        };
        if (structured.health?.reusable) return Response.json(alphaResult(ticker, structured, alphaAttempt));
      } catch (error) {
        structuredProviderIssue = error instanceof AlphaVantageError
          ? error.message
          : "Alpha Vantage fund profile preparation failed.";
        alphaAttempt = {
          status: "failed",
          endpoint: securityType === "etf" ? "ETF_PROFILE" : "OVERVIEW",
          apiCalls: 1,
          factsAdded: structured?.factsAdded ?? 0,
          errorCode: error instanceof AlphaVantageError ? error.code : "request_failed",
          message: structuredProviderIssue,
        };
      }
    }

    if (tavilyApiKey) {
      const configuration = getOllamaConfiguration();
      const agent = new FundResearchAgent({
        ollama: new OllamaClient(configuration.researchModel, configuration.baseUrl),
        store,
        tools: new ControlledFundResearchTools({ tavilyApiKey }),
      });
      const result = await agent.research({ ticker, fundName, securityType, officialDomains });
      return Response.json({
        ...result,
        provider: structured?.factsAdded ? "alpha_vantage+controlled_web" : "controlled_web",
        structuredProviderIssue,
        alphaAttempt,
      });
    }

    if (structured) return Response.json({ ...alphaResult(ticker, structured, alphaAttempt), structuredProviderIssue });
    const missing = alphaApiKey
      ? structuredProviderIssue ?? "Alpha Vantage did not return a usable fund profile."
      : "Profile preparation is not configured. Add ALPHA_VANTAGE_API_KEY or TAVILY_API_KEY to .env.local and restart the app.";
    return Response.json({ error: missing }, { status: 503 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Controlled fund research failed.";
    return Response.json({ error: message }, { status: error instanceof OllamaError ? 502 : 500 });
  }
}
