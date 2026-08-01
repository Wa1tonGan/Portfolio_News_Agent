import { D1CompanyProfileStore, type D1DatabaseLike } from "./company-profile-store.ts";
import { D1FundProfileStore } from "./fund-profile-store.ts";

export const clearResearchedProfilesConfirmation = "CLEAR_RESEARCHED_PROFILES";

export type ClearedProfileDataCounts = {
  companyProfiles: number;
  companyFacts: number;
  fundProfiles: number;
  fundFacts: number;
  fundHoldings: number;
};

async function countRows(database: D1DatabaseLike, table: string) {
  const row = await database.prepare(`SELECT COUNT(*) AS total FROM ${table}`).first<{ total: number }>();
  return Number(row?.total ?? 0);
}

export async function clearResearchedProfileData(database: D1DatabaseLike): Promise<ClearedProfileDataCounts> {
  // Initialize only the profile tables. The US security registry is intentionally not opened or changed here.
  await Promise.all([
    new D1CompanyProfileStore(database).list(1),
    new D1FundProfileStore(database).list(1),
  ]);

  const [companyProfiles, companyFacts, fundProfiles, fundFacts, fundHoldings] = await Promise.all([
    countRows(database, "company_profiles"),
    countRows(database, "company_facts"),
    countRows(database, "fund_profiles"),
    countRows(database, "fund_facts"),
    countRows(database, "fund_holdings"),
  ]);

  await database.batch([
    database.prepare("DELETE FROM company_facts"),
    database.prepare("DELETE FROM fund_holdings"),
    database.prepare("DELETE FROM fund_facts"),
    database.prepare("DELETE FROM company_profiles"),
    database.prepare("DELETE FROM fund_profiles"),
  ]);

  return { companyProfiles, companyFacts, fundProfiles, fundFacts, fundHoldings };
}
