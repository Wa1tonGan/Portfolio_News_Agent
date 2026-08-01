<div align="center">

# 📈 Portfolio News Impact Agent

**本地优先、注重隐私的多 Agent 系统：连接全球实时财经新闻与股票/ETF投资组合**

[English](README.md) | [简体中文](README_CN.md)

[![Next.js](https://img.shields.io/badge/Next.js-16-black?style=for-the-badge&logo=nextdotjs)](https://nextjs.org/)
[![LangGraph](https://img.shields.io/badge/LangGraph-1.4-blue?style=for-the-badge&logo=langchain)](https://js.langchain.com/docs/langgraph)
[![Ollama](https://img.shields.io/badge/Ollama-Local_AI-FF6F00?style=for-the-badge&logo=ollama)](https://ollama.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?style=for-the-badge&logo=typescript)](https://www.typescriptlang.org/)
[![Cloudflare D1](https://img.shields.io/badge/Cloudflare_D1-SQLite-F38020?style=for-the-badge&logo=cloudflare)](https://developers.cloudflare.com/d1/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

*在 100% 数据隐私保护、零幻觉证据防护与确定性因果推理下，分析实时市场新闻对您个人投资组合的影响。*

[核心特性](#-核心特性) • [Agent 架构与工作流](#-agent-架构与工作流) • [快速开始指南](#-快速开始指南) • [环境变量配置](#%EF%B8%8F-环境变量配置) • [本地数据检查器](#-本地数据检查器) • [隐私与安全说明](#-隐私与安全说明)

⭐ **如果这个项目对您有所帮助或启发，请在 GitHub 上点个 Star！**

---

</div>

## ✨ 核心特性

- 🔒 **100% 本地优先与隐私保护**：您的持仓数据、上传的 CSV/XLSX 文件及 AI 分析 Prompt **绝不离开您的本地机器**。
- 🤖 **多 Agent 协作架构**：
  - **公司研究 Agent (Company Research Agent)**：自动探索股票、ADR 及 REITs 的公司 profile、商业模式与行业暴露。
  - **基金研究 Agent (Fund Research Agent)**：解析 ETF 与封闭式基金的投资策略、基准指数、宏观暴露、每日重置/杠杆机制及带日期的持仓明细。
  - **13 节点 LangGraph 编排器**：统一管理实时新闻拉取、微观/宏观筛选、公平配对与因果影响评估。
- 📡 **Jin10 MCP 协议集成**：基于官方 **Model Context Protocol (MCP)** 规范 (`2025-11-25`)，实时流式获取金十财经快讯、深度新闻与经济日历事件。
- 🛡️ **零幻觉证据引擎 (Zero-Hallucination Evidence Engine)**：仅在抓取的网页原文与 Cloudflare D1 本地 SQLite 中存储的不可变段落 ID 精确匹配时，才将事实标记为已验证。模型记忆断言明确标记为未验证。
- 🧠 **本地 LLM 结构化输出**：运行于本地 **Ollama (Qwen 3.5 4B)**，具备严格 JSON Schema 校验与 1 次自动修复机制。
- 🏛️ **纳斯达克交易所代码校验**：基于每日 Nasdaq/Other-Exchange 目录缓存校验持仓代码，确保仅处理合规的美股标的。
- 📊 **动态微观与宏观影响评分**：分别评估微观（公司特定）与宏观（利率、供应链、通胀）影响，并实施基于证据强度的置信度上限（Headline: 55%, Flash: 65%, Full Article: 85%）。
- 🔎 **本地数据检查器 (Mandarin Data Inspector)**：包含 `/local-data` 交互式数据检查页面，方便随时审计存储的公司事实、基金持仓、证据原文与来源 URL。

---

## 🏗️ Agent 架构与工作流

```mermaid
flowchart TD
    subgraph Browser ["🌐 前端层 (Next.js 16 / React 19)"]
        A[上传持仓 CSV / XLSX] --> B[纳斯达克每日目录校验器]
    end

    subgraph DataPrep ["📦 自主 Profile 准备层"]
        B --> C{Profile 已存在于本地 D1 DB?}
        C -- 是 --> E[进入 LangGraph 影响评估管道]
        C -- 否 --> D1[Alpha Vantage API OVERVIEW / ETF_PROFILE]
        D1 -- 数据不完整 / 缺失 --> D2[公司 / 基金研究 Agent]
        D2 --> D3[Tavily 搜索与网页抽取 API]
        D3 --> D4[校验文本段落并存入 D1 SQLite]
        D4 --> E
    end

    subgraph LangGraph ["⚡ 13-节点 LangGraph 影响评估编排器"]
        E --> F1[Jin10 MCP 客户端实时拉取]
        F1 --> F2[微观与宏观主题筛选节点]
        F2 --> F3[公平配对与深度文章拉取]
        F3 --> F4[因果推理与持仓影响评估节点]
        F4 --> F5[基于证据强度的置信度打分]
    end

    subgraph Output ["📊 仪表盘与本地数据审计"]
        F5 --> G1[交互式新闻影响仪表盘]
        F5 --> G2[/local-data 本地数据检查器]
    end
```

---

## ⚙️ 快速开始指南

跟随以下步骤，几分钟内即可在本地完成环境搭建与运行。

### 📋 前置要求 (Prerequisites)

1. **Node.js**：版本 `22.13.0` 或更高。
2. **Ollama**：已安装并在本地运行 ([下载 Ollama](https://ollama.com/))。
3. **API Keys**（均支持免费额度）：
   - **Jin10 MCP Token**：金十实时财经新闻 API Token。
   - **Alpha Vantage Key**：结构化公司与 ETF 概况查询（免费额度：每日 25 次）。
   - **Tavily API Key**：受控网页搜索与文本提取（用于兜底研究 Agent）。

---

### 🚀 逐步安装说明

#### 1. 克隆 GitHub 仓库
```bash
git clone https://github.com/YOUR_USERNAME/Portfolio-News-Impact-Agent.git
cd Portfolio-News-Impact-Agent
```

#### 2. 安装项目依赖
```bash
npm install
```

#### 3. 拉取本地 AI 模型
确保 Ollama 已在后台运行，然后拉取模型：
```bash
ollama pull qwen2.5:3b # 或 qwen3.5:4b（取决于您的本地模型标签）
```
*注：系统默认连接至本地 Ollama 服务 `http://127.0.0.1:11434`。*

#### 4. 配置环境变量
复制示例环境变量文件：
```bash
cp .env.example .env.local
```
打开 `.env.local` 并填入您的私有 API Key：
```env
JIN10_MCP_TOKEN=your_jin10_mcp_token_here
ALPHA_VANTAGE_API_KEY=your_alpha_vantage_api_key_here
TAVILY_API_KEY=your_tavily_api_key_here
```

#### 5. 启动本地开发服务器
```bash
npm run dev
```

#### 6. 访问应用
在浏览器中打开：
- **主分析仪表盘**：`http://localhost:3000`
- **本地数据检查器**：`http://localhost:3000/local-data`

---

## 💡 如何测试 Agent 功能

1. **上传持仓文件**：
   - 您可以上传自己的 CSV/XLSX 持仓文件，或使用项目自带的示例文件 `public/sample-portfolio.csv`。
   - 支持券商导出字段，如 `Symbol`、`Market Value` 或 `% of Portfolio`。

2. **自动 Profile 生成**：
   - 上传后，系统会自动检索本地 D1 数据库。
   - 未缓存的新股票/ETF 将自动通过 Alpha Vantage 查询；若 API 未覆盖，将触发 Tavily + 本地 Qwen 3.5 兜底研究 Agent。

3. **运行新闻影响评估**：
   - 13 节点 LangGraph 管道实时获取金十快讯，评估微观新闻对标的的影响及宏观趋势对行业的影响，并在仪表盘展示完整因果推理链。

4. **审计本地数据库**：
   - 访问 `http://localhost:3000/local-data`，查看缓存的交易所目录、已验证的公司事实、基金重仓股及原始证据段落。

---

## ⚙️ 环境变量说明

| 变量名 | 说明 | 是否必填 | 默认值 / 备注 |
| :--- | :--- | :---: | :--- |
| `JIN10_MCP_TOKEN` | 金十 MCP 新闻客户端 Token | 是 | 私有 API Token |
| `ALPHA_VANTAGE_API_KEY` | Alpha Vantage 概况与 ETF 接口 Key | 是 | 免费额度（每天 25 次） |
| `TAVILY_API_KEY` | Tavily 搜索与网页文本提取 Key | 是 | 受控研究 Agent 兜底 |
| `OLLAMA_HOST` | 本地 Ollama 服务地址 | 否 | `http://127.0.0.1:11434` |

---

## 🔍 本地数据检查器 (Local Data Inspector)

本项目在 `/local-data` 路径下内置了交互式本地数据审计工具，支持审计：
- **美股代码注册表 (US Security Registry)**：纳斯达克及其他交易所代码校验状态。
- **公司 Profile (Company Profiles)**：存储的商业模式、行业标签与已验证事实。
- **基金 Profile (Fund Profiles)**：ETF 基准指数、杠杆/反向标记及带日期的前大持仓。
- **证据保险库 (Evidence Vault)**：精确证据段落文本、验证日期、来源 URL 及验证状态（`verified` 已验证、`conflicted` 存在冲突、`unverified` 未验证）。

---

## 🛡️ 隐私与安全说明

- 🔒 **100% 本地与个人化**：定位为个人本地研究助手。
- 🛑 **无自动交易功能**：工具仅提供信息性质的新闻影响评估，**不进行任何实际下单或券商交易对接**。
- 🛡️ **数据零泄露**：持仓文件、持仓权重与 LLM 分析 Prompt 严格保留在您的本地机器上，绝不上传至任何第三方云服务。

---

## 🤝 贡献与点赞支持

欢迎提交 Issue 或 Pull Request！

如果您觉得这个项目对您的多 Agent 架构或本地 AI 开发有所启发，欢迎点一个 **⭐ Star** 支持一下！

---

## 📄 开源协议

本项目基于 [MIT License](LICENSE) 开源。
