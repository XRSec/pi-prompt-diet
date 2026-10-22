# 🥗 pi-prompt-diet (提示词军师 & 任务契约中枢)

> **从单纯的提示词去脂，升级为 AI Agent 的前置消息整理、任务行为契约（Task Contract）与动态能力调度中枢**  
> *Next-generation Pre-flight Intent Analysis, Task Contract Architecture, Prompt Cache Protection, and Dynamic Soft Routing for [Pi Coding Agent](https://github.com/earendil-works/pi).*

[English Documentation](#english) | [中文说明](#中文说明) | [Pi 扩展开发与调试指南 (反重力 IDE 专用)](#pi-debug-guide)

---

<a name="english"></a>

## 🇬🇧 English Documentation

### 🚀 The Evolution: Beyond Token Trimming

Initially, `pi-prompt-diet` was conceived as a context slimmer to prevent guideline bloat. However, in real-world multi-turn agent operations, a deeper bottleneck emerged:
> **Most coding agents act like headless chickens**—misinterpreting colloquial commands, hallucinating user typos into code changes, over-engineering read-only queries with rogue file edits, and polluting context windows with thousands of tokens of historical tool logs.

Unless users rely on ultra-expensive flagship models at 20x pricing tiers, mainstream models quickly lose alignment across long multi-turn sessions.

Today, `pi-prompt-diet` has evolved into a full-fledged **Pre-flight Task Contract Architect & Capability Dispatcher**. It acts as an intelligent triage gateway between the human user and the primary agent model.

---

### 💡 Core Architecture & The Pre-flight Control Plane

```
                         ┌──────────────────────────────────────────────┐
                         │      User Prompt & Multi-turn History        │
                         │  (Elastic History Depth + Nowledge Mem Bundle)│
                         └──────────────────────┬───────────────────────┘
                                                │
                     Pre-flight Task Contract   │ (cpa/gemini-3.5-flash-lite / Haiku)
                     Intent Analysis (< 400ms)  ▼
                         ┌──────────────────────────────────────────────┐
                         │   1. Task Contract & Disambiguation Engine   │
                         │   • Intent: analytical / execution / composite│
                         │   • allow_write: strict permission barrier    │
                         │   • clarified_intent: normalized user goal   │
                         │   • typo_corrections: auto-heals slips        │
                         │   • protected_terms: domain jargon defense   │
                         │   • focus_tools & focus_skills: soft routing │
                         └──────────────────────┬───────────────────────┘
                                                │
                     Zero-Cache-Cost Injection  │ <system_directive> tag
                                                ▼
                         ┌──────────────────────────────────────────────┐
                         │   2. User Message Decoration                 │
                         │   • Injected strictly at top of User message │
                         │   • System Prompt remains 100% static        │
                         │   • Historical tool output scrubbing         │
                         └──────────────────────┬───────────────────────┘
                                                │
                                                ▼
                         ┌──────────────────────────────────────────────┐
                         │   3. Main LLM (Gemini 3.8 / Claude 3.7 / ...)│
                         │   • 95% - 99% Prompt Cache Hit Rate          │
                         │   • Clear operational boundaries (No rogue   │
                         │     file edits on read-only tasks)           │
                         │   • High-focus tool & skill attention        │
                         │   • On-demand dynamic lazy dispatching       │
                         └──────────────────────────────────────────────┘
```

---

### ✨ Key Features

#### 1. Elastic Multi-Turn Context & Disambiguation
* **Elastic History Window**: Dynamically extracts 4 to 6 recent messages (2~3 turns) balanced against current prompt length to resolve pronouns, ellipsis, and contextual drift.
* **Nowledge Mem Bundle Integration**: Automatically pulls persistent cross-session knowledge and memory preferences into pre-flight analysis.
* **Clarified Operational Intent (`clarified_intent`)**: Transforms fragmented, colloquial, or ambiguous user inputs into a structured, executable specification in the user's native language.

#### 2. Strict Task Contract & Permission Guard (`allow_write`)
* **Analytical Tasks**: When inspecting, checking, reviewing, or asking questions ("为什么报错", "检查这个逻辑"), `allow_write` is strictly locked to `false`. The primary model is explicitly barred from making unexpected code modifications.
* **Execution Tasks**: Modification, script execution, or scraping tasks unlock write privileges deterministically.
* **Direct Script Prioritization**: Recognizes CLI script invocations (e.g. `@ego-script/run.mjs`) as black-box executions rather than code-reading requests.

#### 3. Typo Self-Healing & Domain Jargon Defense
* **Typo Corrections**: Automatically detects and heals accidental typing slips and phonetically mistyped terms before the main model sees them.
* **Protected Terms Barrier**: Identifies package names, repo identifiers, and proprietary abbreviations (e.g. `nowledge-mem`, `pi-hashline-edit-pro`), forbidding the main model from treating them as errors or misspellings.

#### 4. Absolute Prompt Cache Protection (`<system_directive>`)
* **Zero System Prompt Mutation**: Modifying the System Prompt invalidates prompt cache and drives up cost and TTFT. `pi-prompt-diet` keeps the System Prompt baseline completely static.
* **User-Side Directive Injection**: Injects routing contracts and capability guidance cleanly inside `<system_directive>...</system_directive>` prefixes at the very top of the user turn during the `context` lifecycle event.

#### 5. Historical Tool Output Scrubbing
* Automatically scrubs past large file reads, long command outputs, and bloated diffs in long multi-turn sessions down to concise summaries, freeing up thousands of tokens of attention for the active task.

#### 6. Resilient 0ms Bypass & Fail-Open
* **Zero-Latency Bypass**: Common affirmations and continuation words (`好的`, `continue`, `go ahead`) bypass pre-flight API calls entirely.
* **Fail-Open Fallback**: Network hiccups, timeouts, or authentication errors automatically release all capabilities, preventing execution deadlocks.

---

<a name="中文说明"></a>

## 🇨🇳 中文说明

### 🚀 架构跃迁：从“提示词去脂”到“意图契约与软路由中枢”

在最初的设计中，`pi-prompt-diet` 主要用于精简 Pi 扩展累加的庞大 Guidelines，为系统提示词“去脂”。但在高强度的多轮工程实战中，我们发现 Agent 体验的最大杀手往往不是 Token 多了几千，而是：
> **主模型像无头苍蝇一样乱撞——理解错口语意图、把用户手滑打的错别字当真、在只读巡检任务中私自乱改源文件，并在多轮交互中被巨型的历史工具输出严重稀释注意力。**

除非使用极其昂贵、拥有超大思维链的顶级主力模型，否则中轻量模型极易在多轮交互中翻车失焦。

因此，现在的 `pi-prompt-diet` 已经全面升级为 **AI Agent 的前置消息整理、任务契约（Task Contract）架构与动态能力调度中枢**。在用户的输入到达昂贵的主模型之前，由轻量极速模型完成“分诊打标、错字自愈、意图清洗、能力分拣与权限锁死”。

---

### 💡 核心运转机制与流水线

#### 1. 弹性多轮上下文感知与意图重整 (Elastic History & Disambiguation)
* **弹性多轮感知**：根据当前用户输入的长度，自适应提取最近 **4~6 条消息（2~3 轮会话）**，配合头尾截取算法（保留头部初始意图与尾部最新报错/补充），彻底消除代词指代歧义（如“刚才那个报错怎么修”）。
* **Nowledge Mem 记忆联动**：自动感知系统提示词中的 `Nowledge Mem Context Bundle`，当检测到“再次/复现/重跑/像上次一样”等需求时，自动激活记忆检索工具。
* **意图规范化提炼 (`clarified_intent`)**：将用户随意、口语化甚至省略主干的消息，规范翻译为机器可精准执行的标准操作需求。

#### 2. 任务契约与权限锁死 (`Task Contract & allow_write`)
系统为每一轮交互建立严格的任务行为契约：
* **`analytical`（纯分析/只读）**：用户只是“看代码”、“查 bug”、“为什么报错”时，权限强行锁死为 **`allow_write: false`**。严禁主模型越权修改任何业务源码！
* **`execution`（执行任务）**：涉及改代码、跑脚本、爬取数据时，才放行写权限。
* **脚本黑盒直通**：识别 `@ego-script/xxx.mjs` 等脚本调用语法，指示模型直接黑盒运行，禁止盲目通读百行源码。

#### 3. 错别字自愈与领域专有名词保护 (`typo_corrections` & `protected_terms`)
* **错别字自动纠偏**：识别并修正用户手滑敲错的词（如把 `dcoment` 纠正为 `document`）。
* **专有术语隔离防护**：自动提取专属包名、代码标识符（如 `nowledge-mem`、`pi-hashline-edit-pro`、自定义类名），打上保护标记，**严令主模型绝不允许将其视为错别字**。

#### 4. 零成本 Prompt Cache 软注入 (`<system_directive>`)
* **拒绝击穿 Prompt Cache**：坚决不在会话中动态改写 System Prompt，确保吃满大模型 **95% ~ 99% 的系统级缓存折扣**，大幅压降延迟与费用。
* **User 顶部无感软引导**：在 `context` 生命周期中，将任务契约以 `<system_directive>` 标签直接注入在当轮用户消息的最上方，以极小成本指引主模型注意力。

#### 5. 历史工具结果智能脱水 (Historical Tool Scrubbing)
在长会话中，历史工具产生的大段日志、全文读取和巨型 diff 会持续占满注意力。插件在 `context` 阶段对历史轮次的工具输出执行脱水压缩（仅保留头尾摘要），释放数千字符的干净上下文。

#### 6. 0ms 旁路直通与 Fail-Open 容灾
* **纯确认词 0ms 旁路**：对 `好的`、`继续`、`continue` 等词跳过分析模型调用，0 延迟直出；
* **Fail-Open 熔断保障**：预检模型遇网络抖动或超时时，自动全量放行工具与 Skill，确保开发流程永不中断。

---

### 🏛️ 生产级作战角色分工矩阵

在现代 Agent 协同体系中，`pi-prompt-diet` 作为核心前哨，与主力模型及其他插件协同运转：

| 角色 / 节点 | 载体 | 推荐模型 | 核心职责 |
| :--- | :--- | :--- | :--- |
| **Commander (指挥官)** | **User** | 人类工程师 | 提出业务需求、确认方案、做关键决策与最终验收。 |
| **Preflight Router (前哨分诊军师)** | **`pi-prompt-diet`** | `cpa/gemini-3.5-flash-lite` / `Haiku` | **前置意图重整、任务契约制定、错字修正、权限约束与能力软路由。** |
| **Main Engine (主力工匠)** | **Main Model** | `gemini-3.8-flash` / `Claude 3.7` | 接收规范契约，在安全的权限和精准工具聚焦下专注高质量编码交付。 |
| **Supervisor (纪律守卫)** | [**`pi-general`**](file:///Users/xr/.pi/agent/extensions/pi-general) | 状态机 + `gemini-3.8-flash` | 会话中连击熔断、只读探查限制与动作后验证闭环守卫。 |
| **Specialized Subagents** | **`pi-subagents`** | `worker` / `reviewer` / `oracle` | 复杂任务拆分、代码审查与高阶架构推演。 |

---

### ⚙️ 配置文件说明 (`pi-prompt-diet.json`)

配置文件支持全局路径 `~/.pi/agent/pi-prompt-diet.json` 或项目级 `.pi/pi-prompt-diet.json`：

```json
{
  "$schema": "https://raw.githubusercontent.com/XRSec/pi-prompt-diet/main/schema.json",
  "enabled": true,
  "guidelines": {
    "mode": "slim"
  },
  "skills": {
    "mode": "compress",
    "maxDescriptionLength": 200
  },
  "adaptive": {
    "enabled": true,
    "softRouting": true,
    "preflightModel": "cpa/gemini-3.5-flash-lite",
    "distillSkills": true,
    "distillToolGuidelines": true
  },
  "packages": []
}
```

---

<a name="pi-debug-guide"></a>

## 🛠️ Pi 扩展开发与调试指南 (反重力 IDE 专用)

在反重力 IDE (Antigravity) 或本地终端进行插件二次开发时：

```bash
# 1. 快速命令行单次验证
pi -p "帮我查看一下当前的 git 状态"

# 2. 临时加载本地扩展进行测试
pi -e ./index.ts -p "测试前置契约与软路由"

# 3. 运行自动化单元测试套件 (覆盖 Task Contract、Fail-Open、Head-Tail 截取)
npm test
```

---

## 📄 License

MIT License © 2026 [XRSec](https://github.com/XRSec)
