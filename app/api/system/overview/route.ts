import { getOllamaConfiguration } from "../../../../lib/ollama";

export const dynamic = "force-dynamic";

export async function GET() {
  const configuration = getOllamaConfiguration();
  return Response.json({
    agents: [
      {
        id: "company-research", name: "公司研究", nameZh: "公司研究",
        model: configuration.researchModel, engine: "Ollama",
        purpose: "先读取 Alpha Vantage 的结构化公司概况；行业或业务性质不足时，才用受控网页研究智能体补充。",
      },
      {
        id: "fund-research", name: "基金研究", nameZh: "基金研究",
        model: configuration.researchModel, engine: "Ollama",
        purpose: "先读取 Alpha Vantage 的基金类型与主要暴露；资料不足或属于复杂产品时，才用受控网页研究智能体补充。",
      },
      {
        id: "micro", name: "微观关联", nameZh: "微观关联",
        model: configuration.relevanceModel, engine: "Ollama",
        purpose: "寻找新闻与持仓公司、产品、客户及竞争关系的直接或间接关联。",
      },
      {
        id: "macro", name: "宏观关联", nameZh: "宏观关联",
        model: configuration.relevanceModel, engine: "Ollama",
        purpose: "自主判断全球、国家、行业及持仓层面的经济传导；代码只验证因果链、持仓代码与证据上限。",
      },
      {
        id: "impact", name: "影响分析", nameZh: "影响分析",
        model: configuration.impactModel, engine: "Ollama",
        purpose: "对入选的新闻—持仓组合判断业务影响方向并解释因果路径；通过结构验证后直接显示。",
      },
    ],
    deterministicSteps: [
      { id: "langgraph", nameZh: "LangGraph 本地编排", purpose: "把每个分析阶段作为独立节点运行，串流节点活动，并在内存中保存本次运行检查点。" },
      { id: "portfolio", nameZh: "投资组合解析", purpose: "读取 CSV/XLSX，并只保留经目录确认的美股持仓。" },
      { id: "registry", nameZh: "美股身份验证", purpose: "使用本地 Nasdaq 证券目录确认交易所和证券类型。" },
      { id: "profile", nameZh: "自动资料准备", purpose: "逐个检查本地资料，缺少时先调用 Alpha Vantage；只有结构化资料不足才运行 Tavily 与本地研究智能体，并把结果存回本地数据库。" },
      { id: "search-plan", nameZh: "受控搜索计划", purpose: "从证券登记名称、已验证公司别名、基金基准与持仓建立有上限的微观搜索词，并用美国经济、利率、通胀、能源、政策及已验证暴露建立宏观搜索主题。" },
      { id: "news", nameZh: "金十资讯收集", purpose: "使用 search_flash、search_news、最新资讯流与财经日历；只对最终入选的文章抓取全文。" },
      { id: "freshness", nameZh: "当日时间验证", purpose: "按 UTC+8 验证时间；无时间的搜索结果必须用相同金十 ID 在最新流中找到，旧闻、未来时间及无法验证的项目不会交给模型。" },
      { id: "selection", nameZh: "公平候选选择", purpose: "优先相关性，并限制单一股票占满所有名额。" },
      { id: "validation", nameZh: "结构与证据验证", purpose: "拒绝缺失、重复、未知组合及无证据的高置信度结论。" },
      { id: "final", nameZh: "结果输出", purpose: "直接展示 Impact 的方向和解释；技术失败始终单独显示。" },
    ],
  });
}
