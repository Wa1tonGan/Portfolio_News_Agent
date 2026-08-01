import { getD1Database } from "../../../../../db";
import { D1AnalysisRunStore } from "../../../../../lib/analysis-run-store";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!/^analysis-[A-Za-z0-9-]{10,160}$/.test(id)) {
      return Response.json({ error: "分析记录编号无效。" }, { status: 400 });
    }
    const run = await new D1AnalysisRunStore(getD1Database()).getById(id);
    if (!run) return Response.json({ error: "找不到这项分析记录。" }, { status: 404 });
    return Response.json(run, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法读取本地分析记录。";
    return Response.json({ error: message }, { status: 500 });
  }
}
