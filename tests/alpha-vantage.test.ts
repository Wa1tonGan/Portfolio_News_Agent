import assert from "node:assert/strict";
import test from "node:test";
import {
  AlphaVantageClient,
  AlphaVantageError,
  summarizeAlphaVantageResponse,
} from "../lib/alpha-vantage.ts";
import { mergeCompanyProfiles, type CompanyProfile } from "../lib/company-profile-contracts.ts";
import { mergeFundProfiles, type FundProfile } from "../lib/fund-profile-contracts.ts";
import {
  prepareCompanyFromAlphaVantage,
  prepareFundFromAlphaVantage,
} from "../lib/structured-profile-preparation.ts";

class MemoryCompanyStore {
  profile: CompanyProfile | null = null;

  async getByTicker(ticker: string) {
    return this.profile?.ticker === ticker ? this.profile : null;
  }

  async save(incoming: CompanyProfile) {
    this.profile = mergeCompanyProfiles(this.profile, incoming);
    return this.profile;
  }
}

class MemoryFundStore {
  profile: FundProfile | null = null;

  async getByTicker(ticker: string) {
    return this.profile?.ticker === ticker ? this.profile : null;
  }

  async save(incoming: FundProfile) {
    this.profile = mergeFundProfiles(this.profile, incoming);
    return this.profile;
  }
}

test("Alpha Vantage client sends a bounded structured-profile request without exposing its key in errors", async () => {
  let requestedUrl = "";
  let redirectMode: RequestRedirect | undefined;
  const client = new AlphaVantageClient({
    apiKey: "private-test-key",
    fetcher: (async (input, init) => {
      requestedUrl = String(input);
      redirectMode = init?.redirect;
      return Response.json({ Symbol: "O", Name: "Realty Income Corporation" });
    }) as typeof fetch,
  });
  await client.getCompanyOverview("o");
  const url = new URL(requestedUrl);
  assert.equal(url.origin + url.pathname, "https://www.alphavantage.co/query");
  assert.equal(url.searchParams.get("function"), "OVERVIEW");
  assert.equal(url.searchParams.get("symbol"), "O");
  assert.equal(url.searchParams.get("apikey"), "private-test-key");
  assert.equal(redirectMode, "manual");

  const limited = new AlphaVantageClient({
    apiKey: "private-test-key",
    fetcher: (async () => Response.json({ Note: "API call frequency limit reached." })) as typeof fetch,
  });
  await assert.rejects(
    limited.getCompanyOverview("O"),
    (error: unknown) => error instanceof AlphaVantageError
      && error.code === "rate_limit"
      && !error.message.includes("private-test-key"),
  );
});

test("real documented company and ETF response shapes produce sanitized readiness diagnostics", () => {
  const company = summarizeAlphaVantageResponse("OVERVIEW", {
    Symbol: "O",
    Name: "Realty Income Corporation",
    Description: "A real estate investment trust.",
    Exchange: "NYSE",
    Country: "USA",
    Sector: "REAL ESTATE",
    Industry: "REIT - RETAIL",
    OfficialSite: "https://www.realtyincome.com",
  });
  assert.equal(company.readyForBaseline, true);
  assert.deepEqual(company.usableFields, [
    "Symbol", "Name", "Description", "Exchange", "Country", "Sector", "Industry", "OfficialSite",
  ]);

  const etf = summarizeAlphaVantageResponse("ETF_PROFILE", {
    net_assets: "25900000000",
    net_expense_ratio: "0.0029",
    leveraged: "NO",
    sectors: [{ sector: "TECHNOLOGY", weight: "0.58" }],
    holdings: [
      { symbol: "NVDA", description: "NVIDIA Corp", weight: "0.09" },
      { symbol: "MSFT", description: "Microsoft Corp", weight: "0.08" },
      { symbol: "AAPL", description: "Apple Inc", weight: "0.07" },
    ],
  });
  assert.equal(etf.readyForBaseline, true);
  assert.equal(etf.sectorCount, 1);
  assert.equal(etf.holdingCount, 3);
  assert.equal(etf.requiresComplexFundResearch, false);

  const leveraged = summarizeAlphaVantageResponse("ETF_PROFILE", {
    leveraged: "YES",
    sectors: [{ sector: "TECHNOLOGY", weight: "1.0" }],
  });
  assert.equal(leveraged.readyForBaseline, false);
  assert.equal(leveraged.requiresComplexFundResearch, true);
});

test("a REIT is prepared as a company from OVERVIEW business-nature fields", async () => {
  const store = new MemoryCompanyStore();
  const result = await prepareCompanyFromAlphaVantage({
    ticker: "O",
    companyName: "Realty Income",
    client: {
      getCompanyOverview: async () => ({
        Symbol: "O",
        Name: "Realty Income Corporation",
        Sector: "REAL ESTATE",
        Industry: "REAL ESTATE INVESTMENT TRUSTS",
        Description: "A real estate investment trust that owns commercial properties under long-term net leases.",
      }),
    },
    store,
    now: new Date("2026-07-24T01:00:00.000Z"),
  });
  assert.equal(result.health?.reusable, true);
  assert.deepEqual(
    new Set(result.profile?.facts.map((fact) => fact.category)),
    new Set(["aliases", "sector", "industry", "products"]),
  );
  assert.equal(result.profile?.facts.every((fact) =>
    fact.status === "verified"
    && fact.sourceType === "structured_provider"
    && !fact.sourceUrl?.includes("apikey")), true);
});

