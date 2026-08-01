import { getD1Database } from "../../../db";
import { assessCompanyProfile } from "../../../lib/company-profile-contracts";
import { createUserCompanyProfile } from "../../../lib/company-profile-input";
import { D1CompanyProfileStore } from "../../../lib/company-profile-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let profile: ReturnType<typeof createUserCompanyProfile>;
  try {
    profile = createUserCompanyProfile(await request.json());
  } catch (error) {
    const message = error instanceof Error ? error.message : "Company profile input is invalid.";
    return Response.json({ error: message }, { status: 400 });
  }
  try {
    const store = new D1CompanyProfileStore(getD1Database());
    const saved = await store.save(profile);
    return Response.json({ profile: saved, health: assessCompanyProfile(saved) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Company profile could not be saved.";
    return Response.json({ error: message }, { status: 500 });
  }
}
