const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "qwen3.5:9b";
const DEFAULT_RELEVANCE_MODEL = "qwen3.5:4b";
const REQUEST_TIMEOUT_MS = 180_000;
const MAX_REQUEST_TIMEOUT_MS = 300_000;

type OllamaTagsResponse = {
  models?: Array<{ name: string; model?: string; size?: number }>;
};

type OllamaChatResponse = {
  model?: string;
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  total_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
};

export type ImpactTestResult = {
  direction: "positive" | "negative" | "mixed" | "uncertain";
  impact: "low" | "medium" | "high";
  timeHorizon: "immediate" | "short_term" | "long_term";
  confidence: number;
  summary: string;
  directEffect: string;
  indirectEffects: Array<{
    channel: string;
    effect: string;
    direction: "positive" | "negative" | "mixed" | "uncertain";
  }>;
  limitations: string[];
};

export type StructuredChatResult<T> = {
  result: T;
  model: string;
  durationSeconds?: number;
  promptTokens?: number;
  outputTokens?: number;
};

const impactSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    direction: { type: "string", enum: ["positive", "negative", "mixed", "uncertain"] },
    impact: { type: "string", enum: ["low", "medium", "high"] },
    timeHorizon: { type: "string", enum: ["immediate", "short_term", "long_term"] },
    confidence: { type: "integer", minimum: 0, maximum: 100 },
    summary: { type: "string" },
    directEffect: { type: "string" },
    indirectEffects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          channel: { type: "string" },
          effect: { type: "string" },
          direction: { type: "string", enum: ["positive", "negative", "mixed", "uncertain"] },
        },
        required: ["channel", "effect", "direction"],
      },
    },
    limitations: { type: "array", items: { type: "string" } },
  },
  required: ["direction", "impact", "timeHorizon", "confidence", "summary", "directEffect", "indirectEffects", "limitations"],
} as const;

export class OllamaError extends Error {
  readonly status?: number;
  readonly code: "request_failed" | "timeout" | "connection_failed" | "invalid_output";
  constructor(
    message: string,
    status?: number,
    code: "request_failed" | "timeout" | "connection_failed" | "invalid_output" = "request_failed",
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "OllamaError";
  }
}

function balancedJsonObject(value: string) {
  const start = value.indexOf("{");
  if (start < 0) return "";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return "";
}

export function parseStructuredJsonContent(content: string) {
  const trimmed = content.trim();
  const candidates = [trimmed];
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
  if (fenced) candidates.push(fenced);
  const balanced = balancedJsonObject(trimmed);
  if (balanced) candidates.push(balanced);
  for (const candidate of [...new Set(candidates)]) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // Try the next safely bounded representation.
    }
  }
  throw new OllamaError("Ollama returned malformed JSON.", undefined, "invalid_output");
}

function cleanBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function isImpactResult(value: unknown): value is ImpactTestResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<ImpactTestResult>;
  return (
    ["positive", "negative", "mixed", "uncertain"].includes(result.direction ?? "") &&
    ["low", "medium", "high"].includes(result.impact ?? "") &&
    ["immediate", "short_term", "long_term"].includes(result.timeHorizon ?? "") &&
    typeof result.confidence === "number" && Number.isInteger(result.confidence) && result.confidence >= 0 && result.confidence <= 100 &&
    typeof result.summary === "string" &&
    typeof result.directEffect === "string" &&
    Array.isArray(result.indirectEffects) &&
    Array.isArray(result.limitations)
  );
}

export class OllamaClient {
  private readonly baseUrl: string;
  readonly model: string;

  constructor(model: string, baseUrl: string) {
    this.model = model.trim() || DEFAULT_MODEL;
    this.baseUrl = cleanBaseUrl(baseUrl.trim() || DEFAULT_BASE_URL);
  }

