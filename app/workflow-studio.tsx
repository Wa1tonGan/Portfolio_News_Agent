"use client";

import { useMemo, useState } from "react";
import type { PipelineActivity } from "../lib/analysis-pipeline-next";

type AgentOverview = {
  id: string;
  name: string;
  nameZh: string;
  model: string;
  engine: string;
  purpose: string;
};

type StudioNode = {
  id: string;
  label: string;
  code: string;
  kind: "agent" | "code" | "source";
  agentId?: string;
  stage?: PipelineActivity["stage"];
  description: string;
  input: string;
  output: string;
};

type NodeState = "pending" | "active" | "ready" | "error";

const studioColumns: Array<{ title: string; subtitle: string; nodes: StudioNode[] }> = [
  {
    title: "01 · 资料准备",
    subtitle: "投资组合基础资料",
    nodes: [
      {
        id: "portfolio_input", label: "读取投资组合", code: "browser_portfolio", kind: "code",
        description: "在浏览器内读取 CSV 或 Excel，并标准化持仓。", input: "用户选择的 CSV / XLSX", output: "标准化持仓列表",
      },
      {
        id: "verify_registry", label: "美股身份验证", code: "security_registry", kind: "code", stage: "registry",
        description: "确认交易所和证券类型。", input: "投资组合 ticker", output: "已确认的美股、ADR、REIT、ETF 和基金",
      },
      {
        id: "company_research", label: "公司研究智能体", code: "company_research", kind: "agent", agentId: "company-research", stage: "profile",
        description: "缺少资料时，从结构化数据与受控来源提取公司事实。", input: "公司身份与受控证据", output: "有来源的公司资料",
      },
      {
        id: "fund_research", label: "基金研究智能体", code: "fund_research", kind: "agent", agentId: "fund-research", stage: "profile",
        description: "确认基金类型、策略、暴露与有日期的主要持仓。", input: "基金身份与发行方资料", output: "可复用的基金资料",
      },
      {
        id: "load_profiles", label: "载入资料", code: "load_profiles", kind: "code", stage: "profile",
        description: "载入已保存的公司与基金资料，并保留缺失、过期和冲突状态。", input: "资料库", output: "智能体可使用的证据背景",
      },
    ],
  },
  {
    title: "02 · 资讯发现",
    subtitle: "金十资讯发现",
    nodes: [
      {
        id: "build_search_plan", label: "建立搜索计划", code: "build_search_plan", kind: "code", stage: "search",
        description: "根据登记名称、别名、基金成分及宏观主题建立有限搜索词。", input: "持仓与已验证资料", output: "微观与宏观搜索计划",
      },
      {
        id: "collect_latest_index", label: "最新资讯索引", code: "collect_latest_index", kind: "source", stage: "news",
        description: "从 Jin10 最新流建立带 ID 和时间的当日索引。", input: "Jin10 快讯与资讯流", output: "可验证时间的候选索引",
      },
      {
        id: "search_micro_news", label: "公司 / 基金搜索", code: "search_micro_news", kind: "source", stage: "search",
        description: "按公司名称、别名、产品与基金持仓寻找候选新闻。", input: "微观搜索词", output: "公司与基金候选资讯",
      },
      {
        id: "search_macro_news", label: "宏观主题搜索", code: "search_macro_news", kind: "source", stage: "search",
        description: "寻找利率、通胀、美元、能源、政策和地缘政治资讯。", input: "宏观搜索主题", output: "宏观候选资讯",
      },
      {
        id: "collect_calendar", label: "财经日历", code: "collect_calendar", kind: "source", stage: "calendar",
        description: "取得当天经济数据的实际值、预期值和前值。", input: "Jin10 财经日历", output: "结构化经济事件",
      },
      {
        id: "validate_freshness", label: "当日时间验证", code: "validate_freshness", kind: "code", stage: "freshness",
        description: "仅允许 UTC+8 当日且时间可验证的资讯进入模型。", input: "全部候选资讯", output: "通过时间验证的资讯",
      },
    ],
  },
  {
    title: "03 · 关联推理",
    subtitle: "关联推理",
    nodes: [
      {
        id: "micro_relevance", label: "微观关联智能体", code: "micro_relevance", kind: "agent", agentId: "micro", stage: "micro",
        description: "判断新闻与公司、产品、客户、竞争关系及基金成分的微观连接。", input: "当日资讯、持仓与资料", output: "持仓连接、评分与因果路径",
      },
      {
        id: "macro_relevance", label: "宏观关联智能体", code: "macro_relevance", kind: "agent", agentId: "macro", stage: "macro",
        description: "自主判断全球、国家、行业与持仓层面的经济传导。", input: "宏观资讯与持仓暴露", output: "影响范围、市场、因果链与连接",
      },
      {
        id: "merge_and_select", label: "合并与公平筛选", code: "merge_and_select", kind: "code", stage: "selection",
        description: "合并微观与宏观判断，并限制单一股票代码占满处理容量。", input: "两个关联智能体的输出", output: "最多 10 个新闻—持仓组合",
      },
      {
        id: "fetch_selected_evidence", label: "获取完整证据", code: "fetch_selected_evidence", kind: "source", stage: "evidence",
        description: "只对入选新闻获取完整文章，并记录证据等级。", input: "入选资讯 ID", output: "完整文章或明确的证据状态",
      },
    ],
  },
  {
    title: "04 · 影响结果",
    subtitle: "影响判断与直接输出",
    nodes: [
      {
        id: "impact_analysis", label: "影响分析智能体", code: "impact_analysis", kind: "agent", agentId: "impact", stage: "impact",
        description: "解释每个新闻—持仓组合可能利好或利空的业务原因，并直接形成展示结果。", input: "组合、证据与公司资料", output: "方向、强度、时间、原因与限制",
      },
      {
        id: "finalize", label: "中文结果", code: "finalize", kind: "code", stage: "final",
        description: "按新闻组合所有 ticker 判断，并将技术失败单独显示。", input: "Impact 分析结果", output: "利好 / 利空中文解释",
      },
    ],
  },
];

