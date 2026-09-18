# 🥗 pi-prompt-diet

> An adaptive System Prompt and capability router for [Pi Coding Agent](https://github.com/earendil-works/pi) that starts with a minimal capability set, expands it as session needs evolve, and progressively discloses tool schemas and Skill guidance from compact indexes to full content.

[English](#english) | [中文说明](#中文说明)

---

<a name="english"></a>

## 🇬🇧 English Documentation

### ⚡ The Problem

As the Pi package ecosystem expands, installing multiple third-party packages causes `promptGuidelines` and
`<available_skills>` to bloat uncontrollably.

A standard setup with 8–10 packages often results in:

- **9,000+ characters (50+ bullet points)** of rigid guidelines injected on *every turn*;
- **5,700+ characters (14+ skills)** of multi-paragraph skill descriptions;
- Over **5,000 baseline Tokens** consumed before you even type a prompt;
- Severe context window dilution and unnecessary API billing.

### 💡 The Solution: Adaptive Capability Routing

`pi-prompt-diet` combines semantic routing with a monotonic, progressively disclosed capability model:

1. **Minimal Initial Route**: The first request and a compact catalog of registered tools and Skills are sent to the router. A successful first route replaces Pi's default broad active set with the smallest sufficient set.
2. **Incremental Session Expansion**: Later requests are routed against the current active set and continuation context. Newly required capabilities are added; capabilities already active in the session are not removed.
3. **Always-Available Recovery Path & Budget Guard**: The resident `request_capabilities` meta-tool lets the main model request registered tools or Skills discovered during execution. Turn-level budgets (default max 2 requests/turn, max 8 additions/call) prevent infinite activation loops. Pi exposes newly activated tool definitions on the following model request in the same agent run—without `/reload` or a synthetic “continue” message.
4. **Progressive Tool Disclosure**: Inactive tools appear only as a compact name-and-purpose index. Once activated, Pi supplies their original, complete parameter schemas. The executable schema is never replaced by an AI summary.
5. **Constraint-First Tool and Skill Distillation**: An unknown third-party tool keeps its complete author-written guidelines on first use. After a successful real call, a background model either caches `full` when the rules are already dense, or creates a concise guideline capsule that prioritizes negative constraints ("never", "do not") and sequential ordering. Skills are distilled after the main model reads the full `SKILL.md`.
6. **Content-Addressed Cache with CAS & Distiller Versioning**: Tool decisions live independently under `~/.pi/agent/cache/pi-prompt-diet/tools/`; Skill capsules live under `~/.pi/agent/cache/pi-prompt-diet/skills/`. SHA-256 fingerprints combine source content with `DISTILLER_VERSION` and use Compare-And-Swap checks to prevent stale concurrent overwrites.
7. **Session Persistence, Commands & Observability**: Capability state is persisted in the Pi session, while `/pi-prompt-diet` command provides instant inspection into active/inactive tools, cache counts, and expansion stats.
8. **Hierarchical Overrides**: Existing global and per-package `slim` / `strip` / `full` policies remain available and apply after routing.

#### Disclosure Levels

| Level | What the main model receives | Purpose |
|---|---|---|
| **Capability index** | Inactive tool/Skill name, type, and one-line purpose | Discover what can be requested without paying for every schema |
| **Active tool** | Original tool description (safely bounded to 350 chars) and complete parameter schema | Make the tool safely callable |
| **Active Skill** | Original description or distilled capsule plus the `SKILL.md` path | Route to the right workflow guidance |
| **Full Skill** | Complete `SKILL.md`, read on demand | Apply detailed rules and edge cases |

The core rule is: **the index provides discoverability, the original schema provides executability, and the Skill provides correct usage guidance.**

---

### 📊 Historical Benchmark

> These measurements document the earlier aggressive `slim` + `compress` baseline. Current adaptive behavior keeps an unknown third-party tool's complete guidelines on first use, then caches either `full` or a safe capsule after evaluation. Re-benchmark before quoting these figures as current defaults.

| Metric                     | Before Diet              | Legacy aggressive baseline                             | Reduction              |
|----------------------------|--------------------------|--------------------------------------------------------|------------------------|
| **System Prompt Size**     | 20,030 chars (~5,008 T)  | **9,930 chars (~2,483 T)**                             | 🔻 **-50.4%**          |
| **Guidelines Block**       | 9,265 chars (52 bullets) | **537 chars (7 core heuristics)**                      | 🔻 **-94.2%**          |
| **Skills Block**           | 5,755 chars (14 skills)  | **4,383 chars (14 skills, natural sentence-first)**    | 🔻 **-23.8%**          |
| **Token Savings Per Turn** | -                        | **~2,525 Tokens / turn**                               | 💰 **Instant Savings** |
| **Tool Functionality**     | 33 tools active          | **33 tools active**                                    | ✅ **100% Preserved**  |

<details>
<summary>🔍 <b>Click to expand granular per-package breakdown & reduction evidence</b></summary>

#### Current Per-Package Guideline Policy

| Tool source | First successful use | Later uses |
|-------------|----------------------|------------|
| Pi built-ins | Follow global `guidelines.mode` | Follow global `guidelines.mode` |
| Unknown third-party tool | Keep complete author guidelines | Use cached `full` or a safe capsule |
| Explicit package override | Follow the configured `full` / `slim` / `strip` mode | Continue following the override |
| `Pi Core Guidelines`                     | `read`, `edit`, `write` | core replacement  | Preserve concise file-safety rules. |

#### Measured Skill Description Breakdown

| Skill Name             | Location / Origin                         | Original Description Length           | Whitelist Treatment           |
|------------------------|-------------------------------------------|---------------------------------------|-------------------------------|
| `ego-browser`          | `~/.agents/skills/ego-browser`            | **977 chars** (verbose trigger lists) | Offloaded to on-demand `read` |
| `research-routing`     | `~/.pi/agent/extensions/research-routing` | **210 chars**                         | Kept in whitelist (120 chars) |
| `private-house-code`   | `~/.agents/skills/private-house-code`     | **241 chars**                         | Kept in whitelist (120 chars) |
| `pi-lens-*` (4 skills) | `npm:pi-lens`                             | **~500 chars** combined               | Offloaded to on-demand `read` |

</details>

---

### 💻 Interactive Commands

You can inspect the capability and cache status anytime inside a Pi session:

```text
/pi-prompt-diet
```

This outputs a diagnostic overview:
- **Active Tools**: Tools currently exposed to the main LLM.
- **Inactive Registered Tools**: Capabilities parked in the compact catalog.
- **Skill / Tool Capsules in Cache**: Number of distilled capsules saved to disk.
- **Session Expansions**: Number of dynamic activations triggered via `request_capabilities`.

---

<details>
<summary>⚙️ <b>Click to expand Configuration Guide (<code>pi-prompt-diet.json</code>)</b></summary>

### Hierarchical Configuration (`pi-prompt-diet.json`)

`pi-prompt-diet.json` supports top-level global defaults + a `packages` array for granular overrides (including exact per-skill/file mode mappings like `"skills/council-mode": "full"` and `"skills/pi-subagents": "slim"`).

> 💡 **Auto-Initialization**: If `~/.pi/agent/pi-prompt-diet.json` does not exist on startup, `pi-prompt-diet` will automatically generate a standard, best-practice default configuration file for you!

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
    "maxTools": 16,
    "maxSkills": 8,
    "maxRequestsPerTurn": 2,
    "maxAdditionsPerRequest": 8,
    "distillSkills": true,
    "distillToolGuidelines": true
  },
  "packages": []
}
```

There is no built-in package whitelist. An unrecognized third-party tool is cold-started with its complete author guidelines. After the tool is actually called successfully, the evaluator caches either `full` (already concise or unsafe to shorten) or a concise capsule. Explicit package overrides still take precedence and disable automatic treatment for that package.

The router uses the current session model by default. Set `adaptive.model` to a `provider/model` id to use a cheaper dedicated model. The first successful route may shrink Pi's initial broad tool set; after that, Prompt Diet only adds capabilities. By default, routing runs only on cold start and when the tool registry changes; set `adaptive.routeEveryTurn` to `true` to restore per-turn routing. When `adaptive.alwaysTools` is set and `routeEveryTurn` is false, the router LLM is skipped entirely on startup. Router calls abort after `adaptive.routingTimeoutMs` (default `5000`) and fall back to the current capability set. Short continuation prompts such as “continue” reuse the persisted pending-task context when available. If routing or activation fails, Prompt Diet preserves the current capability set instead of shrinking it.

Recovery requests disclose selected Skills immediately with their original description and `SKILL.md` path. If needed, `read` is activated in the same call and counts toward `adaptive.maxAdditionsPerRequest` (default `8`). Every attempted call, including validation or activation failures, counts toward `adaptive.maxRequestsPerTurn` (default `2`); the counter resets on the next user turn. `neverAutoActivate` and `requireExplicitUserIntent` apply to both tool and Skill names. The latter is a name-mention check, not a semantic authorization classifier.

When no inactive capabilities remain, routing skips the model call. Duplicate Skill selections are deduplicated before applying `maxSkills`. Active Skills are excluded before reading and hashing cached Skill files for the router catalog.

Validated Skill capsules are included whole: at most four rules, with each rule, trigger, and full-read condition limited to 300 characters. The static `skills.maxDescriptionLength` limit does not cut these capsules. Invalid or oversized Skill distillations fall back to the original description; invalid, oversized, or non-saving tool capsules keep the full guidelines. Malformed cache entries are ignored. Distiller version `v3.2` invalidates older fingerprints so previously truncated capsules are rebuilt after subsequent use.

#### Advanced Granular Overrides (`packages` Array)

`pi-prompt-diet` supports multiple granular override formats in the `packages` array:

```json
{
  "packages": [
    // 1. Precise per-file/skill mode mapping:
    {
      "source": "npm:pi-subagents",
      "guidelines": { "mode": "full" },
      "skills": {
        "skills/council-mode": "full",   // 👈 Keep full multi-paragraph description
        "skills/pi-subagents": "slim"    // 👈 Compress to concise primary sentence
      }
    },
    // 2. Include/Exclude rule list (matching settings.json +/- syntax):
    {
      "source": "npm:pi-lens",
      "skills": [
        "-skills/pi-lens-write-tree-sitter-rule", // 👈 Exclude this rule skill from prompt
        "+skills/pi-lens-lsp-navigation"          // 👈 Keep navigation skill
      ]
    },
    // 3. Complete package-level stripping:
    {
      "source": "npm:@juicesharp/rpiv-ask-user-question",
      "guidelines": { "mode": "strip" }
    }
  ]
}
```

#### Configuration Reference

| Level                | Key                           | Options / Type                                                                                                            | Description                                                                                     |
|----------------------|-------------------------------|---------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------|
| **Global**           | `guidelines.mode`             | `"slim"` \| `"strip"` \| `"full"`                                                                                         | Default guideline treatment across all packages.                                                |
| **Global**           | `skills.mode`                 | `"compress"` \| `"strip"` \| `"full"`                                                                                     | Default skill description treatment (natural sentence-first algorithm).                         |
| **Global**           | `skills.maxDescriptionLength` | `number` (default: `200`)                                                                                                 | Max characters for static description compression; validated adaptive capsules retain complete rules.                     |
| **Adaptive**         | `adaptive.enabled`            | `boolean` (default: `true`)                                                                                               | Enable minimal initial routing and later incremental capability routing.                          |
| **Adaptive**         | `adaptive.model`              | `"provider/model"`                                                                                                       | Optional dedicated router/distiller model; defaults to the active session model.                 |
| **Adaptive**         | `adaptive.alwaysTools`         | `string[]`                                                                                                                | Valid tool names always included in the selected set.                                            |
| **Adaptive**         | `adaptive.maxTools`            | `number` (default: `16`)                                                                                                  | Maximum new tools returned by one router decision.                                               |
| **Adaptive**         | `adaptive.maxSkills`           | `number` (default: `8`)                                                                                                   | Maximum new Skills returned by one router decision.                                              |
| **Adaptive**         | `adaptive.distillSkills`       | `boolean` (default: `true`)                                                                                               | Distill a Skill after its complete `SKILL.md` is first read.                                     |
| **Adaptive**         | `adaptive.distillToolGuidelines` | `boolean` (default: `true`)                                                                                             | Evaluate third-party guidelines after a successful tool call and cache `full` or a capsule.      |
| **Adaptive**         | `adaptive.routeEveryTurn`      | `boolean` (default: `false`)                                                                                              | Route on every user turn; when false, rely on `request_capabilities` after cold start.           |
| **Adaptive**         | `adaptive.routingTimeoutMs`    | `number` (default: `5000`)                                                                                                | Abort blocking router/distiller LLM calls after this many milliseconds.                          |
| **Package Override** | `packages[].source`           | `string`                                                                                                                  | Package name (e.g. `"npm:pi-subagents"` or `"pi-gpt"`).                                         |
| **Package Override** | `packages[].guidelines`       | `"slim"` \| `"strip"` \| `"full"` \| `{"mode": "..."}`                                                                    | Package-specific guidelines override.                                                           |
| **Package Override** | `packages[].skills`           | `"compress"` \| `"strip"` \| `"full"` \| `{"mode": "..."}` \| `string[]` \| `Record<string, "full" \| "slim" \| "strip">` | Package-specific skill override (supports mode object, +/- rule arrays, or exact file mapping). |

</details>

---

### 📚 Deep Dive Architecture

For an in-depth explanation of the multi-agent context inflation problem, internal prompt middleware pipeline, and
progressive disclosure implementation, see the [Architecture & Design Principles](ARCHITECTURE.md) document.

---

### 📦 Installation

Install directly via Pi package manager:

```bash
pi install git:github.com/XRSec/pi-prompt-diet
# Or once published on npm:
pi install npm:pi-prompt-diet
```

---

<a name="中文说明"></a>

## 🇨🇳 中文说明

### ⚡ 核心痛点

随着 Pi 插件生态的繁荣，用户在安装多个常用扩展后，各扩展注册的 `promptGuidelines` 和技能描述会在后台不断累加。

这导致：

- **即便只是问一句“今天星期几”**，每轮也会无脑带入 **9,000+ 字符（50 多条）** 的死板文档与 **5,700+ 字符** 的技能清单；
- 会话还未开始，就已被吃掉 **5,000+ Baseline Tokens**；
- 严重稀释大模型的上下文注意力窗口，造成显著的 API 费用浪费。

### 💡 解决方案：自适应能力路由

`pi-prompt-diet` 将语义路由与“只扩展、不收缩”的渐进式能力披露模型结合：

1. **首轮最小路由**：第一条需求与全部已注册工具、Skill 的紧凑目录交给 Router；首轮路由成功后，可将 Pi 默认的宽泛活动工具集合缩减为完成当前任务所需的最小集合。
2. **会话内增量扩容**：后续需求会结合当前活动能力与 continuation context 再做增量判断；新增需要的能力会被加入，本会话已经激活的能力不会被移除。
3. **常驻恢复入口与预算保护**：`request_capabilities` 元工具始终活动，并具备单 Turn 预算防护（防刷与单次上限）。主模型在读取文件或工具结果后才发现能力不足时，可按名称申请已注册工具或 Skill；Pi 会在同一 Agent run 的下一次模型请求中暴露新工具，无需 `/reload`，也无需伪造一条“继续”。
4. **工具由浅至深披露**：未激活工具只以“名称 + 类型 + 一句话用途”的目录形式出现；激活后由 Pi 提供原始、完整的参数 Schema。可执行 Schema 不会被 AI 蒸馏版本替代。
5. **约束优先的工具与 Skill 蒸馏**：陌生第三方工具首次完整保留作者规则，使用后评估并优先提取负向约束（"never", "do not"）与执行顺序；若规则已精炼则直接缓存为 `full`。Skill 在首次完整读取后自动提炼关键规则胶囊。
6. **带版本锁与 CAS 的内容寻址缓存**：工具与 Skill 胶囊分别独立保存于 `~/.pi/agent/cache/pi-prompt-diet/tools/` 与 `skills/`；指纹混入 `DISTILLER_VERSION` 并采用 CAS 校验，防止并发竞争写入脏数据。
7. **会话持久化与 `/pi-prompt-diet` 可观测性**：能力状态持久化到 Pi Session；可随时通过 `/pi-prompt-diet` 命令查看当前活跃工具、未激活目录、胶囊缓存量与会话扩容指标。
8. **分层覆盖保持兼容**：原有全局与包级 `slim` / `strip` / `full` 策略继续生效。

#### 能力披露层级

| 层级 | 主模型收到的内容 | 目的 |
|---|---|---|
| **能力索引** | 未激活工具/Skill 的名称、类型和一句话用途 | 低成本知道“还能申请什么” |
| **活动工具** | 工具原始描述（安全截断至 350 字符）和完整参数 Schema | 让模型真正、正确地发起工具调用 |
| **活动 Skill** | 原始描述或蒸馏胶囊，以及 `SKILL.md` 路径 | 将模型路由到正确的工作流指导 |
| **完整 Skill** | 按需读取的完整 `SKILL.md` | 执行详细规则、边界条件和复杂流程 |

核心原则是：**目录负责可发现，原始 Schema 负责可执行，Skill 负责正确使用。**

---

### 📊 历史基准数据

> 以下数据记录的是早期激进版 `slim` + `compress` 基线。当前会在陌生第三方工具首次使用时完整保留 Guidelines，之后再缓存 `full` 或安全胶囊；请勿将下表直接作为当前默认配置数据引用。

| 模块 / 指标                           | 优化前基线             | 早期激进版基线                                   | 缩减幅度             |
|---------------------------------------|------------------------|--------------------------------------------------|----------------------|
| **System Prompt 实际体积**            | 20,030 字符 (~5,008 T) | **9,930 字符 (~2,483 T)**                        | 🔻 **-50.4%**        |
| **Guidelines 规则区**                 | 9,265 字符 (52 条)     | **537 字符 (7 条核心准则)**                      | 🔻 **-94.2%**        |
| **技能描述区 (`<available_skills>`)** | 5,755 字符 (14 个技能) | **4,383 字符 (14 个技能自然完整首句浓缩)**       | 🔻 **-23.8%**        |
| **单轮节省 Token**                    | -                      | **~2,525 Tokens / 轮**                           | 💰 **极致省流**      |
| **工具与技能可用性**                  | 33 个工具全激活        | **33 个工具全激活**                              | ✅ **100% 完整保留** |

<details>
<summary>🔍 <b>点击展开：具体各 NPM 插件削减明细与量化证据</b></summary>

#### 当前各包 Guidelines 默认策略

| 工具来源 | 第一次成功使用 | 后续使用 |
|----------|----------------|----------|
| Pi 内置工具 | 遵循全局 `guidelines.mode` | 遵循全局 `guidelines.mode` |
| 未知第三方工具 | 完整保留作者 Guidelines | 使用缓存的 `full` 或安全胶囊 |
| 显式包级 override | 遵循配置的 `full` / `slim` / `strip` | 继续遵循 override |
| `Pi Core 内置规则`                       | `read`, `edit`, `write` | 核心替换 | 保留精简文件安全规则。 |

</details>

---

### 💻 交互式命令

在 Pi 会话中输入斜杠命令即可实时查看瘦身与缓存状态：

```text
/pi-prompt-diet
```

面板将展示：
- **Active Tools**：当前暴露给大模型的活动工具；
- **Inactive Registered Tools**：留在紧凑目录待命的未激活工具；
- **Skill / Tool 胶囊缓存量**：本地已沉淀的蒸馏胶囊总数；
- **本会话动态扩容数**：模型通过 `request_capabilities` 成功加载的新工具数。

---

<details>
<summary>⚙️ <b>点击展开：极简配置文件参考 (<code>pi-prompt-diet.json</code>)</b></summary>

### 分层式配置文件参考 (`pi-prompt-diet.json`)

采用与 Pi 官方 `settings.json` 一致的分层结构，顶层写全局默认策略，`packages` 数组中写特定插件的精准覆盖（支持单个文件独立指定策略，如 `"skills/council-mode": "full"`）：

> 💡 **自动初始化**：如果本地尚不存在 `~/.pi/agent/pi-prompt-diet.json`，插件在首次运行时会自动创建开箱即用的标准默认配置！

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
    "maxTools": 16,
    "maxSkills": 8,
    "maxRequestsPerTurn": 2,
    "maxAdditionsPerRequest": 8,
    "distillSkills": true,
    "distillToolGuidelines": true
  },
  "packages": []
}
```

