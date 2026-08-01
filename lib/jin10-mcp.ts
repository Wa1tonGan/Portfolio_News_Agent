const DEFAULT_ENDPOINT = "https://mcp.jin10.com/mcp";
const PROTOCOL_VERSION = "2025-11-25";

type JsonRpcEnvelope<T = unknown> = {
  jsonrpc: "2.0";
  id?: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
};

type InitializeResult = {
  protocolVersion?: string;
  serverInfo?: { name?: string; version?: string };
  capabilities?: Record<string, unknown>;
};

type ToolDescription = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

type ResourceDescription = {
  uri: string;
  name?: string;
  description?: string;
};

type ToolCallResult = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type: string; text?: string }>;
};

export type Jin10ToolName =
  | "get_quote"
  | "get_kline"
  | "list_flash"
  | "search_flash"
  | "list_news"
  | "search_news"
  | "get_news"
  | "list_calendar";

export type Jin10StructuredResult = {
  isError: boolean;
  structuredContent: unknown;
  readableText?: string;
};

export type Jin10ConnectionInfo = {
  protocolVersion: string;
  serverName: string;
  serverVersion?: string;
  tools: ToolDescription[];
  resources: ResourceDescription[];
};

export class Jin10McpError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
    this.name = "Jin10McpError";
  }
}

function parseEventStream(text: string): JsonRpcEnvelope | null {
  const messages = text
    .split(/\r?\n\r?\n/)
    .flatMap((event) => {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data) return [];
      try {
        return [JSON.parse(data) as JsonRpcEnvelope];
      } catch {
        return [];
      }
    });

  return messages.findLast((message) => message.result !== undefined || message.error !== undefined) ?? null;
}

function parseResponseBody(text: string, contentType: string | null) {
  if (!text.trim()) return null;

  if (contentType?.includes("text/event-stream")) {
    return parseEventStream(text);
  }

  try {
    return JSON.parse(text) as JsonRpcEnvelope;
  } catch {
    return parseEventStream(text);
  }
}

function safeProtocolMessage(message: string) {
  return message.replace(/Bearer\s+\S+/gi, "Bearer [hidden]").slice(0, 240);
}

export class Jin10McpClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private sessionId?: string;
  private nextId = 1;

  constructor(options: { token: string; endpoint?: string; timeoutMs?: number }) {
    if (!options.token.trim()) throw new Jin10McpError("Jin10 MCP token is missing.");
    this.token = options.token.trim();
    this.endpoint = options.endpoint?.trim() || DEFAULT_ENDPOINT;
    this.timeoutMs = Math.max(1_000, Math.min(60_000, options.timeoutMs ?? 20_000));
  }

  private async post(method: string, params?: Record<string, unknown>, notification = false) {
    const id = notification ? undefined : this.nextId++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${this.token}`,
          ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          ...(id === undefined ? {} : { id }),
          method,
          ...(params === undefined ? {} : { params }),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Jin10McpError(`Jin10 MCP ${method} timed out.`);
      throw new Jin10McpError(`Jin10 MCP ${method} request failed: ${error instanceof Error ? error.message : "network error"}.`);
    } finally {
      clearTimeout(timeout);
    }

    const receivedSessionId = response.headers.get("mcp-session-id");
    if (receivedSessionId) this.sessionId = receivedSessionId;

    const text = await response.text();
    if (!response.ok) {
      throw new Jin10McpError(`Jin10 MCP request failed with HTTP ${response.status}.`, response.status);
    }

    if (notification) return null;

    const envelope = parseResponseBody(text, response.headers.get("content-type"));
    if (!envelope) throw new Jin10McpError("Jin10 MCP returned an empty response.");
    if (envelope.error) {
      throw new Jin10McpError(
        `Jin10 protocol error ${envelope.error.code}: ${safeProtocolMessage(envelope.error.message)}`,
      );
    }
    return envelope.result;
  }

  async connect(): Promise<Jin10ConnectionInfo> {
    const initialized = await this.post("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "portfolio-news-impact-agent", version: "0.1.0" },
    }) as InitializeResult;

    await this.post("notifications/initialized", undefined, true);

    const [toolResult, resourceResult] = await Promise.all([
      this.post("tools/list", {}),
      this.post("resources/list", {}),
    ]) as [{ tools?: ToolDescription[] }, { resources?: ResourceDescription[] }];

    return {
      protocolVersion: initialized.protocolVersion ?? PROTOCOL_VERSION,
      serverName: initialized.serverInfo?.name ?? "Jin10 MCP",
      serverVersion: initialized.serverInfo?.version,
      tools: toolResult.tools ?? [],
      resources: resourceResult.resources ?? [],
    };
  }

  async callTool(name: Jin10ToolName, args: Record<string, unknown> = {}): Promise<Jin10StructuredResult> {
    const result = await this.post("tools/call", { name, arguments: args }) as ToolCallResult;
    const readableText = result.content
      ?.filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n");

    return {
      isError: Boolean(result.isError),
      structuredContent: result.structuredContent ?? null,
      ...(readableText ? { readableText } : {}),
    };
  }

  getQuote(code: string) { return this.callTool("get_quote", { code }); }
  getKline(code: string, time?: string, count?: number) {
    return this.callTool("get_kline", { code, ...(time ? { time } : {}), ...(count ? { count } : {}) });
  }
  listFlash(cursor?: string) { return this.callTool("list_flash", cursor ? { cursor } : {}); }
  searchFlash(keyword: string) { return this.callTool("search_flash", { keyword }); }
  listNews(cursor?: string) { return this.callTool("list_news", cursor ? { cursor } : {}); }
  searchNews(keyword: string, cursor?: string) {
    return this.callTool("search_news", { keyword, ...(cursor ? { cursor } : {}) });
  }
  getNews(id: string) { return this.callTool("get_news", { id }); }
  listCalendar() { return this.callTool("list_calendar", {}); }
}

export function getJin10Configuration() {
  return {
    endpoint: process.env.JIN10_MCP_URL?.trim() || DEFAULT_ENDPOINT,
    token: process.env.JIN10_MCP_TOKEN?.trim() || "",
  };
}
