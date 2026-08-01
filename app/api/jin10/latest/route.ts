import { getJin10Configuration, Jin10McpClient } from "../../../../lib/jin10-mcp";

export const dynamic = "force-dynamic";

type StructuredList = {
  data?: {
    items?: unknown[];
    next_cursor?: string | null;
    has_more?: boolean;
  };
};

function summarize(value: unknown) {
  const structured = value as StructuredList | null;
  const data = structured?.data;
  return {
    count: Array.isArray(data?.items) ? data.items.length : 0,
    hasMore: Boolean(data?.has_more),
    nextCursor: data?.next_cursor ?? null,
    sample: Array.isArray(data?.items) ? data.items.slice(0, 3) : [],
  };
}

export async function GET() {
  const configuration = getJin10Configuration();
  if (!configuration.token) return Response.json({ error: "Jin10 token is not configured." }, { status: 400 });

  try {
    const client = new Jin10McpClient(configuration);
    await client.connect();
    const [flash, news] = await Promise.all([client.listFlash(), client.listNews()]);
    return Response.json({ flash: summarize(flash.structuredContent), news: summarize(news.structuredContent) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Could not collect Jin10 news." }, { status: 502 });
  }
}
