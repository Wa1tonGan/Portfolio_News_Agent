import { getD1Database } from "../../../../db";
import {
  AlphaVantageClient,
  AlphaVantageError,
  type AlphaVantageAttempt,
} from "../../../../lib/alpha-vantage";
import { CompanyResearchAgent, type CompanyResearchResult } from "../../../../lib/company-research-agent";
import { assessCompanyProfile } from "../../../../lib/company-profile-contracts";
import { ControlledCompanyResearchTools, normalizeOfficialDomains } from "../../../../lib/company-research-tools";
import { cleanCompanyTicker } from "../../../../lib/company-profile-input";
import { D1CompanyProfileStore } from "../../../../lib/company-profile-store";
import { getOllamaConfiguration, OllamaClient, OllamaError } from "../../../../lib/ollama";
import {
  prepareCompanyFromAlphaVantage,
  type StructuredCompanyPreparation,
} from "../../../../lib/structured-profile-preparation";

export const dynamic = "force-dynamic";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function alphaResult(ticker: string, preparation: StructuredCompanyPreparation, alphaAttempt: AlphaVantageAttempt) {
  return {
    status: preparation.factsAdded ? "updated" : "no_sources",
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
    rejectedFacts: [],
    modelRetries: 0,
    sources: preparation.factsAdded ? [{
      id: "alpha-vantage-overview",
      title: "Alpha Vantage Company Overview",
      url: "https://www.alphavantage.co/documentation/#company-overview",
      sourceType: "structured_provider",
      trusted: true,
    }] : [],
    provider: "alpha_vantage",
    alphaAttempt,
  } satisfies CompanyResearchResult & { provider: string; alphaAttempt: AlphaVantageAttempt };
}

export async function POST(request: Request) {
  let ticker = "";
  let companyName = "";
  let officialDomains: string[] = [];
  try {
    const body: unknown = await request.json();
    if (!isObject(body)) throw new Error("Research input must be an object.");
    ticker = cleanCompanyTicker(body.ticker);
    companyName = typeof body.companyName === "string" ? body.companyName.trim().slice(0, 160) : "";
    officialDomains = normalizeOfficialDomains(Array.isArray(body.officialDomains)
      ? body.officialDomains.filter((value): value is string => typeof value === "string")
      : []);
    if (!ticker || !companyName) throw new Error("A valid ticker and company name are required.");
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Research input is invalid." }, { status: 400 });
  }

  try {
    const store = new D1CompanyProfileStore(getD1Database());
    const existing = await store.getByTicker(ticker);
    if (existing && assessCompanyProfile(existing).reusable) {
      return Response.json({
        status: "reused", ticker, profile: existing, health: assessCompanyProfile(existing),
        searchesRequested: 0, searchResults: 0, pagesRequested: 0, pagesFetched: 0,
        searchFailures: [], fetchFailures: [], factsAdded: 0, verifiedFactsAdded: 0, unverifiedFactsAdded: 0,
        rejectedFacts: [], modelRetries: 0, sources: [], provider: "local_cache",
        alphaAttempt: {
          status: "skipped_local_cache", endpoint: null, apiCalls: 0, factsAdded: 0, errorCode: null,
          message: "Reusable local profile found; Alpha Vantage was not called.",
        } satisfies AlphaVantageAttempt,
      });
    }

    const alphaApiKey = process.env.ALPHA_VANTAGE_API_KEY?.trim() ?? "";
    const tavilyApiKey = process.env.TAVILY_API_KEY?.trim() ?? "";
    let structured: StructuredCompanyPreparation | null = null;
    let structuredProviderIssue: string | null = null;
    let alphaAttempt: AlphaVantageAttempt = {
      status: alphaApiKey ? "insufficient" : "not_configured",
      endpoint: alphaApiKey ? "OVERVIEW" : null,
      apiCalls: 0,
      factsAdded: 0,
      errorCode: alphaApiKey ? null : "not_configured",
      message: alphaApiKey ? null : "Alpha Vantage is not configured in the running app.",
    };
    if (alphaApiKey) {
      try {
        structured = await prepareCompanyFromAlphaVantage({
          ticker,
          companyName,
          client: new AlphaVantageClient({ apiKey: alphaApiKey }),
          store,
        });
        alphaAttempt = {
          status: structured.health?.reusable ? "success" : "insufficient",
          endpoint: "OVERVIEW",
          apiCalls: 1,
          factsAdded: structured.factsAdded,
          errorCode: null,
          message: structured.health?.reusable
            ? "Alpha Vantage returned enough structured company fields."
            : "Alpha Vantage returned a response, but the company baseline is still incomplete.",
        };
        if (structured.health?.reusable) return Response.json(alphaResult(ticker, structured, alphaAttempt));
      } catch (error) {
        structuredProviderIssue = error instanceof AlphaVantageError
          ? error.message
          : "Alpha Vantage company profile preparation failed.";
        alphaAttempt = {
          status: "failed",
          endpoint: "OVERVIEW",
          apiCalls: 1,
          factsAdded: structured?.factsAdded ?? 0,
          errorCode: error instanceof AlphaVantageError ? error.code : "request_failed",
          message: structuredProviderIssue,
        };
      }
    }

    if (tavilyApiKey) {
      const configuration = getOllamaConfiguration();
      const agent = new CompanyResearchAgent({
        ollama: new OllamaClient(configuration.researchModel, configuration.baseUrl),
        extractionOllama: new OllamaClient(configuration.researchModel, configuration.baseUrl),
        store,
        tools: new ControlledCompanyResearchTools({ tavilyApiKey }),
      });
      const result = await agent.research({ ticker, companyName, officialDomains });
      return Response.json({
        ...result,
        provider: structured?.factsAdded ? "alpha_vantage+controlled_web" : "controlled_web",
        structuredProviderIssue,
        alphaAttempt,
      });
    }

    if (structured) return Response.json({ ...alphaResult(ticker, structured, alphaAttempt), structuredProviderIssue });
    const missing = alphaApiKey
      ? structuredProviderIssue ?? "Alpha Vantage did not return a usable company profile."
      : "Profile preparation is not configured. Add ALPHA_VANTAGE_API_KEY or TAVILY_API_KEY to .env.local and restart the app.";
    return Response.json({ error: missing }, { status: 503 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Controlled company research failed.";
    const status = error instanceof OllamaError ? 502 : 500;
    return Response.json({ error: message }, { status });
  }
}
