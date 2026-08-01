import { getD1Database } from "../../../../db";
import { assessFundProfile } from "../../../../lib/fund-profile-contracts";
import { cleanFundTicker } from "../../../../lib/fund-profile-input";
import { D1FundProfileStore } from "../../../../lib/fund-profile-store";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ ticker: string }> }) {
  try {
    const ticker = cleanFundTicker((await context.params).ticker);
    if (!ticker) return Response.json({ error: "A valid ticker is required." }, { status: 400 });
    const store = new D1FundProfileStore(getD1Database());
    const profile = await store.getByTicker(ticker);
    if (!profile) return Response.json({ error: "Fund profile not found." }, { status: 404 });
    return Response.json({ profile, health: assessFundProfile(profile) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Fund profile could not be loaded.";
    return Response.json({ error: message }, { status: 500 });
  }
}