不再维护内置插件白名单。陌生第三方工具第一次实际使用时完整保留作者 Guidelines；成功调用后，评估器缓存 `full`（已经精炼或不宜缩短）或安全胶囊。用户显式配置的包级 override 始终优先，并会关闭该包的自动处理。

路由器默认复用当前会话模型，也可通过 `adaptive.model` 指定更便宜的 `provider/model`。首轮成功路由可以缩减 Pi 初始的宽泛工具集合；完成首次接管后，Prompt Diet 只增加能力。默认仅在冷启动和 Registry 变化时路由；设置 `adaptive.routeEveryTurn: true` 可恢复每轮路由。当配置了 `adaptive.alwaysTools` 且 `routeEveryTurn` 为 false 时，启动阶段会跳过阻塞式 Router LLM。Router 调用超过 `adaptive.routingTimeoutMs`（默认 `5000`）会中止并回退到当前能力集合。“继续”等短输入在存在已持久化 `pendingTask` 时复用 continuation context。路由或激活失败时保留当前能力集合，不会继续缩减。

#### 进阶包微调与全场景覆盖示例 (`packages` 数组)

补充能力时会立即返回入选 Skill 的原始描述和 `SKILL.md` 路径；如需启用 `read`，会在同一次调用中完成，并计入 `adaptive.maxAdditionsPerRequest`（默认 `8`）。每次调用尝试都计入 `adaptive.maxRequestsPerTurn`（默认 `2`），包括校验失败与激活失败，下一轮用户请求重置计数。`neverAutoActivate` 和 `requireExplicitUserIntent` 同时作用于工具名和 Skill 名；后者检查名称是否被提及，不是语义授权判定器。

