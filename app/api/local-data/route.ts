import { getD1Database } from "../../../db";
import { createCompanyProfileContext } from "../../../lib/company-profile-contracts";
import { D1CompanyProfileStore } from "../../../lib/company-profile-store";
import { createFundProfileContext } from "../../../lib/fund-profile-contracts";
import { D1FundProfileStore } from "../../../lib/fund-profile-store";
import {
  clearResearchedProfileData,
  clearResearchedProfilesConfirmation,
} from "../../../lib/local-profile-data";
import { D1UsSecurityRegistry } from "../../../lib/us-security-registry";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const database = getD1Database();
    const profileStore = new D1CompanyProfileStore(database);
    const fundProfileStore = new D1FundProfileStore(database);
    const registry = new D1UsSecurityRegistry(database);
    const [profiles, fundProfiles, registrySummary] = await Promise.all([
      profileStore.list(200),
      fundProfileStore.list(200),
      registry.inspect(),
    ]);
    return Response.json({
      storage: {
        engine: "Cloudflare D1 / local SQLite",
        localDirectory: ".wrangler/state/v3/d1/",
        committedToGit: false,
        note: "The generated SQLite filename may change. This page is the stable way to inspect saved local data.",
      },
      registry: registrySummary,
      profiles: profiles.map((profile) => {
        const context = createCompanyProfileContext(profile.ticker, profile.companyName, profile);
        return {
          ...profile,
          health: {
            availability: context.availability,
            complete: context.complete,
            stale: context.stale,
            reusable: context.reusable,
            missingCategories: context.missingCategories,
            conflicts: context.conflicts,
            verifiedFactCount: context.verifiedFactCount,
            unverifiedFactCount: context.unverifiedFactCount,
          },
        };
      }),
      fundProfiles: fundProfiles.map((profile) => {
        const context = createFundProfileContext(profile.ticker, profile.fundName, profile);
        return {
          ...profile,
          health: {
            availability: context.availability,
            complete: context.complete,
            stale: context.stale,
            reusable: context.reusable,
            missingCategories: context.missingCategories,
            missingExposure: context.missingExposure,
            missingNature: context.missingNature,
            missingStructureFields: context.missingStructureFields,
            factConflicts: context.factConflicts,
            holdingConflicts: context.holdingConflicts,
            verifiedFactCount: context.verifiedFactCount,
            unverifiedFactCount: context.unverifiedFactCount,
            verifiedHoldingCount: context.verifiedHoldingCount,
            unverifiedHoldingCount: context.unverifiedHoldingCount,
          },
        };
      }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Local database could not be inspected.";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const requestUrl = new URL(request.url);
    const origin = request.headers.get("origin");
    if (origin && origin !== requestUrl.origin) {
      return Response.json({ error: "Cross-origin deletion is not allowed." }, { status: 403 });
    }
    if (!(request.headers.get("content-type") ?? "").toLocaleLowerCase().includes("application/json")) {
      return Response.json({ error: "A JSON confirmation is required." }, { status: 415 });
    }
    const body = await request.json() as { confirmation?: unknown; scope?: unknown };
    if (body.scope !== "researched_profiles" || body.confirmation !== clearResearchedProfilesConfirmation) {
      return Response.json({ error: "The profile-data deletion confirmation is invalid." }, { status: 400 });
    }
    const deleted = await clearResearchedProfileData(getD1Database());
    return Response.json({
      deleted,
      preserved: ["us_securities", "security_registry_meta"],
      message: "Company and fund research data was cleared. The US security directory was preserved.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Local research data could not be cleared.";
    return Response.json({ error: message }, { status: 500 });
  }
}
