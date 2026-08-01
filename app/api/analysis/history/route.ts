import { getD1Database } from "../../../../db";
import { D1AnalysisRunStore } from "../../../../lib/analysis-run-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const requestedLimit = Number(url.searchParams.get("limit") ?? "12");
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(50, Math.floor(requestedLimit))) : 12;
    const store = new D1AnalysisRunStore(getD1Database());
    const [runs, latest, latestCompleted] = await Promise.all([
      store.list(limit),
      store.getLatest(),
      store.getLatestCompleted(),
    ]);
    return Response.json(
      { runs, latest, latestCompleted },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法读取本地分析记录。";
    return Response.json({ error: message }, { status: 500 });
  }
}
