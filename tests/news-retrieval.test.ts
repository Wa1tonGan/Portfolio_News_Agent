import assert from "node:assert/strict";
import test from "node:test";
import type { CompanyProfileContext } from "../lib/company-profile-contracts.ts";
import type { FundProfileContext } from "../lib/fund-profile-contracts.ts";
import {
  buildMacroSearchTopics,
  buildMicroSearchTerms,
  parseJin10ListPage,
  parseJin10Time,
  selectRetrievalBatch,
  utc8Day,
  verifyFreshNews,
  type RawNewsCandidate,
} from "../lib/news-retrieval.ts";

const asOf = new Date("2026-07-24T04:00:00.000Z");

function raw(
  kind: "flash" | "news",
  id: string,
  time: string | undefined,
  retrievedBy: RawNewsCandidate["retrievedBy"],
  matchedKeyword: string | null = null,
): RawNewsCandidate {
  return {
    kind,
    retrievedBy,
    matchedKeyword,
    relatedTickers: matchedKeyword ? ["GOOG"] : [],
    item: { id, title: `News ${id}`, content: `Content ${id}`, ...(time === undefined ? {} : { time }) },
  };
}

function missingCompany(ticker: string, name: string): CompanyProfileContext {
  return {
    ticker, companyName: name, availability: "missing", complete: false, stale: false, reusable: false,
    missingCategories: ["sector", "industry", "products", "regions", "revenue_drivers", "cost_drivers", "currency_exposures", "macro_exposures"],
    conflicts: [], verifiedFactCount: 0, unverifiedFactCount: 0, facts: [], technicalError: null,
  };
}

const fundContext: FundProfileContext = {
  ticker: "QQQM",
  fundName: "Invesco NASDAQ 100 ETF",
  availability: "ready",
  complete: true,
  stale: false,
  reusable: true,
  missingCategories: [],
  missingExposure: false,
  missingNature: false,
  missingStructureFields: [],
  factConflicts: [],
  holdingConflicts: [],
  verifiedFactCount: 2,
  unverifiedFactCount: 0,
  verifiedHoldingCount: 1,
  unverifiedHoldingCount: 0,
  technicalError: null,
  facts: [
    {
      id: "benchmark", category: "benchmark", factKey: "primary", value: "NASDAQ-100 Index",
      status: "verified", sourceType: "official_factsheet", sourceUrl: "https://example.com/factsheet",
      evidenceText: "Tracks the NASDAQ-100 Index.", effectiveDate: "2026-07-01",
      lastVerificationDate: "2026-07-24", createdAt: "2026-07-24T00:00:00Z", updatedAt: "2026-07-24T00:00:00Z",
    },
    {
      id: "sector", category: "sector_exposure", factKey: "primary", value: "Technology and semiconductor companies",
      status: "verified", sourceType: "official_factsheet", sourceUrl: "https://example.com/factsheet",
      evidenceText: "Technology is a major exposure.", effectiveDate: "2026-07-01",
      lastVerificationDate: "2026-07-24", createdAt: "2026-07-24T00:00:00Z", updatedAt: "2026-07-24T00:00:00Z",
    },
  ],
  holdings: [{
    id: "holding", constituentTicker: "NVDA", constituentName: "NVIDIA Corporation", weightPercent: 9,
    country: "United States", sector: "Semiconductors", currency: "USD", status: "verified",
    sourceType: "official_holdings", sourceUrl: "https://example.com/holdings", evidenceText: "NVIDIA 9%",
    effectiveDate: "2026-07-23", lastVerificationDate: "2026-07-24",
    createdAt: "2026-07-24T00:00:00Z", updatedAt: "2026-07-24T00:00:00Z",
  }],
};

test("Jin10 time parsing treats timezone-less values as UTC+8", () => {
  assert.equal(new Date(parseJin10Time("2026-07-24 10:30:00", asOf)!).toISOString(), "2026-07-24T02:30:00.000Z");
  assert.equal(new Date(parseJin10Time("07-24 11:00", asOf)!).toISOString(), "2026-07-24T03:00:00.000Z");
  assert.equal(new Date(parseJin10Time("11:30", asOf)!).toISOString(), "2026-07-24T03:30:00.000Z");
  assert.equal(utc8Day(asOf.getTime()), "2026-07-24");
});

test("Jin10 list parsing uses data.items and cursor pagination fields", () => {
  const page = parseJin10ListPage({
    isError: false,
    structuredContent: { data: { items: [{ id: 123 }], next_cursor: "cursor-2", has_more: true } },
  });
  assert.equal(page.items.length, 1);
  assert.equal(page.nextCursor, "cursor-2");
  assert.equal(page.hasMore, true);
});

