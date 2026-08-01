"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type LocalData = {
  storage: { engine: string; localDirectory: string; committedToGit: boolean; note: string };
  registry: {
    total: number;
    lastRefreshAt: string | null;
    sourceUpdatedAt: string | null;
    types: Array<{ securityType: string; total: number }>;
  };
  profiles: Array<{
    id: string;
    ticker: string;
    companyName: string;
    updatedAt: string;
    lastReviewedAt: string;
    facts: Array<{
      id: string;
      category: string;
      factKey: string;
      value: string;
      status: "verified" | "unverified";
      sourceType: string;
      sourceUrl: string | null;
      evidenceText: string;
      lastVerificationDate: string;
    }>;
    health: { complete: boolean; stale: boolean; missingCategories: string[]; conflicts: unknown[] };
  }>;
  fundProfiles: Array<{
    id: string;
    ticker: string;
    fundName: string;
    issuerName: string | null;
    securityType: "etf" | "closed_end_fund";
    structure: {
      leverageMultiplier: number | null;
      inverse: boolean | null;
      dailyReset: boolean | null;
      coveredCall: boolean | null;
      activelyManaged: boolean | null;
    };
    facts: Array<{
      id: string;
      category: string;
      factKey: string;
      value: string;
      status: "verified" | "unverified";
      sourceType: string;
      sourceUrl: string | null;
      evidenceText: string;
      effectiveDate: string | null;
      lastVerificationDate: string;
    }>;
    holdings: Array<{
      id: string;
      constituentTicker: string | null;
      constituentName: string;
      weightPercent: number | null;
      country: string | null;
      sector: string | null;
      currency: string | null;
      status: "verified" | "unverified";
      sourceUrl: string | null;
      evidenceText: string;
      effectiveDate: string;
      lastVerificationDate: string;
    }>;
    health: {
      complete: boolean;
      stale: boolean;
      missingCategories: string[];
      missingExposure: boolean;
      missingNature: boolean;
      missingStructureFields: string[];
      factConflicts: unknown[];
      holdingConflicts: unknown[];
    };
  }>;
};

type ClearResult = {
  deleted: {
    companyProfiles: number;
    companyFacts: number;
    fundProfiles: number;
    fundFacts: number;
    fundHoldings: number;
  };
  preserved: string[];
  message: string;
};

const typeLabels: Record<string, string> = {
  stock: "普通股票",
  adr: "美国存托凭证",
  reit: "房地产投资信托",
  etf: "交易所买卖基金",
  preferred: "优先股",
  closed_end_fund: "封闭式基金",
  other: "其他",
};

async function fetchLocalData() {
  const response = await fetch("/api/local-data", { cache: "no-store" });
  const body = await response.json() as LocalData | { error?: string };
  if (!response.ok || "error" in body) throw new Error("error" in body && body.error ? body.error : "读取本地数据库失败。");
  return body as LocalData;
}

