import assert from "node:assert/strict";
import test from "node:test";
import { OllamaClient, OllamaError, parseStructuredJsonContent } from "../lib/ollama.ts";

test("structured JSON parser accepts a direct JSON object", () => {
  assert.deepEqual(parseStructuredJsonContent('{"facts":[]}'), { facts: [] });
});

test("structured JSON parser safely unwraps a JSON code fence", () => {
  assert.deepEqual(parseStructuredJsonContent('```json\n{"facts":[{"value":"memory"}]}\n```'), {
    facts: [{ value: "memory" }],
  });
});

test("structured JSON parser extracts one balanced object from harmless surrounding text", () => {
  const content = 'Result follows: {"facts":[{"value":"brace } and \\"quote\\""}]} End.';
  assert.deepEqual(parseStructuredJsonContent(content), {
    facts: [{ value: 'brace } and "quote"' }],
  });
});

test("structured JSON parser reports truncated output as invalid model output", () => {
  assert.throws(
    () => parseStructuredJsonContent('{"facts":[{"value":"unfinished"'),
    (error) => error instanceof OllamaError
      && error.code === "invalid_output"
      && /malformed JSON/i.test(error.message),
  );
});

test("structured-output retry tells Ollama the exact validation problem", async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Array<Record<string, unknown>> = [];
  let call = 0;
  globalThis.fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    call += 1;
    return new Response(JSON.stringify({
      model: "test-model",
      message: { content: call === 1 ? '{"ok":false}' : '{"ok":true}' },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const client = new OllamaClient("test-model", "http://localhost:11434");
    const result = await client.chatStructured({
      schema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      },
      system: "Return a test result.",
      prompt: "Check one item.",
      validate: (value): value is { ok: true } =>
        Boolean(value) && typeof value === "object" && (value as { ok?: boolean }).ok === true,
      validationError: () => "A four-step causal path is required.",
    });
    assert.equal(result.result.ok, true);
    const retryMessages = (requestBodies[1].messages as Array<{ content: string }>);
    assert.match(retryMessages[1].content, /four-step causal path/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
