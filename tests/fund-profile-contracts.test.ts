import assert from "node:assert/strict";
import test from "node:test";
import {
  assessFundProfile,
  createFundProfileContext,
  findFundFactConflicts,
  findFundHoldingConflicts,
  mergeFundProfiles,
  validateFundFact,
  validateFundHolding,
  validateFundProfile,
  type FundFact,
  type FundHolding,
  type FundProfile,
} from "../lib/fund-profile-contracts.ts";
import { createUserFundProfile } from "../lib/fund-profile-input.ts";

const timestamp = "2026-07-23T04:00:00.000Z";

function fact(overrides: Partial<FundFact> = {}): FundFact {
  return {
    id: "fact-type",
    category: "fund_type",
    factKey: "primary",
    value: "ETF",
    status: "verified",
    sourceType: "official_factsheet",
    sourceUrl: "https://example.com/factsheet",
    evidenceText: "The official factsheet identifies this product as an ETF.",
    effectiveDate: null,
    lastVerificationDate: "2026-07-23",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function holding(overrides: Partial<FundHolding> = {}): FundHolding {
  return {
    id: "holding-aapl",
    constituentTicker: "AAPL",
    constituentName: "Apple Inc.",
    weightPercent: 6.4,
    country: "United States",
    sector: "Information Technology",
    currency: "USD",
    status: "verified",
    sourceType: "official_holdings",
    sourceUrl: "https://example.com/holdings",
    evidenceText: "The official holdings file lists Apple at 6.4%.",
    effectiveDate: "2026-07-22",
    lastVerificationDate: "2026-07-23",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function profile(facts: FundFact[] = [], holdings: FundHolding[] = []): FundProfile {
  return {
    id: "fund-voo",
    ticker: "VOO",
    fundName: "Vanguard S&P 500 ETF",
    issuerName: "Vanguard",
    securityType: "etf",
    structure: { leverageMultiplier: 1, inverse: false, dailyReset: false, coveredCall: false, activelyManaged: false },
    facts,
    holdings,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastReviewedAt: timestamp,
  };
}

test("fund source integrity rejects unsafe web evidence and verified model memory", () => {
  const unsafe = validateFundFact(fact({ sourceUrl: "http://example.com/factsheet" }));
  assert.equal(unsafe.valid, false);
  assert.match(unsafe.errors.join(" "), /HTTPS/);
  const memory = validateFundHolding(holding({ sourceType: "model_memory", sourceUrl: null }));
  assert.equal(memory.valid, false);
  assert.match(memory.errors.join(" "), /Model memory/);
});

test("fund structure and holding values are validated", () => {
  assert.equal(validateFundHolding(holding({ weightPercent: 101 })).valid, false);
  const badStructure = profile();
  badStructure.structure = { ...badStructure.structure, leverageMultiplier: -1, inverse: false };
  const result = validateFundProfile(badStructure);
  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /Inverse flag/);
});

test("verified facts and holdings cannot be silently overwritten by suggestions", () => {
  const existing = profile([fact()], [holding()]);
  const incoming = profile(
    [fact({ id: "fact-type-suggestion", value: "Closed-end fund", status: "unverified", sourceType: "model_memory", sourceUrl: null, evidenceText: "Model suggestion only." })],
    [holding({ id: "holding-aapl-suggestion", weightPercent: 4, status: "unverified", sourceType: "model_memory", sourceUrl: null, evidenceText: "Model suggestion only." })],
  );
  const merged = mergeFundProfiles(existing, incoming);
  assert.equal(merged.facts.length, 2);
  assert.equal(merged.holdings.length, 2);
  assert.equal(merged.facts.find((item) => item.id === "fact-type")?.status, "verified");
  assert.equal(merged.holdings.find((item) => item.id === "holding-aapl")?.weightPercent, 6.4);
});

test("same-date contradictions conflict while dated holding history does not", () => {
  const sameDate = holding({ id: "holding-aapl-2", weightPercent: 7 });
  assert.equal(findFundHoldingConflicts([holding(), sameDate]).length, 1);
  const later = holding({ id: "holding-aapl-later", weightPercent: 7, effectiveDate: "2026-07-23" });
  assert.equal(findFundHoldingConflicts([holding(), later]).length, 0);

  const conflictingFact = fact({ id: "fact-type-2", value: "Closed-end fund" });
  assert.equal(findFundFactConflicts([fact(), conflictingFact]).length, 1);
  const historicalFact = fact({ id: "fact-type-older", value: "Closed-end fund", effectiveDate: "2025-01-01" });
  assert.equal(findFundFactConflicts([fact(), historicalFact]).length, 0);
});

test("reused fund evidence IDs and top-level structure changes are rejected", () => {
  assert.throws(() => mergeFundProfiles(profile([fact()]), profile([fact({ value: "Mutual fund" })])), /different evidence/);
  const changed = profile();
  changed.structure = { leverageMultiplier: 2, inverse: false, dailyReset: true, coveredCall: false, activelyManaged: false };
  assert.throws(() => mergeFundProfiles(profile(), changed), /structure field/);
});

test("previously unknown structure fields can be filled without assuming the others", () => {
  const existing = profile();
  existing.structure = {
    leverageMultiplier: null, inverse: null, dailyReset: null, coveredCall: null, activelyManaged: null,
  };
  const incoming = profile([fact({
    id: "structure-leverage",
    category: "fund_structure",
    factKey: "leverageMultiplier",
    value: "1",
  })]);
  incoming.structure = {
    leverageMultiplier: 1, inverse: null, dailyReset: null, coveredCall: null, activelyManaged: null,
  };
  const merged = mergeFundProfiles(existing, incoming);
  assert.equal(merged.structure.leverageMultiplier, 1);
  assert.equal(merged.structure.inverse, null);
  assert.equal(merged.structure.coveredCall, null);
});

test("ordinary fund health requires its type, exposure, and grounded nature", () => {
  const baselineFacts = [
    fact(),
    fact({ id: "strategy", category: "strategy", value: "Track the S&P 500 Index" }),
    fact({ id: "asset", category: "asset_class_exposure", value: "US large-cap equities" }),
  ];
  const ordinary = profile(baselineFacts);
  ordinary.structure = {
    leverageMultiplier: null, inverse: null, dailyReset: null, coveredCall: null, activelyManaged: null,
  };
  const current = assessFundProfile(ordinary, { now: new Date("2026-07-23T12:00:00Z") });
  assert.equal(current.complete, true);
  assert.equal(current.reusable, true);
  assert.deepEqual(current.missingStructureFields, []);

  const withoutStrategy = assessFundProfile(profile(baselineFacts.filter((item) => item.category !== "strategy")), {
    now: new Date("2026-07-23T12:00:00Z"),
  });
  assert.equal(withoutStrategy.missingNature, true);
  assert.equal(withoutStrategy.complete, false);
  assert.equal(withoutStrategy.reusable, false);

  const holdingsAsNature = assessFundProfile(
    profile(
      baselineFacts.filter((item) => item.category !== "strategy"),
      [
        holding(),
        holding({ id: "holding-msft", constituentTicker: "MSFT", constituentName: "Microsoft", weightPercent: 5 }),
        holding({ id: "holding-nvda", constituentTicker: "NVDA", constituentName: "NVIDIA", weightPercent: 4 }),
      ],
    ),
    { now: new Date("2026-07-23T12:00:00Z") },
  );
  assert.equal(holdingsAsNature.missingNature, false);
  assert.equal(holdingsAsNature.reusable, true);

  const noExposure = assessFundProfile(profile(baselineFacts.filter((item) => item.category !== "asset_class_exposure")), {
    now: new Date("2026-07-23T12:00:00Z"),
  });
  assert.equal(noExposure.missingExposure, true);
  assert.equal(noExposure.missingNature, false);
  assert.equal(noExposure.complete, false);

  const staleOptionalHolding = assessFundProfile(profile(baselineFacts, [holding()]), { now: new Date("2026-09-23T12:00:00Z") });
  assert.equal(staleOptionalHolding.staleHoldingIds.includes("holding-aapl"), true);
  assert.equal(staleOptionalHolding.reusable, true);

  const holdingsOnly = baselineFacts.filter((item) => item.category !== "asset_class_exposure");
  const staleHoldings = assessFundProfile(profile(holdingsOnly, [holding()]), { now: new Date("2026-09-23T12:00:00Z") });
  assert.equal(staleHoldings.staleHoldingIds.includes("holding-aapl"), true);
  assert.equal(staleHoldings.reusable, false);
});

test("direction-changing fund structures still require verified mechanics", () => {
  const baselineFacts = [
    fact(),
    fact({ id: "strategy", category: "strategy", value: "Provides inverse daily exposure to the Nasdaq-100" }),
    fact({ id: "asset", category: "asset_class_exposure", value: "Nasdaq-100 equities" }),
    fact({ id: "inverse", category: "fund_structure", factKey: "inverse", value: "true" }),
    fact({ id: "leverage", category: "fund_structure", factKey: "leverageMultiplier", value: "-3" }),
  ];
  const inverseFund = profile(baselineFacts);
  inverseFund.ticker = "SQQQ";
  inverseFund.fundName = "ProShares UltraPro Short QQQ";
  inverseFund.structure = {
    leverageMultiplier: -3, inverse: true, dailyReset: null, coveredCall: null, activelyManaged: null,
  };
  const missingReset = assessFundProfile(inverseFund, { now: new Date("2026-07-23T12:00:00Z") });
  assert.deepEqual(missingReset.missingStructureFields, ["dailyReset"]);
  assert.equal(missingReset.complete, false);

  inverseFund.facts.push(fact({
    id: "daily-reset",
    category: "fund_structure",
    factKey: "dailyReset",
    value: "true",
  }));
  inverseFund.structure.dailyReset = true;
  const complete = assessFundProfile(inverseFund, { now: new Date("2026-07-23T12:00:00Z") });
  assert.deepEqual(complete.missingStructureFields, []);
  assert.equal(complete.reusable, true);

  const coveredCall = profile([
    fact(),
    fact({ id: "covered-strategy", category: "strategy", value: "Owns Nasdaq-100 equities and writes calls" }),
    fact({ id: "covered-asset", category: "asset_class_exposure", value: "Nasdaq-100 equities" }),
  ]);
  coveredCall.ticker = "QYLD";
  coveredCall.fundName = "Global X Nasdaq 100 Covered Call ETF";
  coveredCall.structure = {
    leverageMultiplier: null, inverse: null, dailyReset: null, coveredCall: null, activelyManaged: null,
  };
  assert.deepEqual(
    assessFundProfile(coveredCall, { now: new Date("2026-07-23T12:00:00Z") }).missingStructureFields,
    ["coveredCall"],
  );
});

test("fund context keeps a missing profile separate from a technical error", () => {
  assert.equal(createFundProfileContext("VOO", "Vanguard ETF", null).availability, "missing");
  assert.equal(createFundProfileContext("VOO", "Vanguard ETF", null, { technicalError: "database unavailable" }).availability, "error");
});

test("user fund input is bounded and defaults supplied evidence to unverified", () => {
  const created = createUserFundProfile({
    ticker: "voo",
    fundName: "Vanguard S&P 500 ETF",
    securityType: "etf",
    facts: [{ category: "strategy", factKey: "primary", value: "Tracks an index", evidenceText: "Entered locally by the user." }],
    holdings: [{
      constituentTicker: "aapl",
      constituentName: "Apple Inc.",
      weightPercent: 6.4,
      evidenceText: "Entered locally from a user document.",
      effectiveDate: "2026-07-22",
    }],
  }, new Date(timestamp));
  assert.equal(created.ticker, "VOO");
  assert.equal(created.facts[0].status, "unverified");
  assert.equal(created.holdings[0].constituentTicker, "AAPL");
  assert.equal(created.holdings[0].status, "unverified");
  assert.equal(created.structure.inverse, null);
  assert.throws(() => createUserFundProfile({ ticker: "VOO", fundName: "VOO", securityType: "stock", facts: [{}] }), /Security type/);
});
