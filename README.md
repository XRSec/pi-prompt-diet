# 🥗 pi-prompt-diet

> **Pi Coding Agent 的轻量前置意图预检、任务契约与 Prompt Cache 保护插件**  
> *Lean Pre-flight Intent Analysis, Task Contract Guard, Prompt Cache Protection, and Soft Routing for [Pi Coding Agent](https://github.com/earendil-works/pi).*

[English Documentation](#english) | [中文说明](#中文说明) | [调试指南](#pi-debug-guide)

---

<a name="english"></a>

## 🇬🇧 English Documentation

### ⚡ Practical Purpose: Stop Agent Guesswork & Rogue Edits

In multi-turn coding sessions, agents frequently fail for simple, predictable reasons:
1. **Misinterpreting Intent**: Treating casual questions ("why does this crash?") as requests to immediately rewrite codebase files.
2. **Typo Hallucination**: Seeing a user's accidental typo (e.g. `dcoment`) and guessing wrong, or seeing a legitimate package name (e.g. `nowledge-mem`) and treating it as a typo.
3. **Context Inflation & Cache Busting**: Continuously mutating the System Prompt, which wipes out model prompt caches (95%+ discounts lost) and drives up latency and API costs.
4. **Historical Tool Log Dilution**: Giant diffs and tool logs from 5 turns ago linger in context, diluting the model's focus on the actual problem.

`pi-prompt-diet` is a **lean, lightweight pre-flight gatekeeper** that intercepts messages *before* the main model runs.

---

### 💡 How It Works

```
[ User Input & Recent History ]
             │
             ▼ (< 400ms Pre-flight via lightweight model, e.g. Flash-Lite / Haiku)
┌──────────────────────────────────────────────┐
│  Pre-flight Task Contract                    │
│  • Task Mode: analytical (read-only) vs      │
│               execution (write-allowed)      │
│  • clarified_intent: normalized user goal    │
│  • typo_corrections & protected_terms        │
│  • focus_tools & focus_skills (soft routing) │
└──────────────────────┬───────────────────────┘
                       │
                       ▼ (<system_directive> injected at TOP of User Message)
┌──────────────────────────────────────────────┐
│  Primary Agent Model (Gemini / Claude / etc) │
│  • 100% Static System Prompt (Cache Hit 95%+)│
│  • Hard barrier: No edits during inspection  │
│  • Historical tool outputs auto-scrubbed     │
└──────────────────────────────────────────────┘
```

---

### 🛠️ Core Capabilities

* **Strict Task Contract & Permission Guard (`allow_write`)**:
  * `analytical`: When asked to review, inspect, investigate, or explain code, `allow_write` is locked to `false`. The model is forbidden from touching source files.
  * `execution`: Only explicitly modification/script/collection tasks unlock file editing.
* **Intent Clarification (`clarified_intent`)**:
  * Extracts the core goal from ambiguous, colloquial, or ellipsis-heavy multi-turn inputs into a clean operational statement.
* **Typo Self-Healing & Protected Terms Barrier**:
  * Automatically corrects typing slips.
  * Flags proprietary packages, tool names, and variables as `protected_terms`, strictly preventing the model from hallucinating them as misspellings.
* **Zero-Cost Prompt Cache Preservation**:
  * The System Prompt remains completely static. Directives are injected only as `<system_directive>` inside the incoming User turn during the `context` lifecycle event.
* **Historical Tool Scrubbing**:
  * Automatically condenses bloated historical tool outputs (large file dumps, giant diffs) in long sessions, preserving attention tokens.
* **0ms Bypass & Fail-Open**:
  * Fast bypass for simple confirmation words (`continue`, `ok`, `好的`).
  * Instant fail-open on any pre-flight error to never stall work.

---

<a name="中文说明"></a>

## 🇨🇳 中文说明

### ⚡ 为什么做这个插件？（务实去虚）

在多轮编程开发中，大部分失控并不是因为模型参数不够大，而是因为缺少最基础的前置拦截约束：
1. **意图跑偏与擅自改动**：用户只是随口问一句“帮我看看这个报错怎么回事”，模型直接自作主张把几十行代码全改了；
2. **错别字误导与专有名词误伤**：用户手滑打错一个字母，模型当真并展开灾难性脑补；或者用户提到一个冷门包名（如 `nowledge-mem`），模型自作聪明去给它“纠错”；
3. **缓存击穿与账单暴涨**：很多方案动态改写 System Prompt，直接击穿各大模型 95%+ 的 Prompt Cache 缓存折扣，不仅卡顿还费钱；
4. **历史脏数据稀释注意力**：跑了几轮之后，前面巨长的大文件读取、diff 垃圾一直堆在上下文里，把模型注意力冲得一干二净。

`pi-prompt-diet` 去除了所有花哨的架子，做的事情非常聚焦：**在用户消息发出后、主模型动手前，做一层轻巧的“意图整理、权限卡死、错字校正与缓存保护”**。

---

### 💡 核心机制

#### 1. 任务契约与只读权限硬锁 (`Task Contract`)
* **`analytical`（只读巡检）**：只要识别出用户只是在“检查”、“看代码”、“分析报错”、“review”，强行锁死 **`allow_write: false`**。主模型被物理剥夺修改业务源码的权限，只能直接汇报分析结论；
* **`execution`（任务执行）**：涉及明确的代码实现、脚本运行或数据抓取时，放行写权限。

#### 2. 意图提炼与多轮消歧 (`clarified_intent`)
* 结合最近 2~3 轮会话，把用户口语化、含糊不清、缺少主语的输入，翻译成标准规范的真实意图需求。

#### 3. 错别字自愈与专有术语保护 (`protected_terms`)
* 自动识别用户的拼写手滑；
* 提取命令里的包名、文件名、代码标识符，打上保护标记，明确命令主模型**绝不允许当成拼写错误**。

#### 4. 零成本 Prompt Cache 软注入 (`<system_directive>`)
* **不碰静态 System Prompt**：确保吃满大模型 95%~99% 的 Prompt Cache 命中率；
* **挂载在 User 消息顶端**：在 `context` 阶段，将任务契约以 `<system_directive>` 标签注入在当轮用户消息的顶部引导注意力。

#### 5. 历史工具结果智能脱水 (Tool Result Scrubbing)
* 自动压缩前面轮次遗留的冗长工具返回值（巨型日志、全文件内容、长 diff），仅保留头尾摘要，释放干净上下文。

#### 6. 0ms 旁路与 Fail-Open 容灾
* “好的”、“继续”、“continue” 等确认词直接 0ms 旁路跳过预检；
* 预检超时或模型调用异常时，自动全量放行（Fail-Open），绝不阻断流程。

---

### ⚙️ 配置说明 (`pi-prompt-diet.json`)

配置文件位于 `~/.pi/agent/pi-prompt-diet.json` 或项目级 `.pi/pi-prompt-diet.json`：

```json
{
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
  }
}
```

---

<a name="pi-debug-guide"></a>

## 🛠️ 快速测试与验证

```bash
# 1. 单次执行测试
pi -p "帮我查看一下当前的 git 状态"

# 2. 临时加载本地扩展
pi -e ./index.ts -p "测试前置契约与软路由"

# 3. 运行自动化单元测试套件
npm test
```

---

## 📄 License

MIT License © 2026 [XRSec](https://github.com/XRSec)
