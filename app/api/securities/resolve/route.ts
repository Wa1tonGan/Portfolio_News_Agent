import { getD1Database } from "../../../../db";
import { D1UsSecurityRegistry } from "../../../../lib/us-security-registry";
import { isPlausibleUsSecuritySymbol, normalizeSecuritySymbol, usSecuritySymbolHelp } from "../../../../lib/us-listed-ticker";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { symbols?: unknown[] };
    if (!Array.isArray(body.symbols) || body.symbols.length < 1 || body.symbols.length > 100) {
      return Response.json({ error: "Provide between 1 and 100 portfolio symbols." }, { status: 400 });
    }
    const symbols = body.symbols.map(normalizeSecuritySymbol);
    if (symbols.some((symbol) => !isPlausibleUsSecuritySymbol(symbol))) {
      return Response.json({ error: usSecuritySymbolHelp }, { status: 400 });
    }

    const result = await new D1UsSecurityRegistry(getD1Database()).lookup(symbols);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "US security registry lookup failed.";
    return Response.json({ error: message }, { status: 502 });
  }
}
