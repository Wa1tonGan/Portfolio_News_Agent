"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { AnalysisResult } from "../analysis-results";

type AnalysisRunResponse = {
  id: string;
  status: "running" | "completed" | "failed" | "interrupted";
  result: AnalysisResult | null;
  error: string | null;
};

const labels: Record<string, string> = {
  positive: "利好",
  negative: "利空",
  mixed: "好坏参半",
  neutral: "中性",
  uncertain: "不确定",
};

const terms: Record<string, string> = {
  direct: "直接影响",
  indirect: "间接影响",
  flash_text: "快讯内容",
  headline_only: "仅标题",
  full_article: "完整文章",
  immediate: "即时",
  short_term: "短期",
  long_term: "长期",
};

function displayTerm(value: string | null) {
  return value ? terms[value] ?? value.replaceAll("_", " ") : "—";
}

export default function AnalysisDetailPage() {
  const search = useSearchParams();
  const [run, setRun] = useState<AnalysisRunResponse | null>(null);
  const [error, setError] = useState("");
  const runId = search.get("run") ?? "";
  const newsId = search.get("news") ?? "";
  const ticker = (search.get("ticker") ?? "").toUpperCase();
  const invalidLink = !runId || !newsId || !ticker;

  useEffect(() => {
    if (invalidLink) return;

    let active = true;
    void fetch(`/api/analysis/history/${encodeURIComponent(runId)}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json() as AnalysisRunResponse & { error?: string };
        if (!response.ok) throw new Error(body.error || "无法读取分析记录。");
        return body;
      })
      .then((body) => {
        if (active) setRun(body);
      })
      .catch((caught) => {
        if (active) setError(caught instanceof Error ? caught.message : "无法读取分析详情。");
      });
    return () => { active = false; };
  }, [invalidLink, runId]);

  const news = useMemo(
    () => run?.result?.news.find((item) => item.id === newsId) ?? null,
    [newsId, run],
  );
  const impact = useMemo(
    () => run?.result?.impacts.find((item) => item.newsId === newsId && item.ticker === ticker) ?? null,
    [newsId, run, ticker],
  );

  if (invalidLink || error) {
    return (
      <main className="analysis-detail-shell">
        <Link className="analysis-detail-back" href="/">← 返回分析结果</Link>
        <section className="analysis-detail-error">
          <span>技术问题</span>
          <h1>无法打开这项分析</h1>
          <p>{invalidLink ? "分析详情链接不完整。" : error}</p>
        </section>
      </main>
    );
  }

  if (!run) {
    return (
      <main className="analysis-detail-shell">
        <Link className="analysis-detail-back" href="/">← 返回分析结果</Link>
        <div className="analysis-detail-loading">正在读取分析详情…</div>
      </main>
    );
  }

  if (!news || !impact) {
    return (
      <main className="analysis-detail-shell">
        <Link className="analysis-detail-back" href="/">← 返回分析结果</Link>
        <section className="analysis-detail-error">
          <span>找不到记录</span>
          <h1>这项股票判断不存在</h1>
          <p>请返回结果页并重新选择一项分析。</p>
        </section>
      </main>
    );
  }

  const failed = impact.status !== "completed";

  return (
    <main className="analysis-detail-shell">
      <header className="analysis-detail-nav">
        <Link className="analysis-detail-back" href="/">← 返回分析结果</Link>
        <span>影响分析详情</span>
      </header>

      <article className={`analysis-detail-card ${failed ? "technical" : ""}`}>
        <div className="analysis-detail-news-type">
          {news.kind === "flash" ? "金十快讯" : news.kind === "calendar" ? "财经日历" : "金十新闻"}
        </div>
        <h1>{news.title}</h1>
        <div className="analysis-detail-source-meta">
          <time>{news.time ? new Date(news.time).toLocaleString("zh-CN", { hour12: false }) : "时间不明"}</time>
          <span>{displayTerm(impact.evidenceLevel)}</span>
          {news.url ? <a href={news.url} target="_blank" rel="noreferrer">查看新闻来源 ↗</a> : null}
        </div>

        <section className="analysis-detail-outcome">
          <div>
            <span>受影响持仓</span>
            <strong>{impact.ticker}</strong>
          </div>
          {failed
            ? <div className="analysis-detail-direction technical"><span>状态</span><strong>技术问题</strong></div>
            : <div className={`analysis-detail-direction ${impact.finalLabel ?? ""}`}><span>Ollama 判断</span><strong>{labels[impact.finalLabel ?? ""] ?? impact.finalLabel}</strong></div>}
          <div>
            <span>置信度</span>
            <strong>{impact.finalConfidence === null ? "—" : `${impact.finalConfidence}%`}</strong>
          </div>
          <div>
            <span>影响范围</span>
            <strong>{displayTerm(impact.directness)} · {displayTerm(impact.timeHorizon)}</strong>
          </div>
        </section>

        {failed ? (
          <section className="analysis-detail-section technical">
            <span>技术详情</span>
            <p className="analysis-detail-reason">{impact.technicalError ?? "这项分析没有成功完成。"}</p>
          </section>
        ) : (
          <>
            <section className="analysis-detail-section primary">
              <span>为什么会影响 {impact.ticker}</span>
              <p className="analysis-detail-reason">{impact.finalSummary}</p>
            </section>

            <div className="analysis-detail-grid">
              <section className="analysis-detail-section">
                <span>业务影响</span>
                <p>{impact.businessImpact}</p>
              </section>
              <section className="analysis-detail-section">
                <span>可能的市场传导</span>
                <p>{impact.possibleMarketChannel}</p>
              </section>
            </div>

            <section className="analysis-detail-section">
              <span>因果路径</span>
              <ol className="causal-path-list">
                {impact.causalPath.map((step, index) => (
                  <li key={`${index}-${step}`}><i>{index + 1}</i><p>{step}</p></li>
                ))}
              </ol>
            </section>

            <section className="analysis-detail-section">
              <span>使用的证据</span>
              <p>{impact.evidence}</p>
            </section>

            <section className="analysis-detail-section limitations">
              <span>限制与不确定因素</span>
              {impact.limitations.length
                ? <ul>{impact.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
                : <p>模型没有列出额外限制。</p>}
            </section>
          </>
        )}
      </article>
    </main>
  );
}
