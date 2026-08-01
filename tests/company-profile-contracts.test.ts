import assert from "node:assert/strict";
import test from "node:test";
import {
  assessCompanyProfile,
  createCompanyProfileContext,
  findCompanyFactConflicts,
  mergeCompanyProfiles,
  validateCompanyFact,
  type CompanyFact,
  type CompanyProfile,
} from "../lib/company-profile-contracts.ts";
import { createUserCompanyProfile } from "../lib/company-profile-input.ts";

const createdAt = "2026-07-21T08:00:00.000Z";

function fact(overrides: Partial<CompanyFact> = {}): CompanyFact {
  return {
    id: "fact-1",
    category: "sector",
    factKey: "primary",
    value: "Technology",
    status: "verified",
    sourceType: "user_provided",
    sourceUrl: null,
    evidenceText: "Confirmed directly by the user for this private profile.",
    lastVerificationDate: "2026-07-21",
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

function profile(facts: CompanyFact[]): CompanyProfile {
  return { id: "profile-aapl", ticker: "AAPL", companyName: "Apple Inc.", facts, createdAt, updatedAt: createdAt, lastReviewedAt: createdAt };
}

test("source integrity rejects unsafe web evidence and verified model memory", () => {
  const unsafeWeb = validateCompanyFact(fact({ sourceType: "company_filing", sourceUrl: "http://example.com/filing" }));
  assert.equal(unsafeWeb.valid, false);
  assert.match(unsafeWeb.errors.join(" "), /HTTPS/);
  const memory = validateCompanyFact(fact({ status: "verified", sourceType: "model_memory", sourceUrl: null }));
  assert.equal(memory.valid, false);
  assert.match(memory.errors.join(" "), /Model memory/);
});

test("an unverified suggestion cannot overwrite a verified fact", () => {
  const verified = fact();
  const suggestion = fact({ id: "fact-2", value: "Consumer discretionary", status: "unverified", sourceType: "model_memory", evidenceText: "Model suggestion only." });
  const merged = mergeCompanyProfiles(profile([verified]), { ...profile([suggestion]), updatedAt: "2026-07-21T09:00:00.000Z" });
  assert.equal(merged.facts.length, 2);
  assert.equal(merged.facts.find((item) => item.id === verified.id)?.status, "verified");
});

test("conflicting facts are retained and reported", () => {
  const facts = [fact(), fact({ id: "fact-2", value: "Consumer discretionary", status: "unverified", sourceType: "user_provided" })];
  const conflicts = findCompanyFactConflicts(facts);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(new Set(conflicts[0].factIds), new Set(["fact-1", "fact-2"]));
});

test("a reused fact ID cannot silently change its evidence", () => {
  const existing = profile([fact()]);
  const changed = profile([fact({ value: "Financial services" })]);
  assert.throws(() => mergeCompanyProfiles(existing, changed), /already belongs to different evidence/);
});

test("profile health reports missing, stale, and reusable profiles", () => {
  const categories = ["sector", "industry"] as const;
  const complete = profile([
    fact({ id: "sector", category: "sector" }),
    fact({ id: "industry", category: "industry", value: "Consumer electronics" }),
  ]);
  const current = assessCompanyProfile(complete, { now: new Date("2026-07-21T12:00:00Z"), staleAfterDays: 365, requiredCategories: [...categories] });
  assert.equal(current.reusable, true);
  const stale = assessCompanyProfile(complete, { now: new Date("2028-07-21T12:00:00Z"), staleAfterDays: 365, requiredCategories: [...categories] });
  assert.equal(stale.stale, true);
  assert.equal(stale.reusable, false);
  const missing = assessCompanyProfile(profile([fact()]), { now: new Date("2026-07-21T12:00:00Z"), requiredCategories: [...categories] });
  assert.deepEqual(missing.missingCategories, ["industry"]);
});

test("the default company baseline is small and optional stale details do not block reuse", () => {
  const baseline = profile([
    fact({ id: "sector", category: "sector", value: "Technology" }),
    fact({ id: "industry", category: "industry", value: "Consumer electronics" }),
    fact({ id: "products", category: "products", value: "Devices and digital services" }),
    fact({
      id: "old-customers",
      category: "customers",
      value: "Consumers",
      lastVerificationDate: "2020-01-01",
    }),
  ]);
  const health = assessCompanyProfile(baseline, { now: new Date("2026-07-21T12:00:00Z") });
  assert.equal(health.complete, true);
  assert.equal(health.reusable, true);
  assert.deepEqual(health.missingCategories, []);
  assert.deepEqual(health.staleFactIds, ["old-customers"]);
});

test("profile context distinguishes missing profiles from technical failures", () => {
  assert.equal(createCompanyProfileContext("AAPL", "Apple", null).availability, "missing");
  assert.equal(createCompanyProfileContext("AAPL", "Apple", null, { technicalError: "database unavailable" }).availability, "error");
});

test("user profile input is bounded and defaults new facts to unverified", () => {
  const created = createUserCompanyProfile({
    ticker: "aapl", companyName: "Apple Inc.",
    facts: [{ category: "products", factKey: "primary", value: "iPhone", evidenceText: "Entered locally by the user." }],
  }, new Date("2026-07-22T02:00:00.000Z"));
  assert.equal(created.ticker, "AAPL");
  assert.equal(created.facts[0].status, "unverified");
  assert.throws(() => createUserCompanyProfile({ ticker: "AAPL", companyName: "Apple", facts: [{ category: "unknown" }] }), /invalid category/);
});
