import { getD1Database } from "../../../../db";
import { assessCompanyProfile } from "../../../../lib/company-profile-contracts";
import { cleanCompanyTicker } from "../../../../lib/company-profile-input";
import { D1CompanyProfileStore } from "../../../../lib/company-profile-store";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ ticker: string }> }) {
  try {
    const ticker = cleanCompanyTicker((await context.params).ticker);
    if (!ticker) return Response.json({ error: "A valid ticker is required." }, { status: 400 });
    const store = new D1CompanyProfileStore(getD1Database());
    const profile = await store.getByTicker(ticker);
    if (!profile) return Response.json({ error: "Company profile not found." }, { status: 404 });
    return Response.json({ profile, health: assessCompanyProfile(profile) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Company profile could not be loaded.";
    return Response.json({ error: message }, { status: 500 });
  }
}