  private async request(path: string, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS) {
    const boundedTimeoutMs = Math.min(MAX_REQUEST_TIMEOUT_MS, Math.max(1_000, Math.round(timeoutMs)));
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(boundedTimeoutMs),
      });
      const data = await response.json() as Record<string, unknown>;
      if (!response.ok) {
        const message = typeof data.error === "string" ? data.error : `HTTP ${response.status}`;
        throw new OllamaError(`Ollama request failed: ${message.slice(0, 200)}`, response.status);
      }
      return data;
    } catch (error) {
      if (error instanceof OllamaError) throw error;
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new OllamaError(
          `Ollama took longer than ${Math.round(boundedTimeoutMs / 1_000)} seconds to respond.`,
          undefined,
          "timeout",
        );
      }
      throw new OllamaError(
        "Could not connect to local Ollama. Make sure the Ollama app is running.",
        undefined,
        "connection_failed",
      );
    }
  }

  async status() {
    const data = await this.request("/api/tags") as OllamaTagsResponse;
    const models = data.models?.map((item) => item.name || item.model || "").filter(Boolean) ?? [];
    return { model: this.model, available: models.includes(this.model), models };
  }

  async chatStructured<T>(options: {
    schema: Record<string, unknown>;
    system: string;
    prompt: string;
    validate: (value: unknown) => value is T;
    validationError?: (value: unknown) => string;
    attempts?: 1 | 2;
    think?: boolean;
    contextSize?: number;
    maxOutputTokens?: number;
    timeoutMs?: number;
  }): Promise<StructuredChatResult<T>> {
    let lastProblem = "Ollama returned JSON that did not match the required schema.";
    const attempts = options.attempts ?? 2;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const repairInstruction = attempt === 0
        ? ""
        : `\n\nYour previous response was incomplete or invalid. Problem: ${lastProblem.slice(0, 600)} Check every requested item and return one schema-valid result for each required ID; do not omit or duplicate IDs.`;
      const response = await this.request("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          think: options.think ?? false,
          keep_alive: "10m",
          format: options.schema,
          options: {
            temperature: 0,
            num_ctx: options.contextSize ?? 16384,
            num_predict: options.maxOutputTokens ?? 1800,
          },
          messages: [
            { role: "system", content: options.system },
            { role: "user", content: `${options.prompt}${repairInstruction}\n\nReturn JSON matching this schema exactly:\n${JSON.stringify(options.schema)}` },
          ],
        }),
      }, options.timeoutMs) as OllamaChatResponse;

      const content = response.message?.content;
      if (!content) {
        lastProblem = "Ollama returned no final answer.";
        continue;
      }

      try {
        const parsed = parseStructuredJsonContent(content);
        if (!options.validate(parsed)) {
          lastProblem = options.validationError?.(parsed)
            || "Ollama returned JSON that did not match the required schema.";
          continue;
        }

        return {
          result: parsed,
          model: response.model ?? this.model,
          durationSeconds: response.total_duration ? Math.round(response.total_duration / 1_000_000_000 * 10) / 10 : undefined,
          promptTokens: response.prompt_eval_count,
          outputTokens: response.eval_count,
        };
      } catch (error) {
        lastProblem = response.done_reason === "length"
          ? `Ollama output was truncated at ${response.eval_count ?? "the configured token limit"} tokens.`
          : error instanceof Error
            ? error.message
            : "Ollama returned malformed JSON.";
        continue;
      }
    }
    throw new OllamaError(lastProblem, undefined, "invalid_output");
  }

  async runImpactTest() {
    const status = await this.status();
    if (!status.available) throw new OllamaError(`Model ${this.model} is not installed in Ollama.`, 404);

    const response = await this.request("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        think: false,
        keep_alive: "10m",
        format: impactSchema,
        options: { temperature: 0, num_ctx: 16384, num_predict: 900 },
        messages: [
          {
            role: "system",
            content: "You are a cautious financial-news research assistant. Separate known facts from inference. Never give buy, sell, or trading instructions. Confidence must be a whole-number percentage from 0 to 100. Keep schema keys and enum values unchanged, but write all explanatory text in concise Simplified Chinese. Return only JSON matching the provided schema.",
          },
          {
            role: "user",
            content: "TEST SCENARIO ONLY: International crude oil prices rise 10% because of a supply disruption. Analyze the possible effect on a fictional passenger airline. Explain direct and indirect channels. This is a system test, not investment advice. Return JSON matching this schema: " + JSON.stringify(impactSchema),
          },
        ],
      }),
    }) as OllamaChatResponse;

    const content = response.message?.content;
    if (!content) throw new OllamaError("Ollama returned no final answer.");

    let parsed: unknown;
    try {
      parsed = parseStructuredJsonContent(content);
    } catch (error) {
      if (response.done_reason === "length") {
        throw new OllamaError(
          `Ollama test output was truncated at ${response.eval_count ?? "the configured token limit"} tokens.`,
          undefined,
          "invalid_output",
        );
      }
      if (error instanceof OllamaError) throw error;
      throw new OllamaError("Ollama returned malformed JSON.", undefined, "invalid_output");
    }
    if (!isImpactResult(parsed)) {
      throw new OllamaError(
        "Ollama returned JSON that did not match the impact schema.",
        undefined,
        "invalid_output",
      );
    }

    return {
      result: parsed,
      model: response.model ?? this.model,
      durationSeconds: response.total_duration ? Math.round(response.total_duration / 1_000_000_000 * 10) / 10 : undefined,
      promptTokens: response.prompt_eval_count,
      outputTokens: response.eval_count,
    };
  }
}

export function getOllamaConfiguration() {
  const relevanceModel = process.env.OLLAMA_RELEVANCE_MODEL?.trim() || DEFAULT_RELEVANCE_MODEL;
  const legacyAnalysisModel = process.env.OLLAMA_MODEL?.trim() || DEFAULT_MODEL;
  return {
    baseUrl: process.env.OLLAMA_BASE_URL?.trim() || DEFAULT_BASE_URL,
    relevanceModel,
    researchModel: process.env.OLLAMA_RESEARCH_MODEL?.trim() || relevanceModel,
    impactModel: process.env.OLLAMA_IMPACT_MODEL?.trim() || relevanceModel,
    reviewModel: process.env.OLLAMA_REVIEW_MODEL?.trim() || legacyAnalysisModel,
    model: legacyAnalysisModel,
  };
}