没有剩余未激活能力时跳过路由模型调用；重复 Skill 名先去重再应用 `maxSkills` 限制。构建路由目录时先排除已激活 Skill，避免为它们重复读取文件和计算指纹。

有效 Skill 胶囊整体保留：最多四条规则，每条规则、触发条件和完整读取条件各限 300 字符，不再受静态 `skills.maxDescriptionLength` 二次截断。Skill 蒸馏结果无效或超长时回退原描述；工具胶囊无效、超限或比原文更长时保留完整 Guidelines。损坏缓存会被忽略。蒸馏版本升级到 `v3.2`，旧指纹自动失效，后续实际使用后重新生成，避免复用已截断的胶囊。

`pi-prompt-diet` 在 `packages` 数组中支持多种灵活的细粒度覆盖语法：

```json
{
  "packages": [
    // 1. 精确到单个技能文件的模式映射：
    {
      "source": "npm:pi-subagents",
      "guidelines": { "mode": "full" },
      "skills": {
        "skills/council-mode": "full",   // 👈 该技能保留原版多段落完整描述
        "skills/pi-subagents": "slim"    // 👈 该技能浓缩为单句核心说明
      }
    },
    // 2. 类似 settings.json 的 +/- 路径规则数组：
    {
      "source": "npm:pi-lens",
      "skills": [
        "-skills/pi-lens-write-tree-sitter-rule", // 👈 排除特定规则编写技能
        "+skills/pi-lens-lsp-navigation"          // 👈 放行核心导航技能
      ]
    },
    // 3. 彻底剥离特定插件的 Guidelines：
    {
      "source": "npm:@juicesharp/rpiv-ask-user-question",
      "guidelines": { "mode": "strip" }
    }
  ]
}
```

