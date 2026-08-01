import { runAnalysisPipeline, type PipelineActivity, type PortfolioHoldingInput } from "../../../../lib/analysis-pipeline-next";
import { getJin10Configuration, Jin10McpClient } from "../../../../lib/jin10-mcp";
import { getOllamaConfiguration, OllamaClient } from "../../../../lib/ollama";
import { getD1Database } from "../../../../db";
import { D1CompanyProfileStore } from "../../../../lib/company-profile-store";
import { D1FundProfileStore } from "../../../../lib/fund-profile-store";
import { D1UsSecurityRegistry } from "../../../../lib/us-security-registry";
import { D1AnalysisRunStore } from "../../../../lib/analysis-run-store";
import { isPlausibleUsSecuritySymbol, normalizeSecuritySymbol, usSecuritySymbolHelp } from "../../../../lib/us-listed-ticker";

export const dynamic = "force-dynamic";

function cleanHolding(value: unknown): PortfolioHoldingInput | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const ticker = normalizeSecuritySymbol(item.ticker);
  const companyName = typeof item.companyName === "string" ? item.companyName.trim().slice(0, 120) : "";
  const currency = typeof item.currency === "string" ? item.currency.trim().toUpperCase().slice(0, 10) : "";
  const portfolioWeight = typeof item.portfolioWeight === "number" && Number.isFinite(item.portfolioWeight)
    ? Math.max(0, Math.min(100, item.portfolioWeight)) : undefined;
  return isPlausibleUsSecuritySymbol(ticker) && companyName && currency ? { ticker, companyName, currency, portfolioWeight } : null;
}

const supportedSecurityTypes = new Set(["stock", "adr", "reit", "etf", "closed_end_fund"]);

export async function POST(request: Request) {
  try {
    const body = await request.json() as { holdings?: unknown[] };
    const requestedHoldings = body.holdings ?? [];
    const holdings = requestedHoldings.map(cleanHolding).filter((item): item is PortfolioHoldingInput => Boolean(item)).slice(0, 50);
    if (requestedHoldings.length !== holdings.length) {
      return Response.json({ error: `The portfolio contains an invalid symbol or field. ${usSecuritySymbolHelp}` }, { status: 400 });
    }
    if (!holdings.length) return Response.json({ error: "Upload a valid portfolio before running analysis." }, { status: 400 });

    const database = getD1Database();
    const registryResult = await new D1UsSecurityRegistry(database).lookup(holdings.map((holding) => holding.ticker));
    if (registryResult.missingSymbols.length) {
      return Response.json({
        error: `These symbols were not found in the cached US listing directory: ${registryResult.missingSymbols.join(", ")}. Check the symbol or wait for the next directory refresh.`,
        registryStatus: registryResult.status,
      }, { status: 400 });
    }
    const identities = new Map(registryResult.matches.map((match) => [match.inputSymbol, match.security]));
    const unsupported = holdings.flatMap((holding) => {
      const identity = identities.get(holding.ticker);
      return identity && !supportedSecurityTypes.has(identity.securityType) ? [`${holding.ticker} (${identity.securityType})`] : [];
    });
    if (unsupported.length) {
      return Response.json({ error: `These security types are not supported yet: ${unsupported.join(", ")}. Stocks, ADRs, REITs, ETFs, and closed-end funds are supported.` }, { status: 400 });
    }
    const verifiedHoldings = holdings.map((holding) => {
      const identity = identities.get(holding.ticker)!;
      return {
        ...holding,
        securityType: identity.securityType as PortfolioHoldingInput["securityType"],
        exchangeName: identity.exchangeName,
        registeredName: identity.securityName,
      };
    });

    const jin10Configuration = getJin10Configuration();
    if (!jin10Configuration.token) return Response.json({ error: "Jin10 MCP token is not configured." }, { status: 400 });
    const ollamaConfiguration = getOllamaConfiguration();
    const runStore = new D1AnalysisRunStore(database);
    const runId = `analysis-${Date.now()}-${crypto.randomUUID()}`;
    await runStore.createRun(runId, verifiedHoldings);

    let cancelled = false;
    let finished = false;
    let activitySequence = 0;
    let persistenceQueue = Promise.resolve();
    const persist = (operation: () => Promise<void>) => {
      persistenceQueue = persistenceQueue.then(operation);
    };
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (payload: unknown) => {
          if (!cancelled && !finished) controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
        };
        const registryActivity: PipelineActivity = {
          id: `registry-${Date.now()}`,
          at: new Date().toISOString(),
          stage: "registry",
          status: "completed",
          label: "验证美国上市证券",
          detail: `已使用本地 Nasdaq 证券目录验证 ${verifiedHoldings.length} 个投资组合持仓。`,
          model: null,
          metrics: { holdings: verifiedHoldings.length, registryStale: registryResult.status.stale },
        };
        persist(() => runStore.appendActivity(runId, activitySequence += 1, registryActivity));
        send({ type: "activity", activity: registryActivity });

        void runAnalysisPipeline({
          jin10: new Jin10McpClient(jin10Configuration),
          relevanceOllama: new OllamaClient(ollamaConfiguration.relevanceModel, ollamaConfiguration.baseUrl),
          ollama: new OllamaClient(ollamaConfiguration.impactModel, ollamaConfiguration.baseUrl),
          holdings: verifiedHoldings,
          companyProfileStore: new D1CompanyProfileStore(database),
          fundProfileStore: new D1FundProfileStore(database),
          batchSize: 6,
          maxCandidatePairs: 10,
          maxPairsPerTicker: 2,
          relevanceBatchSize: 3,
          macroRelevanceBatchSize: 1,
          impactBatchSize: 3,
          onActivity(activity) {
            persist(() => runStore.appendActivity(runId, activitySequence += 1, activity));
            send({ type: "activity", activity });
          },
        }).then(async (result) => {
          await persistenceQueue;
          await runStore.completeRun(runId, result);
          send({ type: "result", result, runId });
          finished = true;
          if (!cancelled) controller.close();
        }).catch(async (error) => {
          const message = error instanceof Error ? error.message : "投资组合新闻分析失败。";
          try {
            await persistenceQueue.catch(() => undefined);
            await runStore.failRun(runId, message);
          } catch {
            // The original technical failure remains the primary error returned to the browser.
          }
          send({ type: "error", error: message, runId, pipelineStatus: "failed", stageErrors: [{ stage: "pipeline", message, retryable: true }] });
          finished = true;
          if (!cancelled) controller.close();
        });
      },
      cancel() {
        cancelled = true;
        void runStore.interruptRun(runId);
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Analysis-Run-Id": runId,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "投资组合新闻分析失败。";
    return Response.json({ pipelineStatus: "failed", stageErrors: [{ stage: "pipeline", message, retryable: true }], error: message }, { status: 502 });
  }
}