test("a normal ETF saves meaningful sectors and holdings as its grounded nature", async () => {
  const store = new MemoryFundStore();
  const result = await prepareFundFromAlphaVantage({
    ticker: "QQQ",
    fundName: "Invesco QQQ Trust",
    securityType: "etf",
    client: {
      getCompanyOverview: async () => null,
      getEtfProfile: async () => ({
        symbol: "QQQ",
        sectors: [
          { sector: "ENERGY", weight: "0.00" },
          { sector: "TECHNOLOGY", weight: "0.58" },
          { sector: "COMMUNICATION SERVICES", weight: "0.16" },
        ],
        holdings: [
          { symbol: "NVDA", description: "NVIDIA Corp", weight: "0.09" },
          { symbol: "MSFT", description: "Microsoft Corp", weight: "0.08" },
          { symbol: "AAPL", description: "Apple Inc", weight: "7%" },
        ],
      }),
    },
    store,
    now: new Date("2026-07-24T01:00:00.000Z"),
  });
  assert.equal(result.health?.reusable, true);
  assert.equal(result.health?.missingExposure, false);
  assert.deepEqual(result.health?.missingCategories, []);
  assert.equal(result.profile?.facts.some((fact) => fact.category === "sector_exposure"), true);
  assert.equal(result.profile?.facts.some((fact) => fact.value.includes("0%")), false);
  assert.equal(result.profile?.facts.some((fact) => fact.value === "TECHNOLOGY: 58%"), true);
  assert.equal(result.profile?.holdings.length, 3);
  assert.equal(result.profile?.holdings.find((holding) => holding.constituentTicker === "NVDA")?.weightPercent, 9);
  assert.equal(result.holdingsAdded, 3);
  assert.equal(result.health?.missingNature, false);
});

test("a thematic ETF is not reusable when Alpha returns only generic sector rows", async () => {
  const store = new MemoryFundStore();
  const result = await prepareFundFromAlphaVantage({
    ticker: "DRAM",
    fundName: "Roundhill Memory ETF",
    securityType: "etf",
    client: {
      getCompanyOverview: async () => null,
      getEtfProfile: async () => ({
        symbol: "DRAM",
        sectors: [
          { sector: "INFORMATION TECHNOLOGY", weight: "0.189" },
          { sector: "UTILITIES", weight: "0.00" },
        ],
        holdings: [],
      }),
    },
    store,
    now: new Date("2026-07-24T01:00:00.000Z"),
  });
  assert.equal(result.health?.missingExposure, false);
  assert.equal(result.health?.missingNature, true);
  assert.equal(result.health?.reusable, false);
});

test("Alpha Vantage identity and exposure do not make a complex ETF complete by themselves", async () => {
  const store = new MemoryFundStore();
  const result = await prepareFundFromAlphaVantage({
    ticker: "SQQQ",
    fundName: "ProShares UltraPro Short QQQ",
    securityType: "etf",
    client: {
      getCompanyOverview: async () => null,
      getEtfProfile: async () => ({
        symbol: "SQQQ",
        sectors: [{ sector: "TECHNOLOGY", weight: "0.55" }],
      }),
    },
    store,
    now: new Date("2026-07-24T01:00:00.000Z"),
  });
  assert.equal(result.health?.reusable, false);
  assert.deepEqual(result.health?.missingStructureFields, ["leverageMultiplier", "inverse", "dailyReset"]);
});

test("a structured leveraged indicator forces controlled research even when the fund name is ambiguous", async () => {
  const store = new MemoryFundStore();
  const result = await prepareFundFromAlphaVantage({
    ticker: "TEST",
    fundName: "Example Tactical ETF",
    securityType: "etf",
    client: {
      getCompanyOverview: async () => null,
      getEtfProfile: async () => ({
        symbol: "TEST",
        leveraged: "YES",
        sectors: [{ sector: "ENERGY", weight: "1.0" }],
      }),
    },
    store,
    now: new Date("2026-07-24T01:00:00.000Z"),
  });
  assert.equal(result.health?.reusable, false);
  assert.deepEqual(result.health?.missingStructureFields, ["leverageMultiplier", "dailyReset"]);
});

test("a closed-end fund can use OVERVIEW as a best-effort baseline", async () => {
  const store = new MemoryFundStore();
  const result = await prepareFundFromAlphaVantage({
    ticker: "UTF",
    fundName: "Cohen & Steers Infrastructure Fund",
    securityType: "closed_end_fund",
    client: {
      getCompanyOverview: async () => ({
        Symbol: "UTF",
        Name: "Cohen & Steers Infrastructure Fund",
        Sector: "FINANCE",
        Industry: "CLOSED-END FUND",
        Description: "A diversified closed-end fund focused on infrastructure companies.",
      }),
      getEtfProfile: async () => null,
    },
    store,
    now: new Date("2026-07-24T01:00:00.000Z"),
  });
  assert.equal(result.health?.reusable, true);
  assert.equal(result.profile?.securityType, "closed_end_fund");
  assert.equal(result.profile?.facts.some((fact) => fact.category === "asset_class_exposure"), true);
});

test("a mismatched structured ticker is never saved", async () => {
  const store = new MemoryCompanyStore();
  const result = await prepareCompanyFromAlphaVantage({
    ticker: "AAPL",
    companyName: "Apple Inc.",
    client: {
      getCompanyOverview: async () => ({
        Symbol: "MSFT",
        Sector: "TECHNOLOGY",
        Industry: "SOFTWARE",
        Description: "Software company.",
      }),
    },
    store,
  });
  assert.equal(result.profile, null);
  assert.equal(result.factsAdded, 0);
  assert.equal(store.profile, null);
});
