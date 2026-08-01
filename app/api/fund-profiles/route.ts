import { getD1Database } from "../../../db";
import { assessFundProfile } from "../../../lib/fund-profile-contracts";
import { createUserFundProfile } from "../../../lib/fund-profile-input";
import { D1FundProfileStore } from "../../../lib/fund-profile-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let profile: ReturnType<typeof createUserFundProfile>;
  try {
    profile = createUserFundProfile(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Fund profile input is invalid.";
    return Response.json({ error: message }, { status: 400 });
  }
  try {
    const store = new D1FundProfileStore(getD1Database());
    const saved = await store.save(profile);
    return Response.json({ profile: saved, health: assessFundProfile(saved) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Fund profile could not be saved.";
    return Response.json({ error: message }, { status: 500 });
  }
}
