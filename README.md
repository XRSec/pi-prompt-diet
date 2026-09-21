# 🥗 pi-prompt-diet (提示词军师)

> **Pi Coding Agent 的自适应提示词去脂、Prompt Cache 保护与语义软路由插件**  
> *Prompt Cache baseline architecture, ultra-fast pre-flight semantic routing, and progressive capability distillation for [Pi Coding Agent](https://github.com/earendil-works/pi).*

[English Documentation](#english) | [中文说明](#中文说明) | [Pi 扩展开发与调试指南 (反重力 IDE 专用)](#pi-debug-guide)

---

<a name="english"></a>

## 🇬🇧 English Documentation

### ⚡ The Problem: Context Bloat & Cache Invalidation

In modern multi-agent and coding assistant ecosystems, as more third-party packages are installed, each package author independently appends guidelines and multi-paragraph skill prompts.

In standard setups, this causes:
- **9,000+ characters (50+ bullet points)** of rigid guidelines injected on *every turn*;
- **5,700+ characters (14+ skills)** of multi-paragraph skill descriptions;
- Over **5,000 baseline Tokens** consumed before you even type your request;
- **Severe Prompt Cache Invalidation**: Older dynamic rewriting approaches frequently altered the System Prompt, resulting in cache misses, higher API bills, and higher TTFT (Time To First Token).

---

### 💡 The Solution: Prompt Cache Baseline & Pre-flight Soft Routing

`pi-prompt-diet` re-architects context optimization around **Prompt Cache Protection** and **Millisecond Pre-flight Analysis**:

```
                         ┌─────────────────────────────────┐
                         │       User Request (Prompt)     │
                         └────────────────┬────────────────┘
                                          │
                  Pre-flight Soft Routing │ (cpa/gemini-3.5-flash-lite)
                                          ▼
                         ┌─────────────────────────────────┐
                         │   1. Pre-flight Intent Analysis │
                         │   • focus_tools                 │
                         │   • focus_skills                │
                         │   • need_docs                   │
                         └────────────────┬────────────────┘
                                          │
                  Zero-Cache-Cost Hint    │ <system_directive>
                                          ▼
                         ┌─────────────────────────────────┐
                         │   2. User Message Decoration    │
                         │   (System Prompt remains static)│
                         └────────────────┬────────────────┘
                                          │
                                          ▼
                         ┌─────────────────────────────────┐
                         │   3. Main LLM (Gemini / Claude) │
                         │   • Prompt Cache Hit (95% - 99%)│
                         │   • Inactive tools / skills map │
                         │   • request_capabilities gate   │
                         └─────────────────────────────────┘
```

1. **Prompt Cache Baseline Protection**: The System Prompt template remains stable across turns to maximize model prompt caching.
2. **Pre-flight Soft Routing (轻量预检软路由)**: Before invoking the main model, an ultra-fast, low-cost model (`cpa/gemini-3.5-flash-lite`) extracts the minimal focus set `{ focus_tools, focus_skills, need_docs }` in milliseconds.
3. **Zero-Cache-Cost Guidance (`<system_directive>`)**: The pre-flight hints are dynamically injected at the top of the **User message** during the `context` event, steering model attention with zero System Prompt cache invalidation.
4. **Fail-Open High-Availability Fallback**: If the pre-flight model times out or encounters network/auth errors, the plugin automatically falls back to **Fail-Open** (all tools and skills remain available), preventing workflow paralysis.
5. **Head-Tail Truncation (`truncateHeadTail`)**: Dynamically trims long context and history using a 45% Head (intent/background) + 55% Tail (latest errors/stack traces) ratio.
6. **Inactive Skills Notice**: Unselected skills are summarized as a compact name list at the bottom of `<available_skills>`, eliminating description bloat while maintaining full discoverability via `request_capabilities`.
7. **Progressive Distillation**: Automatically distills concise capsules with CAS and version locks for third-party guidelines and skills.

---

### 🏛️ The Collaboration Matrix: Advisor & General

In complex engineering tasks, `pi-prompt-diet` works in harmony with `pi-general`:

| Role | Component | Primary Model | Responsibility |
| :--- | :--- | :--- | :--- |
| **Lord (主公)** | **User** | Human | Issues top-level strategic intent and requirements. |
| **Advisor (军师)** | **`pi-prompt-diet`** | `gemini-3.5-flash-lite` | Context slimming, Prompt Cache protection, and pre-flight `<system_directive>` hints. |
| **General (将军)** | **`pi-general`** | Local State Machine + `gemini-3.1-pro` | Runtime discipline, read-streak whiplash, verify-after-action guard, and deep deadlock intervention. |
| **Soldier (小兵)** | **Main Agent** | `gemini-3.8-flash` | High-throughput, precise code modifications and tool execution. |

---

<a name="中文说明"></a>

## 🇨🇳 中文说明

### ⚡ 核心痛点：上下文膨胀与缓存失效

随着 Pi 插件生态的日益丰富，各扩展注册的 `promptGuidelines` 和技能描述无休止累加，导致：
- 每轮强行带入 **9,000+ 字符** 死板文档与 **5,700+ 字符** 技能清单；
- 尚未输入需求即被吃掉 **5,000+ Baseline Tokens**；
- **Prompt Cache 频繁失效**：早期版本频繁在会话中修改重写 System Prompt，破坏了大模型的上下文缓存，导致首字延迟（TTFT）剧增、调用费用居高不下。

---

### 💡 核心机制：Prompt Cache 基线保护与轻量预检软路由

`pi-prompt-diet` 确立了以 **Prompt Cache 保护** 为核心的全新软路由架构：

1. **Prompt Cache 基线保护**：保持静态 System Prompt 模板高度一致，享受现代大模型 95%~99% 的上下文缓存命中率。
2. **Pre-flight 毫秒级语义预检**：主模型介入前，由轻量低延迟模型（默认配置 `cpa/gemini-3.5-flash-lite`）执行毫秒级预检意图分析，提取极简意图字典 `{ focus_tools, focus_skills, need_docs }`。
3. **零缓存成本软引导注入 (`<system_directive>`)**：预检结论通过 `context` 事件直接注入在当轮 **User 消息** 顶部，引导大模型注意力且 **0 缓存失效代价**。
4. **Fail-Open 容灾高可用**：若预检模型网络抖动、鉴权失效或返回异常，系统自动触发 Fail-Open，全量放行所有工具与 Skills，保障 Agent 持续稳定工作不瘫痪。
5. **头部意图 + 尾部报错双向截取 (`truncateHeadTail`)**：按 45% 头部（任务背景）+ 55% 尾部（最新错误与补充约束）进行智能截取，完美应对“报错 -> 补充描述 -> 再报错”的多轮调试场景。
6. **消除 Skill 认知黑洞**：未被路由选中的 Skill 仅在 `<available_skills>` 尾部保留一行极简名字名单，彻底去除长描述 Token，同时赋予模型通过 `request_capabilities` 按需调用的认知地图。
7. **延续意图 0ms 极速旁路**：对 `continue`、`好的`、`继续` 等纯确认输入，直接跳过预检 API，0 延迟透传。

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

| 配置参数 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `enabled` | boolean | `true` | 是否启用本插件。 |
| `adaptive.softRouting` | boolean | `true` | 是否启用 Pre-flight 语义软路由分析。 |
| `adaptive.preflightModel` | string | `"cpa/gemini-3.5-flash-lite"` | 预检意图分析模型（推荐轻量极速模型）。 |
| `adaptive.distillSkills` | boolean | `true` | 是否在首次读取 Skill 后生成浓缩胶囊。 |
| `adaptive.distillToolGuidelines` | boolean | `true` | 是否在第三方工具调用后生成规则胶囊。 |
| `guidelines.mode` | string | `"slim"` | 内置规则裁剪模式 (`"slim"` / `"strip"` / `"full"`)。 |

---

<a name="pi-debug-guide"></a>

## 🛠️ Pi 扩展开发与调试指南 (反重力 IDE 专用)

当你在反重力 IDE (Antigravity) 或本地编辑器中进行 Pi 插件二次开发与调试时，请遵循以下标准化调试模式：

---

### 1. 快速命令行单次测试 (`pi -p`)

最适合编写完功能后进行秒级验证或自动化脚本断言：

```bash
# 基础测试：打印输出
pi -p "echo 'hello world'"

# 验证软路由是否正确分流与注入
pi -p "帮我查看一下当前的 git 状态"

# 临时禁用 prompt-diet 进行对比测试
PI_PROMPT_DIET_DISABLE=1 pi -p "查看帮助"
```

---

### 2. 临时加载开发目录中的未发布扩展 (`-e`)

无需修改全局配置或发布 npm，直接在命令行挂载本地开发脚本：

```bash
# 挂载本地扩展文件进行单次测试
pi -e ./index.ts -p "测试本地扩展功能"

# 同时挂载多个扩展或本地技能
pi -e ./index.ts -e ../pi-general/index.ts -p "双插件联动测试"
```

---

### 3. 交互式 TUI 与热重载调试 (`/reload`)

在终端或反重力 IDE 终端中启动交互式 Pi：

```bash
pi
```

* **热重载 (`/reload`)**：在反重力 IDE 中修改了 `index.ts` 或 `discipline.ts` 代码后，**无需退出重启**，直接在对话框输入 `/reload` 即可毫秒级重新加载所有扩展代码与配置！
* **实时状态查询**：
  * `/pi-prompt-diet`：查看当前已暴露工具、待命目录、胶囊缓存量；
  * `/general`：查看大将军督战状态、只读探查计数与意图模式（参谋分析 / 临阵作战）；
* **查看最新事件历史**：
  ```text
  /tree          # 进入分支树，按 Ctrl+X 复制历史消息
  ```

---

### 4. 结构化事件流调试 (`--mode json`)

当需要审查扩展是否拦截了 `tool_call`、修改了 `tool_result`，或查看完整的 Token / 预检日志时：

```bash
# 输出标准 JSON 事件流
pi -p --mode json "查看当前时间" | jq .
```

通过过滤 `event.type == "tool_result"` 可以查看 `[pi-general 大将军令]` 或 `<system_directive>` 的真实注入结果。

---

### 5. 查看真机历史会话日志

Pi 会将所有会话的底层 JSONL 存储于本地：

```bash
# 查看当前工作区最近一次会话的记录文件
ls -lt ~/.pi/agent/sessions/--Users-xr-*.jsonl | head -n 5

# 用 python 快速提取某个会话的工具调用轨迹与大将军令
python3 -c "
import json, glob, os
files = sorted(glob.glob(os.path.expanduser('~/.pi/agent/sessions/*/*.jsonl')), key=os.path.getmtime)
with open(files[-1]) as f:
    for line in f:
        d = json.loads(line)
        if d.get('message', {}).get('role') == 'toolResult':
            for c in d['message'].get('content', []):
                if '大将军令' in c.get('text', ''):
                    print(c.get('text'))
"
```

---

### 6. 自动化单元测试套件

插件基于 Node.js 原生 Test Runner（支持 TypeScript 原生剥离执行，0 依赖、极速毫秒级）：

```bash
# 运行全部单测 (覆盖 Pre-flight、Fail-Open 容灾、Head-Tail 截断、CAS 缓存)
npm test
```

---

### 7. 反重力 IDE (Antigravity) 协同配置技巧

在反重力 IDE 中打开本插件目录 `/Users/xr/.pi/agent/extensions/pi-prompt-diet` 进行开发时：

1. **全局开发链接**：检查 `~/.pi/agent/settings.json`，确保在 `extensions` 数组中包含了本地开发路径：
   ```json
   "extensions": [
     "+extensions/pi-prompt-diet/index.ts",
     "+extensions/pi-general/index.ts"
   ]
   ```
2. **调试日志输出**：在扩展内部使用 `console.error(...)` 输出的调试信息，会直接打印在 IDE 终端或 stderr 中，不会污染给大模型的对话上下文。
3. **断点与测试协同**：编写完新特性后，使用内置终端运行 `npm test` 校验通过，即可直接无缝切入日常任务开发。

---

## 📄 License

MIT License © 2026 [XRSec](https://github.com/XRSec)