export default function LocalDataPage() {
  const [data, setData] = useState<LocalData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);
  const [clearMessage, setClearMessage] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      setData(await fetchLocalData());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "读取本地数据库失败。");
    } finally {
      setLoading(false);
    }
  }

  async function clearProfiles() {
    const confirmed = window.confirm(
      "确定要删除所有公司与 ETF/基金研究档案吗？\n\n公司事实、基金事实和基金持仓都会删除。美股证券目录会保留。",
    );
    if (!confirmed) return;
    setClearing(true);
    setError("");
    setClearMessage("");
    try {
      const response = await fetch("/api/local-data", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: "researched_profiles",
          confirmation: "CLEAR_RESEARCHED_PROFILES",
        }),
      });
      const body = await response.json() as ClearResult | { error?: string };
      if (!response.ok || "error" in body) {
        throw new Error("error" in body && body.error ? body.error : "清除本地研究资料失败。");
      }
      const deleted = (body as ClearResult).deleted;
      setClearMessage(
        `已删除 ${deleted.companyProfiles} 家公司档案、${deleted.fundProfiles} 个基金档案、`
        + `${deleted.companyFacts + deleted.fundFacts} 条事实及 ${deleted.fundHoldings} 条基金持仓。美股证券目录已保留。`,
      );
      setData(await fetchLocalData());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "清除本地研究资料失败。");
    } finally {
      setClearing(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void fetchLocalData().then((body) => {
      if (!cancelled) setData(body);
    }).catch((caught) => {
      if (!cancelled) setError(caught instanceof Error ? caught.message : "读取本地数据库失败。");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <main className="database-page">
      <header className="topbar">
        <Link className="brand database-brand" href="/">
          <span className="brand-mark">PN</span>
          <div><strong>本地数据库</strong><span>公司、基金档案与美股证券目录</span></div>
        </Link>
        <nav className="topbar-actions"><Link href="/">返回工作流程</Link><div className="status-pill"><span /> 仅保存在本机</div></nav>
      </header>

      <section className="database-hero">
        <div className="eyebrow">本地数据</div>
        <h1>看看系统实际保存了什么。</h1>
        <p>这里显示公司与基金的研究事实、持仓及证据，也显示从 Nasdaq 官方目录缓存的美股证券身份。它不会显示或保存你的 Tavily 或金十访问令牌。</p>
        <div className="database-actions">
          <button type="button" onClick={() => void load()} disabled={loading || clearing}>{loading ? "读取中…" : "重新读取"}</button>
          <button type="button" className="danger-button" onClick={() => void clearProfiles()} disabled={loading || clearing}>
            {clearing ? "清除中…" : "清除公司与基金资料"}
          </button>
        </div>
        {clearMessage ? <div className="success-message" role="status">{clearMessage}</div> : null}
        {error ? <div className="error-message" role="alert">{error}</div> : null}
      </section>

      {data ? <>
        <section className="database-summary four">
          <article>
            <span>存储引擎</span><strong>{data.storage.engine}</strong>
            <code>{data.storage.localDirectory}</code>
            <p>{data.storage.note} 是否写入版本记录：{data.storage.committedToGit ? "会" : "不会"}。</p>
          </article>
          <article>
            <span>美股证券身份</span><strong>{data.registry.total.toLocaleString()} 条</strong>
            <p>上次刷新：{data.registry.lastRefreshAt ? new Date(data.registry.lastRefreshAt).toLocaleString() : "尚未下载"}</p>
            <p>来源时间：{data.registry.sourceUpdatedAt ? new Date(data.registry.sourceUpdatedAt).toLocaleString() : "—"}</p>
          </article>
          <article>
            <span>公司档案</span><strong>{data.profiles.length} 家</strong>
            <p>{data.profiles.reduce((total, profile) => total + profile.facts.length, 0)} 条事实，包括已验证与未验证建议。</p>
          </article>
          <article>
            <span>交易所买卖基金 / 基金档案</span><strong>{data.fundProfiles.length} 只</strong>
            <p>{data.fundProfiles.reduce((total, profile) => total + profile.facts.length, 0)} 条事实，{data.fundProfiles.reduce((total, profile) => total + profile.holdings.length, 0)} 条带日期持仓。</p>
          </article>
        </section>

        <section className="database-section">
          <div className="database-heading"><div><span>01</span><div><h2>美股证券目录</h2><p>用于确认股票代码、交易所和证券类型。不是公司业务证据。</p></div></div></div>
          <div className="registry-types">
            {data.registry.types.length ? data.registry.types.map((item) => (
              <div key={item.securityType}><span>{typeLabels[item.securityType] ?? item.securityType}</span><strong>{item.total.toLocaleString()}</strong></div>
            )) : <p>目录尚未下载。上传一个投资组合后，系统会进行首次缓存。</p>}
          </div>
        </section>

        <section className="database-section">
          <div className="database-heading"><div><span>02</span><div><h2>公司研究档案</h2><p>基础资料只要求行业、细分行业与主要产品/服务；其他事实作为可选补充，并保留来源、证据与验证日期。</p></div></div></div>
          {!data.profiles.length ? <div className="database-empty">还没有保存公司档案。成功运行一次公司研究后，资料会出现在这里。</div> : null}
          <div className="profile-list">
            {data.profiles.map((profile) => (
              <article className="profile-record" key={profile.id}>
                <div className="profile-record-heading">
                  <div><strong>{profile.ticker}</strong><h3>{profile.companyName}</h3></div>
                  <div className="profile-health">
                    <span>{profile.health.complete ? "基础资料可用" : "基础资料不足"}</span>
                    {profile.health.stale ? <span className="warning">需要更新</span> : null}
                    <span>{profile.facts.length} 条事实</span>
                  </div>
                </div>
                {!profile.health.complete ? <p className="missing-facts">基础资料仍缺少：{profile.health.missingCategories.join("、") || "尚未确定"}</p> : null}
                <div className="facts-table-wrap">
                  <table className="facts-table">
                    <thead><tr><th>类别 / 键</th><th>事实</th><th>状态</th><th>证据与来源</th><th>验证日期</th></tr></thead>
                    <tbody>{profile.facts.map((fact) => (
                      <tr key={fact.id}>
                        <td><strong>{fact.category}</strong><small>{fact.factKey}</small></td>
                        <td>{fact.value}</td>
                        <td><span className={`fact-status ${fact.status}`}>{fact.status === "verified" ? "已验证" : "未验证"}</span></td>
                        <td><p>{fact.evidenceText || "没有证据原文"}</p>{fact.sourceUrl ? <a href={fact.sourceUrl} target="_blank" rel="noreferrer">打开来源</a> : <small>{fact.sourceType}</small>}</td>
                        <td>{fact.lastVerificationDate}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="database-section">
          <div className="database-heading"><div><span>03</span><div><h2>交易所买卖基金与基金研究档案</h2><p>基础资料要求基金类型、策略与主要暴露。持仓是可选补充；只有反向、杠杆、每日重置或备兑产品才必须确认相关结构。</p></div></div></div>
          {!data.fundProfiles.length ? <div className="database-empty">还没有保存基金档案。上传投资组合后，自动资料准备会研究缺失的基金。</div> : null}
          <div className="profile-list">
            {data.fundProfiles.map((profile) => (
              <article className="profile-record" key={profile.id}>
                <div className="profile-record-heading">
                  <div><strong>{profile.ticker}</strong><h3>{profile.fundName}</h3></div>
                  <div className="profile-health">
                    <span>{typeLabels[profile.securityType]}</span>
                    <span>{profile.health.complete ? "基础资料可用" : "基础资料不足"}</span>
                    {profile.health.stale ? <span className="warning">需要更新</span> : null}
                    <span>{profile.facts.length} 条事实</span>
                    <span>{profile.holdings.length} 条持仓</span>
                  </div>
                </div>
                <div className="fund-structure-strip">
                  <span>发行方：<strong>{profile.issuerName || "未记录"}</strong></span>
                  <span>杠杆倍数：<strong>{profile.structure.leverageMultiplier === null ? "未确认" : `${profile.structure.leverageMultiplier}×`}</strong></span>
                  <span>{profile.structure.inverse === null ? "反向：未确认" : profile.structure.inverse ? "反向" : "非反向"}</span>
                  <span>{profile.structure.dailyReset === null ? "每日重置：未确认" : profile.structure.dailyReset ? "每日重置" : "非每日重置"}</span>
                  <span>{profile.structure.coveredCall === null ? "备兑策略：未确认" : profile.structure.coveredCall ? "备兑策略" : "非备兑策略"}</span>
                  <span>{profile.structure.activelyManaged === null ? "管理方式：未确认" : profile.structure.activelyManaged ? "主动管理" : "被动管理"}</span>
                </div>
                {!profile.health.complete ? <p className="missing-facts">
                  基础资料仍缺少：{profile.health.missingCategories.join("、") || "无类别缺失"}
                  {profile.health.missingExposure ? "；还缺少已验证的主要暴露" : ""}
                  {profile.health.missingNature ? "；还缺少基金策略或至少三项主要持仓" : ""}
                  {profile.health.missingStructureFields.length ? `；关键结构未确认：${profile.health.missingStructureFields.join("、")}` : ""}
                </p> : null}
                {profile.health.factConflicts.length || profile.health.holdingConflicts.length ? (
                  <p className="missing-facts">发现互相冲突的资料，系统已保留，等待人工检查。</p>
                ) : null}
                {profile.facts.length ? <div className="facts-table-wrap">
                  <table className="facts-table">
                    <thead><tr><th>类别 / 键</th><th>事实</th><th>状态</th><th>证据与来源</th><th>有效 / 验证日期</th></tr></thead>
                    <tbody>{profile.facts.map((fact) => (
                      <tr key={fact.id}>
                        <td><strong>{fact.category}</strong><small>{fact.factKey}</small></td>
                        <td>{fact.value}</td>
                        <td><span className={`fact-status ${fact.status}`}>{fact.status === "verified" ? "已验证" : "未验证"}</span></td>
                        <td><p>{fact.evidenceText}</p>{fact.sourceUrl ? <a href={fact.sourceUrl} target="_blank" rel="noreferrer">打开来源</a> : <small>{fact.sourceType}</small>}</td>
                        <td>{fact.effectiveDate || "当前"}<small>验证：{fact.lastVerificationDate}</small></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div> : null}
                {profile.holdings.length ? <div className="facts-table-wrap holdings-table-wrap">
                  <table className="facts-table holdings-table">
                    <thead><tr><th>成分</th><th>权重</th><th>国家 / 行业 / 货币</th><th>状态与证据</th><th>有效日期</th></tr></thead>
                    <tbody>{profile.holdings.map((holding) => (
                      <tr key={holding.id}>
                        <td><strong>{holding.constituentTicker || "—"}</strong><small>{holding.constituentName}</small></td>
                        <td>{holding.weightPercent === null ? "未提供" : `${holding.weightPercent}%`}</td>
                        <td>{[holding.country, holding.sector, holding.currency].filter(Boolean).join(" · ") || "未提供"}</td>
                        <td><span className={`fact-status ${holding.status}`}>{holding.status === "verified" ? "已验证" : "未验证"}</span><p>{holding.evidenceText}</p>{holding.sourceUrl ? <a href={holding.sourceUrl} target="_blank" rel="noreferrer">打开来源</a> : null}</td>
                        <td>{holding.effectiveDate}<small>验证：{holding.lastVerificationDate}</small></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div> : null}
              </article>
            ))}
          </div>
        </section>
      </> : null}
    </main>
  );
}
