# 🥗 pi-prompt-diet

> **Pi Coding Agent 的轻量前置意图预检、任务契约与 Prompt Cache 保护扩展**  
> *Deterministic Capability Routing, Pre-flight Task Contracts, Prompt Cache Protection & Tool Result Scrubbing for [Pi Coding Agent](https://github.com/earendil-works/pi).*

[English Documentation](#english) | [中文说明](#中文说明) | [配置与架构细节](#configuration--internals) | [开发与测试](#development--testing)

---

<a name="english"></a>

## 🇬🇧 English Documentation

### ⚡ Why `pi-prompt-diet`?

As coding assistants handle increasingly complex, multi-turn development workflows, standard setups suffer from four core failure modes:
1. **Rogue File Mutations on Analytical Queries**: When asked to investigate, review, or explain ("why does this test fail?"), agents frequently jump straight into editing files unprompted.
2. **Context Bloat & Token Waste**: Linear accumulation of third-party `promptGuidelines`, uncalled `SKILL.md` documents, and framework documentation can consume **5,000+ baseline tokens** before the user types a single word.
3. **KV Cache Busting**: Dynamically altering the System Prompt on each turn invalidates modern LLM Prompt Caches, forfeiting 95%+ pricing discounts and increasing Time To First Token (TTFT).
4. **Context Dilution from Historical Tool Dumps**: Giant historical outputs (file read dumps, 500-line diffs, build logs) from 5 turns ago linger in messages, drowning the model's active attention.

`pi-prompt-diet` is a **deterministic, zero-overhead pre-flight control plane** that solves these issues before the primary LLM runs.

---

### 💡 Execution Pipeline & Architecture

```
User Prompt (with Elastic History + Nowledge Mem Context)
                        │
                        ▼ (Affirmative check: 0ms bypass for "continue", "好的", "ok go")
        ┌───────────────────────────────┐
        │ 1. Pre-flight Intent Analysis │  Model: CPA/gemini-3.5-flash-lite
        │    • TaskContract Resolution  │  thinkingLevel: off, maxTokens: 800
        └───────────────┬───────────────┘
                        │
                        ▼ (before_agent_start)
        ┌───────────────────────────────┐
        │ 2. Context & Tool Slimming    │
        │    • Physical tool activation │  Active tools + call_tool + request_capabilities
        │    • Pi bash guideline scrub  │  Strips conflicting "Use bash for file operations"
        │    • Framework docs on-demand │  Removes <docs> unless explicitly requested
        │    • Inactive tools as list   │  Retains names only for 1-turn call_tool access
        └───────────────┬───────────────┘
                        │
                        ▼ (context hook: User Message Injection)
        ┌───────────────────────────────┐
        │ 3. Message Transformation     │
        │    • <system_directive> tag   │  Injected at top of LAST User message (0 Cache Miss)
        │    • Tool Result Scrubbing    │  Chunk-aligned (step=6) Head/Tail scrubbing
        │    • UI Card Isolation        │  Scrubs custom diet cards (0 Token leak to LLM)
        └───────────────┬───────────────┘
                        │
                        ▼ (before_provider_request)
        ┌───────────────────────────────┐
        │ 4. Cache Key & Order Guard    │
        │    • prompt_cache_key (SHA256)│  Prevents KV Cache misses on reverse proxy gateways
        │    • Canonical Tool Order     │  Enforces deterministic tool definitions order
        └───────────────┬───────────────┘
                        │
                        ▼
             Primary Agent LLM Run
                        │
                        ▼ (tool_result & agent_settled)
        ┌───────────────────────────────┐
        │ 5. Asynchronous Distillation  │
        │    • Content-Addressed Skills │  ~/.pi/agent/cache/pi-prompt-diet/skills/${sha256}.json
        │    • CAS Tool Guidelines      │  ~/.pi/agent/cache/pi-prompt-diet/tools/${sha256}.json
        └───────────────────────────────┘
```

---

### 🛠️ Core Capabilities

#### 1. Pre-flight Task Contracts (`TaskContract`)
A lightweight model (`gemini-3.5-flash-lite` with `thinkingLevel: "off"`) parses the request, multi-turn history, and persistent memory in milliseconds into a structured contract:
* **Strict Permission Lock (`allow_write`)**:
  * `analytical`: In inspection, inquiry, bug analysis, or code review tasks, `allow_write` is strictly locked to `false`. The primary LLM is physically instructed not to touch source files.
  * `execution`: File modifications and script executions are permitted.
  * *Priority Verb Rule*: When both execution verbs ("run/fetch") and analytical verbs ("analyze/review") appear, the first action verb determines the primary intent.
  * *Script Invocation Rule*: Any invocation referencing scripts (e.g. `@ego-script/...` or `node xxx.mjs`) is treated as black-box `execution`—full file reads of the script are prohibited.
* **Clarified User Intent (`clarified_intent`)**: Normalizes ambiguous, colloquial, or ellipsis-heavy inputs into clear, executable statements.
* **Typo Self-Healing & Protected Terms**:
  * Corrects typos (`typo_corrections`) before the main model sees them.
  * Extracts custom package names, variables, and repo identifiers as `protected_terms` to ensure the model never treats them as misspellings.

#### 2. Absolute Prompt Cache Protection
* **System Prompt Remains 100% Static**: `pi-prompt-diet` never mutates the base system prompt on a per-turn basis.
* **`<system_directive>` User-Side Injection**: Task contracts and soft-routing hints are injected strictly into the incoming turn's user message during the `context` event.
* **Deterministic Tool Ordering & Cache Keys**: Enforces `CANONICAL_TOOL_ORDER` and injects `prompt_cache_key: "pi-${sha256}"` in `before_provider_request`, avoiding KV Cache invalidation across reverse proxy gateways (OneAPI, NewAPI, CPA).

#### 3. Single-Turn Lazy Tool Execution (`call_tool`)
* Inactive tools are stripped of lengthy descriptions and listed by name at the bottom of the prompt.
* If needed, the model can execute any inactive tool in a **single turn** using `call_tool(tool, parameters)`.
* Fully supports both standard executable tools and metadata-only tools without runtime `TypeError`s.

#### 4. Historical Tool Result Scrubbing
* Scrubbing applies in the `context` hook to non-error tool results exceeding `maxChars` (default `1200`).
* **Step-Aligned Boundary (`stepBlock = 6`)**: The scrubbing boundary advances only in blocks of 6 messages, keeping the historical prefix completely static to preserve KV Cache hits.
* **Head/Tail Truncation**: Retains the first 6 lines and last 2 lines (or 600/200 chars for long lines), replacing the middle with a descriptive notice. Errors (`isError: true`) are never scrubbed.

#### 5. Content-Addressed CAS Distillation
* **Skill Capsules**: Reads of `SKILL.md` are intercepted; when the agent settles, a direct model call distills the file into a concise capsule (trigger, essential rules ≤ 4, read conditions).
* **Tool Guidelines**: Third-party guidelines are asynchronously evaluated; if concise rules do not yield token savings, the system safely falls back to `full` mode.
* **Compare-And-Swap (CAS)**: Atomic writes (`writeJsonAtomic`) with file fingerprint checks prevent concurrent overwrites.

---

<a name="中文说明"></a>

## 🇨🇳 中文说明

### ⚡ 核心解决痛点

在日常使用 Pi 进行多轮复杂编码时，常见问题如下：
1. **只读巡检任务中私自乱改文件**：用户只是问一句“看看这行为什么报错”或“检查一下逻辑”，模型直接自作主张修改业务源码；
2. **提示词无节制膨胀与缓存失效**：第三方插件的 Rules、未调用的 Skills 全量注入，导致基线提示词轻易超过 **5,000+ Tokens**；动态修改 System Prompt 还会击穿大模型的 Prompt Cache 缓存，导致响应变慢、费用暴增；
3. **手滑错字误导与冷门术语误伤**：用户输错一个字母，模型展开错误脑补；用户提到自定义包名（如 `nowledge-mem`），模型自作聪明去给它“纠错”；
4. **历史大工具垃圾稀释注意力**：几轮之前的巨型日志、diff、大文件全文堆积在会话中，冲散模型对当前任务的注意力。

`pi-prompt-diet` 是一个**轻量、确定性、高可用的前置控制面**，在消息交给主模型之前完成意图分诊、权限硬锁与提示词去脂。

---

### 💡 核心机制与实现细节

#### 1. 前置意图分析与任务行为契约 (`TaskContract`)
在 `before_agent_start` 阶段，调用轻量模型（默认 `CPA/gemini-3.5-flash-lite`，关闭思考 `thinkingLevel: "off"`）毫秒级生成严格契约：
* **只读权限硬锁 (`allow_write`)**：
  * **`analytical`（只读分析）**：当用户只是检查、review、排查报错、阅读代码时，权限硬锁死为 **`allow_write: false`**。主模型被物理约束严禁修改业务代码；
  * **`execution`（执行修改）**：明确要求修改代码、运行脚本、爬取数据时方放行写权限；
  * **首动词优先级（Priority Rule）**：遇到“获取数据然后分析”，以第一个动作动词为准判定为 `execution`；
  * **脚本黑盒直通**：检测到 `@ego-script/...` 或 `node xxx.mjs`，强制判为黑盒执行，禁止模型全量读取脚本源码。
* **意图规范化提炼 (`clarified_intent`)**：结合弹性历史深度（4~6 条消息）与 `Nowledge Mem Context Bundle`，将省略主语、口语化的需求重整为标准指令。
* **错别字修复与专有术语护盾 (`protected_terms`)**：
  * 自动修复拼写手滑（`typo_corrections`）；
  * 提取专用包名、代码标识符作为 `protected_terms`，**严令主模型绝不可当成错别字处理**。

#### 2. Prompt Cache 绝对保护与零成本注入
* **静态 System Prompt 基线**：严禁在每回合动态重写系统提示词，确保持续命中大模型 95%~99% 的 Prompt Cache；
* **`<system_directive>` 注入在 User 顶部**：在 `context` 事件中，将任务契约与路由指引挂载在当轮用户输入的最前端：
  ```xml
  <system_directive>
  Preflight route: focus on tools: [read, edit]. [Task Contract: ANALYTICAL | READ-ONLY (NO WRITES)] Clarified user intent: "分析为何发生空指针异常" Protected terms: [nowledge-mem]
  </system_directive>

  用户原始提问...
  ```
* **确定性工具排序与 Cache Key**：在 `before_provider_request` 中补齐 `prompt_cache_key: "pi-${sha256}"` 并执行 `CANONICAL_TOOL_ORDER` 排序，杜绝反代网关层因顺序变动引发 KV Cache 穿透。

#### 3. 单轮即时调用元工具 (`call_tool`)
* 未被路由命中的工具在提示词末尾仅以名称列表展示，释放数千 Token；
* 主模型若在执行中临时需要未激活工具，可直接调用 `call_tool(tool, parameters)` 在**单轮内即时执行返回**，彻底免去传统方案需要两轮回合激活的延迟；
* 针对无 `execute` 实现的纯元数据工具（如 `lens_diagnostics`）内置安全兼容逻辑，杜绝抛出 `TypeError`。

#### 4. 历史工具结果阶梯脱水 (Tool Result Scrubbing)
* 在 `context` 阶段对超出保护窗口（`keepRecentTurns: 2`，至少 6 条最新消息）且长度超过 `1200` 字符的历史工具结果进行脱水；
* **步长对齐边界（Step = 6）**：脱水边界以 6 条消息为整数阶梯前移，确保历史消息在数个回合内保持完全不变，保护 KV Cache 不被打穿；
* **头尾保留**：多行内容保留首 6 行 + 尾 2 行；长单行保留首 600 + 尾 200 字符；**报错信息（`isError: true`）绝对不脱水**。

#### 5. 内容寻址持久化与 CAS 蒸馏
* **技能与规则胶囊**：技能被首次调用或第三方工具首次执行后，在 `agent_settled` 异步蒸馏核心胶囊并沉淀；
* **CAS 写入校验**：写入前重新校验文件内容 SHA-256 指纹，若发生并发修改则拒绝落盘；
* **独立文件存储**：胶囊独立写入 `~/.pi/agent/cache/pi-prompt-diet/skills/${sha256}.json` 与 `tools/${sha256}.json`，状态文件 `stats.json` 权限严格限制为 `0o600`。

#### 6. 0ms 旁路直通与 Fail-Open 容灾
* **纯确认词 0ms 旁路**：`好的`、`继续`、`继续排查`、`ok go`、`next step` 等直接跳过预检模型，0 延时复用上一轮状态；
* **Fail-Open 熔断**：预检超时或模型调用异常时，自动全量放行所有工具与技能，保障开发流程绝不卡死。

---

<a name="configuration--internals"></a>

## ⚙️ 配置说明 (`pi-prompt-diet.json`)

配置文件支持全局 `~/.pi/agent/settings.json`（在 `promptDiet` 字段下），或独立文件 `~/.pi/agent/pi-prompt-diet.json` / 项目级 `.pi/pi-prompt-diet.json`：

```json
{
  "enabled": true,
  "showNotices": true,
  "requiredTools": [
    "read", "write", "bash", "edit", "find", "grep", "codemode"
  ],
  "toolResultScrubbing": {
    "enabled": true,
    "maxChars": 1200,
    "keepRecentTurns": 2
  },
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

### 关键配置项速查

| 配置项 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `enabled` | boolean | `true` | 插件总开关。亦可通过环境变量 `PI_PROMPT_DIET_DISABLE=1` 禁用。 |
| `requiredTools` | string[] | `["read", "write", "bash", "edit", "find", "grep", "codemode"]` | 核心常驻活跃工具基座。 |
| `adaptive.preflightModel` | string | `"cpa/gemini-3.5-flash-lite"` | 预检模型（大小写不敏感匹配）。 |
| `adaptive.softRouting` | boolean | `true` | 是否启用任务契约与前置软路由。 |
| `toolResultScrubbing.enabled` | boolean | `true` | 是否启用历史工具结果脱水。 |
| `toolResultScrubbing.maxChars` | number | `1200` | 工具结果触发脱水的字符阈值。 |
| `toolResultScrubbing.keepRecentTurns` | number | `2` | 保护最近不被脱水的交互轮次（至少 6 条最新消息）。 |

---

<a name="development--testing"></a>

## 🛠️ 开发、调试与测试

### 1. 监控状态命令
在交互式 Pi 中随时运行：
```text
/pi-prompt-diet
```
即可查看当前会话的工具活跃度、提示词去脂比例、历史工具脱水统计、全局累计节省 Token 与本地胶囊缓存状态。

### 2. 命令行与热重载测试
```bash
# 单次命令行执行测试
pi -p "帮我查看一下当前的 git 状态"

# 动态加载本地开发脚本
pi -e ./index.ts -p "测试前置契约与软路由"
```

### 3. 运行完整自动化测试套件
插件内置基于 Node.js 原生 Test Runner 的 33 个单元测试用例，覆盖全部核心边界：
```bash
npm test
```
```text
✔ 33 tests passed (TaskContract, CAS check, Fail-Open, Tool Scrubbing, 0ms bypass, Prompt Cache Guard, etc.)
```

---

## 📄 License

MIT License © 2026 [XRSec](https://github.com/XRSec)
