"use client";

import { useMemo, useState } from "react";

type NewsStatus = "relevant" | "needs_review" | "unrelated";

export type AnalysisResult = {
  generatedAt: string;
  pipelineStatus: "completed" | "partial" | "failed";
  stageErrors: Array<{ stage: string; message: string; retryable: boolean; pairKeys?: string[] }>;
  batchSize: number;
  durationSeconds: number;
  companyProfiles: Array<{
    ticker: string; companyName: string;
    availability: "ready" | "missing" | "incomplete" | "stale" | "conflicted" | "error";
    complete: boolean; stale: boolean; reusable: boolean; missingCategories: string[];
    conflictCount: number; verifiedFactCount: number; unverifiedFactCount: number; technicalError: string | null;
  }>;
  fundProfiles: Array<{
    ticker: string; fundName: string;
    availability: "ready" | "missing" | "incomplete" | "stale" | "conflicted" | "error";
    complete: boolean; stale: boolean; reusable: boolean; missingCategories: string[];
    missingExposure: boolean; missingNature: boolean; missingStructureFields: string[]; conflictCount: number;
    verifiedFactCount: number; unverifiedFactCount: number;
    verifiedHoldingCount: number; unverifiedHoldingCount: number; technicalError: string | null;
  }>;
  counts: {
    relevant: number; needsReview: number; unrelated: number; impacts: number; completedImpacts: number;
    technicalFailures: number; deferred: number; detailsFetched: number; macroAlerts: number;
  };
  retrieval: {
    detailRequested: number; detailFetched: number; detailFailed: number; detailSeconds: number;
    jin10Calls: number; latestCandidates: number; microCandidates: number; macroCandidates: number;
    calendarCandidates: number; freshnessRejected: Record<string, number>;
  };
  searchPlan: {
    microTerms: Array<{ keyword: string; tickers: string[]; basis: string }>;
    macroTopics: Array<{ keyword: string; tickers: string[]; basis: string }>;
  };
  workflow: { engine: "LangGraph"; checkpoint: "memory"; nodes: string[] };
  agentTimings: {
    relevanceModel: string; impactModel: string;
    microSeconds: number; macroSeconds: number; impactSeconds: number;
  };
  candidateCoverage: Array<{
    newsId: string; ticker: string; relevanceScore: number;
    status: "selected" | "below_threshold" | "deferred_capacity" | "deferred_ticker_limit"; reason: string;
  }>;
  news: Array<{
    id: string; kind: "flash" | "news" | "calendar"; title: string; summary: string; time: string; url: string;
    retrievedBy: string[]; matchedKeywords: string[]; freshness: "verified_timestamp" | "inherited_latest_time";
    microScore: number; macroScore: number; status: NewsStatus; route: "micro" | "macro" | "both" | "none";
    microReason: string; macroReason: string; macroFactors: string[];
    macroScope: "none" | "global" | "country" | "sector" | "holding";
    macroAffectedMarkets: string[]; macroEconomyImpact: string;
    detailFetched: boolean; evidenceLevel: "flash_text" | "full_article" | "headline_only";
  }>;
  impacts: Array<{
    newsId: string; ticker: string; status: "completed" | "impact_failed" | "review_failed" | "evidence_fetch_failed";
    finalLabel: string | null; finalConfidence: number | null; finalSummary: string | null;
    directness: string; timeHorizon: string | null; evidenceLevel: "flash_text" | "headline_only" | "full_article";
    businessImpact: string | null;
    possibleMarketChannel: string | null; causalPath: string[]; evidence: string | null; limitations: string[];
    technicalError?: string;
  }>;
};

const labels: Record<string, string> = {
  positive: "利好",
  negative: "利空",
  mixed: "好坏参半",
  neutral: "中性",
  uncertain: "不确定",
};

function statusLabel(status: NewsStatus) {
  if (status === "relevant") return "相关";
  if (status === "needs_review") return "可能相关";
  return "不相关";
}