test("freshness verification inherits time by Jin10 ID and rejects old, future, missing, and invalid times", () => {
  const result = verifyFreshNews({
    asOf,
    latest: [raw("flash", "same", "2026-07-24 10:00:00", "latest_flash")],
    searched: [
      raw("flash", "same", undefined, "micro_search", "Alphabet"),
      raw("news", "valid", "2026-07-24T03:00:00Z", "macro_search", "美联储"),
      raw("news", "old", "2026-07-23T03:00:00Z", "macro_search", "美元"),
      raw("news", "future", "2026-07-24T06:00:00Z", "macro_search", "美国利率"),
      raw("news", "missing", undefined, "micro_search", "Google"),
      raw("news", "invalid", "not-a-time", "micro_search", "Google"),
    ],
    calendar: [],
  });
  assert.equal(result.accepted.length, 2);
  const inherited = result.accepted.find((item) => item.sourceId === "same");
  assert.equal(inherited?.time, "2026-07-24T02:00:00.000Z");
  assert.deepEqual(new Set(inherited?.retrievedBy), new Set(["micro_search", "latest_flash"]));
  assert.equal(result.rejected.stale, 1);
  assert.equal(result.rejected.future, 1);
  assert.equal(result.rejected.missing_time, 1);
  assert.equal(result.rejected.invalid_time, 1);
});

test("Micro terms use verified names and fund evidence instead of interpreting ticker letters", () => {
  const alphabetProfile = missingCompany("GOOG", "Alphabet Inc.");
  alphabetProfile.facts = [{
    id: "alias", category: "aliases", factKey: "brand", value: "Google", status: "verified",
    sourceType: "user_provided", sourceUrl: null, evidenceText: "Google is a verified alias.",
    lastVerificationDate: "2026-07-24", createdAt: "2026-07-24T00:00:00Z", updatedAt: "2026-07-24T00:00:00Z",
  }];
  const terms = buildMicroSearchTerms({
    holdings: [
      { ticker: "GOOG", companyName: "Alphabet-C", registeredName: "Alphabet Inc. Class C Capital Stock", securityType: "stock" },
      { ticker: "QQQM", companyName: "Invesco NASDAQ 100 ETF", registeredName: "Invesco NASDAQ 100 ETF", securityType: "etf" },
    ],
    companyProfiles: [alphabetProfile],
    fundProfiles: [fundContext],
    maximumTerms: 6,
  });
  assert.equal(terms.some((term) => term.keyword === "GOOG"), false);
  assert.equal(terms.some((term) => term.keyword === "Alphabet"), true);
  assert.equal(terms.some((term) => term.keyword === "Google"), true);
  assert.equal(terms.some((term) => term.keyword.includes("NASDAQ-100")), true);
  assert.equal(terms.some((term) => term.keyword.includes("NVIDIA")), true);
});

test("Macro topics combine universal US topics with verified fund exposure", () => {
  const topics = buildMacroSearchTopics({
    holdings: [{ ticker: "QQQM", companyName: "Invesco NASDAQ 100 ETF", securityType: "etf" }],
    companyProfiles: [],
    fundProfiles: [fundContext],
    maximumTopics: 10,
  });
  assert.equal(topics.some((topic) => topic.keyword === "美联储"), true);
  assert.equal(topics.some((topic) => topic.keyword === "美国CPI"), true);
  assert.equal(topics.some((topic) => topic.keyword === "半导体政策"), true);
});

test("retrieval selection keeps Micro, Macro, calendar, and latest fallback represented", () => {
  const verified = verifyFreshNews({
    asOf,
    latest: [raw("flash", "latest", "2026-07-24T03:00:00Z", "latest_flash")],
    searched: [
      raw("flash", "micro", "2026-07-24T03:10:00Z", "micro_search", "Alphabet"),
      raw("news", "macro", "2026-07-24T03:20:00Z", "macro_search", "美联储"),
    ],
    calendar: [{
      kind: "calendar", retrievedBy: "calendar", matchedKeyword: null, relatedTickers: [],
      item: { id: "calendar", title: "美国经济数据", content: "公布值", pub_time: "2026-07-24 11:30:00" },
    }],
  });
  const selected = selectRetrievalBatch(verified.accepted, 4);
  assert.equal(selected.length, 4);
  assert.deepEqual(
    new Set(selected.flatMap((item) => item.retrievedBy)),
    new Set(["micro_search", "macro_search", "calendar", "latest_flash"]),
  );
});
