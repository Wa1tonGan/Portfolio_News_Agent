import { getJin10Configuration, Jin10McpClient, Jin10McpError } from "../../../../lib/jin10-mcp";

export const dynamic = "force-dynamic";

export async function GET() {
  const configuration = getJin10Configuration();

  if (!configuration.token) {
    return Response.json({
      configured: false,
      connected: false,
      message: "Add JIN10_MCP_TOKEN to .env.local, then restart the local app.",
    });
  }

  try {
    const client = new Jin10McpClient(configuration);
    const info = await client.connect();
    return Response.json({
      configured: true,
      connected: true,
      protocolVersion: info.protocolVersion,
      serverName: info.serverName,
      serverVersion: info.serverVersion,
      tools: info.tools.map((tool) => tool.name),
      resources: info.resources.map((resource) => resource.uri),
    });
  } catch (error) {
    const status = error instanceof Jin10McpError && error.status === 401 ? 401 : 502;
    return Response.json({
      configured: true,
      connected: false,
      message: error instanceof Jin10McpError ? error.message : "Jin10 MCP connection failed.",
    }, { status });
  }
}
