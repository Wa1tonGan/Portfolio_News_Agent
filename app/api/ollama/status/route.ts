import { getOllamaConfiguration, OllamaClient, OllamaError } from "../../../../lib/ollama";

export const dynamic = "force-dynamic";

function failure(error: unknown) {
  const message = error instanceof OllamaError ? error.message : "Local Ollama check failed.";
  const status = error instanceof OllamaError && error.status === 404 ? 404 : 502;
  return Response.json({ connected: false, message }, { status });
}

export async function GET() {
  const configuration = getOllamaConfiguration();
  try {
    const client = new OllamaClient(configuration.impactModel, configuration.baseUrl);
    const status = await client.status();
    return Response.json({
      connected: true,
      model: status.model,
      modelAvailable: status.available,
      installedModelCount: status.models.length,
      message: status.available ? "Local model is ready." : `Ollama is running, but ${status.model} is not installed.`,
    });
  } catch (error) {
    return failure(error);
  }
}

export async function POST() {
  const configuration = getOllamaConfiguration();
  try {
    const client = new OllamaClient(configuration.impactModel, configuration.baseUrl);
    const test = await client.runImpactTest();
    return Response.json({ connected: true, modelAvailable: true, ...test });
  } catch (error) {
    return failure(error);
  }
}
