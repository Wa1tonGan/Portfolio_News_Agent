import {
  AlphaVantageClient,
  AlphaVantageError,
  summarizeAlphaVantageResponse,
  type AlphaVantageFunction,
} from "../../../../lib/alpha-vantage.ts";

export const dynamic = "force-dynamic";

type SupportedSecurityType = "stock" | "adr" | "reit" | "etf" | "closed_end_fund";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function endpointFor(securityType: SupportedSecurityType): AlphaVantageFunction {
  return securityType === "etf" ? "ETF_PROFILE" : "OVERVIEW";
}

export async function GET() {
  const configured = Boolean(process.env.ALPHA_VANTAGE_API_KEY?.trim());
  return Response.json({
    configured,
    connected: false,
    apiCalls: 0,
    pagesFetched: 0,
    modelUsed: false,
    message: configured
      ? "Alpha Vantage is configured. Run an Alpha-only test to verify one selected ticker."
      : "Add ALPHA_VANTAGE_API_KEY to .env.local and restart the app.",
  });
}

export async function POST(request: Request) {
  let ticker = "";
  let securityType: SupportedSecurityType;
  try {
    const body: unknown = await request.json();
    if (!isObject(body)) throw new Error("Alpha test input must be an object.");
    ticker = typeof body.ticker === "string" ? body.ticker.trim().toUpperCase() : "";
    if (!/^[A-Z0-9][A-Z0-9._-]{0,29}$/.test(ticker)) throw new Error("A valid ticker is required.");
    if (body.securityType !== "stock" && body.securityType !== "adr" && body.securityType !== "reit"
      && body.securityType !== "etf" && body.securityType !== "closed_end_fund") {
      throw new Error("A supported security type is required.");
    }
    securityType = body.securityType;
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Alpha test input is invalid." }, { status: 400 });
  }

  const apiKey = process.env.ALPHA_VANTAGE_API_KEY?.trim() ?? "";
  if (!apiKey) {
    return Response.json({
      configured: false,
      connected: false,
      ticker,
      apiCalls: 0,
      pagesFetched: 0,
      modelUsed: false,
      message: "Alpha Vantage is not configured in the running app. Restart after updating .env.local.",
    }, { status: 503 });
  }

  const endpoint = endpointFor(securityType);
  try {
    const client = new AlphaVantageClient({ apiKey });
    const response = await client.request(endpoint, ticker);
    const summary = response ? summarizeAlphaVantageResponse(endpoint, response) : null;
    return Response.json({
      configured: true,
      connected: true,
      ticker,
      endpoint,
      apiCalls: 1,
      pagesFetched: 0,
      modelUsed: false,
      fieldNames: summary?.fieldNames ?? [],
      usableFields: summary?.usableFields ?? [],
      sectorCount: summary?.sectorCount ?? 0,
      holdingCount: summary?.holdingCount ?? 0,
      readyForBaseline: summary?.readyForBaseline ?? false,
      requiresComplexFundResearch: summary?.requiresComplexFundResearch ?? false,
      message: summary
        ? "Alpha Vantage returned a valid structured response. Nothing was saved and no fallback ran."
        : "Alpha Vantage returned an empty structured response. Nothing was saved and no fallback ran.",
    });
  } catch (error) {
    const known = error instanceof AlphaVantageError ? error : null;
    const status = known?.code === "authentication" ? 401 : known?.code === "rate_limit" ? 429 : 502;
    return Response.json({
      configured: true,
      connected: false,
      ticker,
      endpoint,
      apiCalls: 1,
      pagesFetched: 0,
      modelUsed: false,
      errorCode: known?.code ?? "request_failed",
      message: known?.message ?? "Alpha Vantage test failed.",
    }, { status });
  }
}