const allNodes = studioColumns.flatMap((column) => column.nodes);

function statusLabel(state: NodeState) {
  if (state === "active") return "运行中";
  if (state === "ready") return "完成";
  if (state === "error") return "失败";
  return "等待";
}

function activityStatusLabel(status: PipelineActivity["status"]) {
  if (status === "started") return "运行中";
  if (status === "completed") return "完成";
  if (status === "failed") return "失败";
  return "信息";
}

function nodeMatchesActivity(node: StudioNode, activity: PipelineActivity) {
  if (activity.graphNode === node.id) return true;
  if (node.id === "verify_registry") return activity.stage === "registry";
  if (node.id === "company_research") {
    return activity.stage === "profile" && (activity.label.includes("公司") || activity.detail.includes("公司"));
  }
  if (node.id === "fund_research") {
    return activity.stage === "profile" && (activity.label.includes("基金") || activity.detail.includes("基金"));
  }
  return !activity.graphNode && Boolean(node.stage) && activity.stage === node.stage;
}

export function WorkflowStudio({
  agents,
  activities,
  running,
  elapsedSeconds,
  holdingsCount,
  profilesRunning,
  profilesCompleted,
  profileFailures,
  analysisReady,
  runError,
}: {
  agents: AgentOverview[];
  activities: PipelineActivity[];
  running: boolean;
  elapsedSeconds: number;
  holdingsCount: number;
  profilesRunning: boolean;
  profilesCompleted: number;
  profileFailures: number;
  analysisReady: boolean;
  runError: string;
}) {
  const [selectedNodeId, setSelectedNodeId] = useState("micro_relevance");
  const [activityMode, setActivityMode] = useState<"node" | "all">("node");

  const agentMap = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const selectedNode = allNodes.find((node) => node.id === selectedNodeId) ?? allNodes[0];

  const nodeActivities = useMemo(
    () => activities.filter((activity) => nodeMatchesActivity(selectedNode, activity)),
    [activities, selectedNode],
  );
  const visibleActivities = activityMode === "node" ? nodeActivities : activities;

  function latestFor(node: StudioNode) {
    return [...activities].reverse().find((activity) => nodeMatchesActivity(node, activity));
  }

  function stateFor(node: StudioNode): NodeState {
    if (node.id === "portfolio_input") return holdingsCount ? "ready" : "pending";
    if (node.id === "load_profiles" && profilesRunning) return "active";
    if (node.id === "load_profiles" && profilesCompleted > 0) return profileFailures ? "error" : "ready";
    const activity = latestFor(node);
    if (!activity) return "pending";
    if (activity.status === "started") return "active";
    if (activity.status === "failed") return "error";
    return "ready";
  }

  const selectedState = stateFor(selectedNode);
  const selectedAgent = selectedNode.agentId ? agentMap.get(selectedNode.agentId) : undefined;
  const selectedLatest = latestFor(selectedNode);
  const completedNodes = allNodes.filter((node) => stateFor(node) === "ready").length;

  return (
    <section className="workflow-studio" id="workflow" aria-label="投资组合新闻影响工作流">
      <header className="studio-toolbar">
        <div className="studio-title">
          <div className="studio-breadcrumb"><span>工作区</span><i>/</i><strong>新闻影响工作流</strong></div>
          <div className="studio-title-row">
            <h1>投资组合新闻影响</h1>
            <span className={`studio-run-state ${running ? "active" : analysisReady ? "ready" : ""}`}>
              <i />{running ? `运行中 · ${elapsedSeconds}s` : analysisReady ? "本次运行完成" : "等待运行"}
            </span>
          </div>
        </div>
        <div className="studio-actions">
          <a href="#setup" className="studio-secondary-action">设置与资料</a>
        </div>
      </header>

      <div className="studio-summary">
        <span><strong>{holdingsCount}</strong> 个持仓</span>
        <span><strong>{allNodes.length}</strong> 个节点</span>
        <span><strong>{agents.length}</strong> 个 Agent</span>
        <span><strong>{completedNodes}</strong> 已完成</span>
        <span><strong>{activities.length}</strong> 活动事件</span>
        {runError ? <span className="studio-error"><strong>技术问题</strong> {runError}</span> : null}
      </div>

      <div className="studio-workspace">
        <div className="studio-canvas" aria-label="LangGraph 活动图">
          <div className="canvas-grid">
            {studioColumns.map((column, columnIndex) => (
              <section className="canvas-lane" key={column.title}>
                <div className="canvas-lane-heading">
                  <strong>{column.title}</strong>
                  <span>{column.subtitle}</span>
                </div>
                <div className="canvas-node-list">
                  {column.nodes.map((node, nodeIndex) => {
                    const state = stateFor(node);
                    const agent = node.agentId ? agentMap.get(node.agentId) : undefined;
                    const latest = latestFor(node);
                    const duration = latest?.metrics?.durationSeconds;
                    return (
                      <div className="canvas-node-segment" key={node.id}>
                        <button
                          type="button"
                          className={`canvas-node ${node.kind} ${state}${selectedNode.id === node.id ? " selected" : ""}`}
                          onClick={() => { setSelectedNodeId(node.id); setActivityMode("node"); }}
                          aria-pressed={selectedNode.id === node.id}
                        >
                          <span className="canvas-node-icon">{node.kind === "agent" ? "◆" : node.kind === "source" ? "◎" : "●"}</span>
                          <span className="canvas-node-copy">
                            <strong>{node.label}</strong>
                            <code>{agent?.model ?? (node.kind === "source" ? "金十 MCP" : "TypeScript")}</code>
                          </span>
                          <span className="canvas-node-status">
                            <i />{typeof duration === "number" ? `${duration}s` : statusLabel(state)}
                          </span>
                        </button>
                        {nodeIndex < column.nodes.length - 1 ? <span className="canvas-connector" aria-hidden="true">↓</span> : null}
                      </div>
                    );
                  })}
                </div>
                {columnIndex < studioColumns.length - 1 ? <span className="canvas-column-connector" aria-hidden="true">→</span> : null}
              </section>
            ))}
          </div>
          <div className="canvas-legend">
            <span><i className="legend-agent">◆</i> Ollama 智能体</span>
            <span><i className="legend-source">◎</i> 外部数据工具</span>
            <span><i className="legend-code">●</i> TypeScript 控制</span>
            <span>微观关联完成后再运行宏观关联，避免模型资源竞争</span>
          </div>
        </div>

        <aside className="studio-inspector" aria-live="polite">
          <div className="inspector-tabs" role="group" aria-label="活动显示范围">
            <button type="button" className={activityMode === "node" ? "active" : ""} onClick={() => setActivityMode("node")}>节点详情</button>
            <button type="button" className={activityMode === "all" ? "active" : ""} onClick={() => setActivityMode("all")}>全部活动</button>
          </div>

          {activityMode === "node" ? (
            <>
              <div className="inspector-heading">
                <span className={`inspector-kind ${selectedNode.kind}`}>{selectedNode.kind === "agent" ? "智能体" : selectedNode.kind === "source" ? "数据工具" : "代码"}</span>
                <h2>{selectedNode.label}</h2>
                <code>{selectedNode.code}</code>
                <span className={`inspector-status ${selectedState}`}><i />{statusLabel(selectedState)}</span>
              </div>
              <div className="inspector-definition">
                <p>{selectedAgent?.purpose ?? selectedNode.description}</p>
                <dl>
                  <div><dt>模型 / 引擎</dt><dd>{selectedAgent ? `${selectedAgent.engine} · ${selectedAgent.model}` : selectedNode.kind === "source" ? "金十 MCP" : "无模型 · TypeScript"}</dd></div>
                  <div><dt>输入</dt><dd>{selectedNode.input}</dd></div>
                  <div><dt>输出</dt><dd>{selectedNode.output}</dd></div>
                  {selectedLatest?.batch ? <div><dt>最近批次</dt><dd>{selectedLatest.batch.current}/{selectedLatest.batch.total} · {selectedLatest.batch.items} 项</dd></div> : null}
                </dl>
              </div>
            </>
          ) : (
            <div className="inspector-heading activity-mode-heading">
              <span className="inspector-kind code">执行记录</span>
              <h2>全部活动</h2>
              <p>按时间显示真实节点、模型、批次、指标和技术问题。</p>
            </div>
          )}

          <div className="inspector-activity">
            <div className="inspector-activity-heading">
              <strong>{activityMode === "node" ? "节点活动" : "运行日志"}</strong>
              <span>{visibleActivities.length} 个事件</span>
            </div>
            {visibleActivities.length ? (
              <ol>
                {[...visibleActivities].reverse().map((activity) => (
                  <li className={activity.status} key={activity.id}>
                    <span className="activity-line-dot" />
                    <div>
                      <div className="activity-log-topline">
                        <time>{new Date(activity.at).toLocaleTimeString("zh-CN", { hour12: false })}</time>
                        <span>{activityStatusLabel(activity.status)}</span>
                      </div>
                      <strong>{activity.label}</strong>
                      <code>{activity.model ?? "无模型 · TypeScript"}</code>
                      <p>{activity.detail}</p>
                      {activity.batch ? <small>批次 {activity.batch.current}/{activity.batch.total} · {activity.batch.items} 项</small> : null}
                      {activity.metrics ? <small>{Object.entries(activity.metrics).map(([key, value]) => `${key}: ${value}`).join(" · ")}</small> : null}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="inspector-empty">
                <span>◎</span>
                <p>{selectedState === "pending" ? "这个节点尚未运行。运行工作流后，输入、批次、耗时和错误会显示在这里。" : "本次运行没有记录该节点的额外活动。"}</p>
              </div>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