#### 配置层级与参数说明

| 配置层级     | 参数项                        | 可选值                                                                                                                    | 说明                                                                      |
|--------------|-------------------------------|---------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------|
| **全局默认** | `guidelines.mode`             | `"slim"` \| `"strip"` \| `"full"`                                                                                         | 全局通用的 Guidelines 处理策略（默认 `"slim"`）。                         |
| **全局默认** | `skills.mode`                 | `"compress"` \| `"strip"` \| `"full"`                                                                                     | 全局通用的技能描述处理策略（默认自然首句优先智能浓缩）。                  |
| **全局默认** | `skills.maxDescriptionLength` | `number` (默认 `200`)                                                                                                     | 静态描述压缩的字符上限；经过校验的自适应胶囊保留完整规则，不再次截断。                                 |
| **自适应**   | `adaptive.enabled`            | `boolean`（默认 `true`）                                                                                                  | 启用首轮最小路由与后续增量能力路由。                                      |
| **自适应**   | `adaptive.model`              | `"provider/model"`                                                                                                       | 可选专用路由/蒸馏模型；默认使用当前会话模型。                             |
| **自适应**   | `adaptive.alwaysTools`         | `string[]`                                                                                                                | 无论路由结果如何都保留的有效工具名称。                                    |
| **自适应**   | `adaptive.maxTools`            | `number`（默认 `16`）                                                                                                     | 单次 Router 决策最多返回的新工具数。                                      |
| **自适应**   | `adaptive.maxSkills`           | `number`（默认 `8`）                                                                                                      | 单次 Router 决策最多返回的新 Skill 数。                                   |
| **自适应**   | `adaptive.distillSkills`       | `boolean`（默认 `true`）                                                                                                  | 首次读取完整 `SKILL.md` 后生成蒸馏胶囊。                                  |
| **自适应**   | `adaptive.distillToolGuidelines` | `boolean`（默认 `true`）                                                                                                | 第三方工具成功调用后评估 Guidelines，并缓存 `full` 或胶囊。               |
| **自适应**   | `adaptive.routeEveryTurn`      | `boolean`（默认 `false`）                                                                                                 | 每轮用户请求都路由；为 false 时冷启动后依赖 `request_capabilities`。     |
| **自适应**   | `adaptive.routingTimeoutMs`    | `number`（默认 `5000`）                                                                                                   | 阻塞式 Router/蒸馏 LLM 调用超过该毫秒数后中止。                           |
| **包级覆盖** | `packages[].source`           | `string`                                                                                                                  | 目标插件包名（如 `"npm:pi-subagents"` 或 `"pi-gpt"`）。                   |
| **包级覆盖** | `packages[].guidelines`       | `"slim"` \| `"strip"` \| `"full"` \| `{"mode": "..."}`                                                                    | 针对该特定插件的 Guidelines 处理策略覆盖。                                |
| **包级覆盖** | `packages[].skills`           | `"compress"` \| `"strip"` \| `"full"` \| `{"mode": "..."}` \| `string[]` \| `Record<string, "full" \| "slim" \| "strip">` | 针对该特定插件的技能处理覆盖（支持模式对象、+/-规则数组或单文件映射表）。 |

</details>

---

### 📚 深度架构与设计原理

关于多插件生态下提示词膨胀机理、中间件处理流水线图以及三层渐进式披露体系的深度技术实现，请参阅根目录下的 [架构设计与核心原理 (ARCHITECTURE.md)](ARCHITECTURE.md)。

---

## 📄 License

MIT License © 2026 [XRSec](https://github.com/XRSec)