const displayTerms: Record<string, string> = {
  completed: "已完成", partial: "部分完成", failed: "失败",
  ready: "可用", missing: "缺失", incomplete: "不完整", stale: "已过期", conflicted: "有冲突", error: "技术错误",
  direct: "直接", indirect: "间接",
  flash_text: "快讯全文", headline_only: "仅标题", full_article: "完整文章",
  immediate: "即时", short_term: "短期", long_term: "长期",
  approved: "通过", downgraded: "下调", rejected: "驳回",
  micro: "微观", macro: "宏观", both: "微观与宏观", none: "无",
  global: "全球", country: "国家经济", sector: "行业", holding: "持仓",
};

function displayTerm(value: string | null) {
  return value ? displayTerms[value] ?? value.replaceAll("_", " ") : "—";
}

export function AnalysisDashboard({ result, runId }: { result: AnalysisResult; runId: string }) {
  const [filter, setFilter] = useState<"all" | NewsStatus>("all");
  const filteredNews = useMemo(() => filter === "all" ? result.news : result.news.filter((item) => item.status === filter), [filter, result.news]);
  const newsMap = useMemo(() => new Map(result.news.map((item) => [item.id, item])), [result.news]);
  const deferred = useMemo(() => result.candidateCoverage.filter((item) => item.status.startsWith("deferred")), [result.candidateCoverage]);
  const impactGroups = useMemo(() => {
    const groups = new Map<string, AnalysisResult["impacts"]>();
    result.impacts.forEach((impact) => {
      const group = groups.get(impact.newsId);
      if (group) group.push(impact);
      else groups.set(impact.newsId, [impact]);
    });
    return [...groups].map(([newsId, impacts]) => ({ newsId, impacts }));
  }, [result.impacts]);
  const reusableProfiles = useMemo(
    () => result.companyProfiles.filter((profile) => profile.reusable).length + result.fundProfiles.filter((profile) => profile.reusable).length,
    [result.companyProfiles, result.fundProfiles],
  );
  const outcomeCounts = useMemo(() => result.impacts.reduce(
    (counts, impact) => {
      if (impact.status !== "completed") counts.technical += 1;
      else if (impact.finalLabel === "positive") counts.positive += 1;
      else if (impact.finalLabel === "negative") counts.negative += 1;
      else counts.other += 1;
      return counts;
    },
    { positive: 0, negative: 0, other: 0, technical: 0 },
  ), [result.impacts]);

  return (
    <section className="analysis-results" aria-label="投资组合新闻影响分析结果">
      <div className="results-heading">
        <div>
          <div className="eyebrow">实时分析批次</div>
          <h2>投资组合新闻影响</h2>
          <p>{result.workflow.engine} 工作流 · 本批读取 {result.batchSize} 条金十资讯 · 筛选后获取 {result.retrieval.detailFetched} 篇完整文章 · {displayTerm(result.pipelineStatus)} · 用时 {Math.round(result.durationSeconds)} 秒</p>
        </div>
        <div className="result-counts">
          <span><strong>{result.counts.relevant}</strong> 相关</span>
          <span><strong>{result.counts.needsReview}</strong> 可能相关</span>
          <span><strong>{result.counts.unrelated}</strong> 不相关</span>
          {result.counts.macroAlerts ? <span><strong>{result.counts.macroAlerts}</strong> 宏观影响</span> : null}
          <span><strong>{result.counts.completedImpacts}</strong> 已完成</span>
          {result.counts.technicalFailures ? <span><strong>{result.counts.technicalFailures}</strong> 技术问题</span> : null}
          {result.counts.deferred ? <span><strong>{result.counts.deferred}</strong> 延后</span> : null}
        </div>
      </div>

      <div className="outcome-overview" aria-label="最终判断摘要">
        <article className="positive">
          <span>利好</span>
          <strong>{outcomeCounts.positive}</strong>
          <p>业务影响方向较正面</p>
        </article>
        <article className="negative">
          <span>利空</span>
          <strong>{outcomeCounts.negative}</strong>
          <p>业务影响方向较负面</p>
        </article>
        <article className="other">
          <span>方向不明确</span>
          <strong>{outcomeCounts.other}</strong>
          <p>好坏参半、中性或证据不足</p>
        </article>
        <article className="technical">
          <span>技术问题</span>
          <strong>{outcomeCounts.technical}</strong>
          <p>不会伪装成金融判断</p>
        </article>
      </div>

      <div className="coverage-banner">
        <strong>{result.companyProfiles.length} 家公司、{result.fundProfiles.length} 个基金中，有 {reusableProfiles} 份基础资料可用、有效且无冲突。</strong>
        <details>
          <summary>查看公司与基金资料覆盖情况</summary>
          <ul>{result.companyProfiles.map((profile) => (
            <li key={profile.ticker}>
              <strong>{profile.ticker}</strong> · {displayTerm(profile.availability)} · {profile.verifiedFactCount} 条已验证，{profile.unverifiedFactCount} 条未验证
              {profile.missingCategories.length ? ` · 缺少 ${profile.missingCategories.join(", ")}` : ""}
              {profile.conflictCount ? ` · ${profile.conflictCount} 个冲突` : ""}
              {profile.technicalError ? ` · 技术问题：${profile.technicalError}` : ""}
            </li>
          ))}
          {result.fundProfiles.map((profile) => (
            <li key={profile.ticker}>
              <strong>{profile.ticker}</strong> · 基金 · {displayTerm(profile.availability)} · {profile.verifiedFactCount} 条已验证事实，{profile.verifiedHoldingCount} 条已验证持仓
              {profile.missingCategories.length ? ` · 缺少 ${profile.missingCategories.join(", ")}` : ""}
              {profile.missingExposure ? " · 缺少已验证暴露" : ""}
              {profile.missingNature ? " · 缺少基金策略或主要持仓" : ""}
              {profile.conflictCount ? ` · ${profile.conflictCount} 个冲突` : ""}
              {profile.technicalError ? ` · 技术问题：${profile.technicalError}` : ""}
            </li>
          ))}</ul>
        </details>
      </div>

      <div className="coverage-banner">
        <strong>本批执行 {result.retrieval.jin10Calls} 次受控金十调用；只有时间验证通过的当日资讯进入 Agent。</strong>
        <details>
          <summary>查看搜索词与时间过滤</summary>
          <p><strong>微观搜索：</strong> {result.searchPlan.microTerms.map((term) => term.keyword).join("、") || "无"}</p>
          <p><strong>宏观搜索：</strong> {result.searchPlan.macroTopics.map((topic) => topic.keyword).join("、") || "无"}</p>
          <p><strong>原始候选：</strong> 最新流 {result.retrieval.latestCandidates} · Micro {result.retrieval.microCandidates} · Macro {result.retrieval.macroCandidates} · 日历 {result.retrieval.calendarCandidates}</p>
          <p><strong>时间拒绝：</strong> {Object.entries(result.retrieval.freshnessRejected).map(([reason, count]) => `${reason} ${count}`).join(" · ")}</p>
        </details>
      </div>

      {result.stageErrors.length ? (
        <div className="technical-banner" role="status">
          <strong>部分分析步骤出现技术问题。</strong>
          <p>任何失败项目都不会被标记为利好、利空、好坏参半、中性或不确定。</p>
          <details><summary>查看技术详情</summary><ul>{result.stageErrors.map((error, index) => <li key={`${error.stage}-${index}`}><strong>{error.stage}：</strong> {error.message}</li>)}</ul></details>
        </div>
      ) : null}

      {deferred.length ? (
        <div className="coverage-banner">
          <strong>{deferred.length} 个有效关联被延后处理，并未删除。</strong>
          <details><summary>查看延后的关联</summary><ul>{deferred.map((item) => <li key={`${item.newsId}-${item.ticker}`}><strong>{item.ticker}</strong> · 评分 {item.relevanceScore} — {item.reason}</li>)}</ul></details>
        </div>
      ) : null}

      {result.impacts.length ? (
        <div className="impact-grid">
          {impactGroups.map(({ newsId, impacts }) => {
            const source = newsMap.get(newsId);
            return (
              <article className="impact-card impact-news-card" key={newsId}>
                <header className="impact-news-header">
                  <div>
                    <div className="impact-news-kicker">
                      {source?.kind === "flash" ? "金十快讯" : source?.kind === "calendar" ? "财经日历" : "金十新闻"}
                    </div>
                    <h3>
                      {source?.url
                        ? <a href={source.url} target="_blank" rel="noreferrer">{source.title}</a>
                        : source?.title ?? newsId}
                    </h3>
                  </div>
                  <span className="impact-news-count">{impacts.length} 个持仓判断</span>
                </header>
                <div className="impact-judgement-list">
                  {impacts.map((impact) => {
                    const failed = impact.status !== "completed";
                    const finalLabel = impact.finalLabel;
                    const detailHref = `/analysis-detail?run=${encodeURIComponent(runId)}&news=${encodeURIComponent(impact.newsId)}&ticker=${encodeURIComponent(impact.ticker)}`;
                    return (
                      <a
                        className={`impact-judgement ${failed ? "technical" : ""}`}
                        key={`${impact.newsId}-${impact.ticker}`}
                        href={detailHref}
                        aria-label={`查看 ${impact.ticker} 的完整影响分析`}
                      >
                        <div className="impact-topline">
                          <strong>{impact.ticker}</strong>
                          {failed
                            ? <span className="technical-label">技术问题</span>
                            : <span className={`direction-label ${finalLabel}`}>{labels[finalLabel ?? ""] ?? finalLabel}</span>}
                        </div>
                        <div className="impact-meta">
                          <span>{displayTerm(impact.directness)}</span><span>{displayTerm(impact.evidenceLevel)}</span>
                          {impact.timeHorizon ? <span>{displayTerm(impact.timeHorizon)}</span> : null}
                          {impact.finalConfidence !== null ? <span>置信度 {impact.finalConfidence}%</span> : null}
                        </div>
                        <p className="review-summary">{failed ? impact.technicalError : impact.finalSummary}</p>
                        <span className="impact-detail-link">查看完整分析 <span aria-hidden="true">→</span></span>
                      </a>
                    );
                  })}
                </div>
              </article>
            );
          })}
        </div>
      ) : <div className="empty-impact">本批没有持仓—新闻组合通过筛选；所有已收集资讯仍会显示在下方。</div>}

      <div className="news-browser">
        <div className="news-browser-heading">
          <div><h3>全部已收集资讯</h3><p>不会静默删除任何项目；微观与宏观评分保持分开。</p></div>
          <div className="news-tabs" role="group" aria-label="筛选新闻相关性">
            {(["all", "relevant", "needs_review", "unrelated"] as const).map((value) => (
              <button key={value} type="button" className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>
                {value === "all" ? "全部" : statusLabel(value)}
              </button>
            ))}
          </div>
        </div>

        <div className="news-list">
          {filteredNews.map((item) => (
            <article className="news-row" key={item.id}>
              <div className="news-source">
                <span>{item.kind === "flash" ? "快讯" : item.kind === "calendar" ? "财经日历" : "新闻"}</span>
                <time>{item.time ? new Date(item.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}</time>
              </div>
              <div className="news-main">
                <div className="news-title-line">
                  {item.url ? <a href={item.url} target="_blank" rel="noreferrer">{item.title}</a> : <strong>{item.title}</strong>}
                  <span className={`news-status ${item.status}`}>{statusLabel(item.status)}</span>
                  <span className={`detail-badge ${item.evidenceLevel}`}>{displayTerm(item.evidenceLevel)}</span>
                </div>
                <p>{item.summary}</p>
                <details>
                  <summary>判断依据：微观 {item.microScore} · 宏观 {item.macroScore} · {displayTerm(item.route)}</summary>
                  <div className="relevance-reasons">
                    <p><strong>微观：</strong> {item.microReason}</p>
                    <p><strong>宏观：</strong> {item.macroReason}</p>
                    {item.macroScope !== "none" ? <p><strong>影响范围：</strong> {displayTerm(item.macroScope)}{item.macroAffectedMarkets.length ? ` · ${item.macroAffectedMarkets.join("、")}` : ""}</p> : null}
                    {item.macroEconomyImpact ? <p><strong>整体经济传导：</strong> {item.macroEconomyImpact}</p> : null}
                    {item.macroFactors.length ? <p><strong>宏观因素：</strong> {item.macroFactors.join("、")}</p> : null}
                  </div>
                </details>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
