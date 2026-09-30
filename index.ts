import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import {
	completeJson,
	compactCatalogDescription,
	truncateHeadTail,
	distillSkill,
	distillToolGuidelines,
	formatSkillCapsule,
	formatToolGuidelineCapsule,
	getValidSkillCapsule,
	getValidToolGuidelineCapsule,
	loadSkillCapsuleCache,
	loadToolGuidelineCapsuleCache,
	saveSkillCapsule,
	saveToolGuidelineCapsule,
	loadGlobalStats,
	recordStatsDelta,
	loadSessionState,
	saveSessionState,
	type DietGlobalStats,
	type SessionStatEntry,
	type AdaptiveConfig,
	type CapabilitySkill,
	type CapabilityTool,
} from "./adaptive.ts";

/**
 * 参考 settings.json 的分层策略定义：
 * 支持全局默认策略 + packages 数组对指定插件做精细化局部覆盖。
 */
export type TreatmentMode = "compress" | "slim" | "strip" | "full";

export type SkillRuleValue = TreatmentMode | { mode?: TreatmentMode; maxDescriptionLength?: number };

export interface PackageOverrideConfig {
	source: string; // 例如 "npm:pi-subagents", "pi-gpt", "ego-browser"
	guidelines?: TreatmentMode | { mode?: TreatmentMode };
	// skills 支持：
	// 1. 统一模式字符串: "compress" | "strip" | "full"
	// 2. 模式对象: { "mode": "strip" }
	// 3. 数组规则: ["-skills/council-mode", "+skills/pi-subagents"]
	// 4. 精准文件键值映射对象: { "skills/council-mode": "strip", "skills/pi-subagents": "full" }
	skills?: TreatmentMode | { mode?: TreatmentMode; maxDescriptionLength?: number; rules?: string[] } | string[] | Record<string, SkillRuleValue>;
	maxDescriptionLength?: number;
}

export interface TaskContract {
	intent: "analytical" | "execution" | "composite";
	allow_write: boolean;
	reason?: string;
	clarified_intent?: string;
	typo_corrections?: string[];
	protected_terms?: string[];
	focus_tools?: string[];
	focus_skills?: string[];
	need_docs?: boolean;
	source: "preflight" | "continuation" | "fallback";
	updatedAt: number;
}

export interface ToolResultScrubbingConfig {
	enabled?: boolean;
	maxChars?: number;
	keepRecentTurns?: number;
}

export interface PromptDietConfig {
	enabled?: boolean;
	showNotices?: boolean;
	requiredTools?: string[];
	toolResultScrubbing?: ToolResultScrubbingConfig;
	guidelines?: {
		mode?: TreatmentMode;      // 全局默认: "slim" | "strip" | "full"
		customCore?: string[];     // 自定义核心 7 准则
	};
	skills?: {
		mode?: TreatmentMode;      // 全局默认: "compress" | "strip" | "full"
		maxDescriptionLength?: number;
	};
	packages?: (string | PackageOverrideConfig)[];
	adaptive?: AdaptiveConfig;
}

const turnRoutingHints = new Map<string, string>();
const CALL_TOOL = "call_tool";
const REQUEST_CAPABILITIES_TOOL = "request_capabilities";

function emitDietStepMessage(
	pi: ExtensionAPI,
	ctx: any,
	customType: string,
	content: string,
	details?: unknown
) {
	try {
		// Pure ephemeral UI notification: displays message reminder on pi-web and TUI
		// Never writes to session.jsonl (no appendCustomMessageEntry or sendMessage)
		const ui = ctx?.ui || (pi as any)?.ui;
		if (typeof ui?.notify === "function") {
			const level = customType.includes("blocked") || customType.includes("fallback") ? "warning" : "info";
			ui.notify(content, level);
		}
	} catch (e) {
		console.error("[pi-prompt-diet] emitDietStepMessage error:", e);
	}
}

interface SessionStats {
	promptInitialChars: number;
	promptSlimmedChars: number;
	scrubbedToolResultsCount: number;
	scrubbedSavedChars: number;
	activeTools?: string[];
	activeSkills?: string[];
	needDocs?: boolean;
}

function getSessionKey(ctx: ExtensionContext): string {
	return ctx.sessionManager?.getSessionId?.() || ctx.sessionManager?.getSessionName?.() || ctx.cwd || "default";
}

const sessionStatsMap = new Map<string, SessionStats>();

function getOrCreateSessionStats(sessionId: string): SessionStats {
	let s = sessionStatsMap.get(sessionId);
	if (!s) {
		const persistent = loadSessionState(sessionId);
		s = {
			promptInitialChars: persistent?.promptInitialChars ?? 0,
			promptSlimmedChars: persistent?.promptSlimmedChars ?? 0,
			scrubbedToolResultsCount: persistent?.scrubbedToolResultsCount ?? 0,
			scrubbedSavedChars: persistent?.scrubbedSavedChars ?? 0,
			activeTools: persistent?.activeTools,
			activeSkills: persistent?.activeSkills,
			needDocs: persistent?.needDocs,
		};
		sessionStatsMap.set(sessionId, s);
	}
	return s;
}

function notifyDiet(
	ctx: ExtensionContext,
	message: string,
	level: "info" | "warning" | "error" = "info"
) {
	// Directly emit floating notification toast on pi-web and TUI without touching jsonl
	if ((ctx as any)?.hasUI && (ctx as any).ui?.notify) {
		(ctx as any).ui.notify(message, level);
	}
	if (!(ctx as any)?.hasUI || process.env.DEBUG) {
		console.error(message);
	}
}

function updateDietStatus(ctx: ExtensionContext, text: string | undefined) {
	if ((ctx as any)?.hasUI && typeof (ctx as any).ui?.setStatus === "function") {
		(ctx as any).ui.setStatus("prompt-diet", text);
	}
}

function updateDietWidget(ctx: ExtensionContext, lines: string[] | undefined) {
	if ((ctx as any)?.hasUI && typeof (ctx as any).ui?.setWidget === "function") {
		(ctx as any).ui.setWidget("prompt-diet", lines);
	}
}

// Lean primitive baseline: read, write, bash, edit, find, grep.
// Advanced capabilities (replace/hashline, bg_run, subagent)
// are dynamically activated on-demand via semantic preflight routing or call_tool.
const DEFAULT_REQUIRED_TOOLS = [
	"read",
	"write",
	"bash",
	"edit",
	"find",
	"grep",
];

function unique(values: Iterable<string>): string[] {
	return [...new Set(values)];
}

function extractExplicitSkills(prompt: string): string[] {
	const invokedSkills: string[] = [];
	const skillTagRegex = /<skill\s+name="([^"]+)"/g;
	let match: RegExpExecArray | null;
	while ((match = skillTagRegex.exec(prompt)) !== null) {
		invokedSkills.push(match[1]);
	}
	const skillCmdRegex = /\/skill:([a-zA-Z0-9_-]+)/g;
	while ((match = skillCmdRegex.exec(prompt)) !== null) {
		invokedSkills.push(match[1]);
	}
	return unique(invokedSkills);
}

function rewriteAvailableTools(
	prompt: string,
	activeTools: Set<string>,
	allTools: ReturnType<ExtensionAPI["getAllTools"]>,
): string {
	const activeLines = allTools
		.filter((t) => activeTools.has(t.name))
		.map((t) => `- ${t.name}: ${t.description.split("\n")[0].slice(0, 160)}`);

	const inactiveNames = allTools
		.filter((t) => !activeTools.has(t.name) && t.name !== REQUEST_CAPABILITIES_TOOL && t.name !== CALL_TOOL)
		.map((t) => t.name);

	const xmlStart = prompt.indexOf("<tools>");
	const xmlEnd = prompt.indexOf("</tools>");
	if (xmlStart !== -1 && xmlEnd !== -1) {
		let section = `<tools>\n${activeLines.join("\n")}`;
		if (inactiveNames.length > 0) {
			section += `\n\nInactive tools (names only; call ${CALL_TOOL} with its name and parameters to execute directly in 1 turn, or ${REQUEST_CAPABILITIES_TOOL} to activate):\n${inactiveNames.join(", ")}`;
		}
		section += `\n</tools>`;
		return prompt.slice(0, xmlStart) + section + prompt.slice(xmlEnd + "</tools>".length);
	}

	const start = prompt.indexOf("Available tools:\n");
	if (start !== -1) {
		const end = prompt.indexOf("\n\nGuidelines:", start);
		if (end !== -1) {
			let section = `Available tools:\n${activeLines.join("\n")}`;
			if (inactiveNames.length > 0) {
				section += `\n\nInactive tools (names only; call ${CALL_TOOL} with its name and parameters to execute directly in 1 turn, or ${REQUEST_CAPABILITIES_TOOL} to activate):\n${inactiveNames.join(", ")}`;
			}
			return prompt.slice(0, start) + section + prompt.slice(end);
		}
	}

	return prompt;
}

const DEFAULT_CORE_GUIDELINES = [
	"- Search Discipline: Use find for path search and grep / ast_grep_search for content search. NEVER use bash find, grep, cat, sed, head, or tail to search or inspect files.",
	"- File Reading: Use read to inspect files (specify offset and limit when dealing with large files).",
	"- File Editing: If replace is available (pi-hashline-edit-pro), use replace with unique line-hash anchors (remove_from, remove_to, replacement_lines) for surgical changes. If using edit, edits[].oldText must match uniquely and exactly. NEVER rewrite entire files.",
	"- File Creation: Use write only for brand new files or complete intended overwrites.",
	"- Long-Running Commands: For tasks that may take more than 5 seconds (builds, test suites, servers, heavy migrations), use bg_run and track progress with bg_status / bg_logs instead of blocking the main thread in bash.",
	"- Subagent Delegation: For complex, exploratory, or multi-perspective tasks, delegate to specialized subagents via the subagent tool:",
	"  • scout (fast local codebase reconnaissance, entry points, architecture & risk analysis)",
	"  • researcher (web/docs research with grounded citations)",
	"  • worker (focused code implementation & test verification)",
	"  • reviewer (rigorous code review, edge cases, test coverage)",
	"  • oracle (deep reasoning, architecture critique, challenging assumptions)",
	"  • delegate (general-purpose autonomous delegation)",
	"- Interactive Clarification: When requirements or designs are ambiguous, call ask_user_question to render structured options rather than guessing.",
	"- Inactive Tools: Any tool listed under Inactive tools can be called directly in a single turn via call_tool(tool, parameters) without prior activation.",
	"- Existing Script Black-Box Execution: For established CLI/automation scripts (e.g. in ego-script/, scripts/), read ONLY the header/usage comment (top 20-30 lines) or run --help. NEVER read entire implementation files or probe internal mechanics when CLI usage is documented. Execute directly.",
	"- Be concise in your responses and show file paths clearly.",
];

const DEFAULT_CONFIG: PromptDietConfig = {
	enabled: true,
	showNotices: true,
	toolResultScrubbing: {
		enabled: true,
		maxChars: 1200,
		keepRecentTurns: 2,
	},
	guidelines: {
		mode: "slim",
	},
	skills: {
		mode: "compress",
		maxDescriptionLength: 200,
	},
	packages: [],
	adaptive: {
		enabled: true,
		distillSkills: true,
		distillToolGuidelines: true,
	},
};

function normalizeName(name: string): string {
	const lower = name.toLowerCase();
	if (!lower.startsWith("npm:")) return lower.replace(/^git:/, "");

	const spec = lower.slice("npm:".length);
	if (!spec.startsWith("@")) return spec.split("@", 1)[0];

	const scopeSeparator = spec.indexOf("/");
	if (scopeSeparator === -1) return spec;
	const packageNameEnd = spec.indexOf("@", scopeSeparator + 1);
	return packageNameEnd === -1 ? spec : spec.slice(0, packageNameEnd);
}

function writeConfigFile(configPath: string, config: PromptDietConfig): void {
	const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(tempPath, JSON.stringify(config, null, 2), "utf8");
		renameSync(tempPath, configPath);
	} finally {
		rmSync(tempPath, { force: true });
	}
}

function mergeConfig(base: PromptDietConfig, next: PromptDietConfig): PromptDietConfig {
	return {
		...base,
		...next,
		showNotices: next.showNotices ?? base.showNotices,
		requiredTools: next.requiredTools ?? base.requiredTools,
		toolResultScrubbing: { ...base.toolResultScrubbing, ...(next.toolResultScrubbing || {}) },
		guidelines: { ...base.guidelines, ...(next.guidelines || {}) },
		skills: { ...base.skills, ...(next.skills || {}) },
		adaptive: { ...base.adaptive, ...(next.adaptive || {}) },
		packages: next.packages ?? base.packages,
	};
}

function loadConfig(cwd: string): PromptDietConfig {
	const userConfigDir = join(homedir(), ".pi", "agent");
	const userSettingsPath = join(userConfigDir, "settings.json");
	const primaryUserConfigPath = join(userConfigDir, "pi-prompt-diet.json");
	const legacyUserConfigPath = join(userConfigDir, "prompt-diet.json");

	const projectSettingsPath = join(cwd, ".pi", "settings.json");
	const projectConfigPath = join(cwd, ".pi", "pi-prompt-diet.json");
	const legacyProjectConfigPath = join(cwd, ".pi", "prompt-diet.json");

	let config: PromptDietConfig = structuredClone(DEFAULT_CONFIG);

	// 1. Read global settings.json
	if (existsSync(userSettingsPath)) {
		try {
			const parsed = JSON.parse(readFileSync(userSettingsPath, "utf8"));
			if (parsed && typeof parsed === "object") {
				const dietBlock = parsed.promptDiet || parsed["pi-prompt-diet"];
				if (dietBlock && typeof dietBlock === "object") {
					config = mergeConfig(config, dietBlock);
				}
			}
		} catch {}
	}

	// 2. Fallback to legacy standalone global files if present
	for (const p of [legacyUserConfigPath, primaryUserConfigPath]) {
		if (existsSync(p)) {
			try {
				config = mergeConfig(config, JSON.parse(readFileSync(p, "utf8")));
			} catch {}
		}
	}

	// 3. Project settings.json override (only if existing, never auto-created)
	if (existsSync(projectSettingsPath)) {
		try {
			const parsed = JSON.parse(readFileSync(projectSettingsPath, "utf8"));
			if (parsed && typeof parsed === "object") {
				const dietBlock = parsed.promptDiet || parsed["pi-prompt-diet"];
				if (dietBlock && typeof dietBlock === "object") {
					config = mergeConfig(config, dietBlock);
				}
			}
		} catch {}
	}

	// 4. Fallback to legacy standalone project files if present
	for (const p of [legacyProjectConfigPath, projectConfigPath]) {
		if (existsSync(p)) {
			try {
				config = mergeConfig(config, JSON.parse(readFileSync(p, "utf8")));
			} catch {}
		}
	}

	return config;
}

function formatSkillDescription(rawDesc: string, maxLen: number): string {
	const cleaned = rawDesc.trim().replace(/\n\s*/g, " ");
	const periodIdx = cleaned.search(/[.!?。！？](\s|$)/);
	let sentence = periodIdx !== -1 ? cleaned.slice(0, periodIdx + 1) : cleaned.split("\n")[0];

	if (sentence.length <= maxLen) {
		return sentence.trim();
	}

	let slice = sentence.slice(0, maxLen - 3);
	const lastSpace = slice.lastIndexOf(" ");
	if (lastSpace > maxLen * 0.7) {
		slice = slice.slice(0, lastSpace);
	}
	return `${slice.trim()}...`;
}

function matchSkillRule(skillPath: string, skillName: string, rules: string[]): "include" | "exclude" | "none" {
	const p = skillPath.replace(/\\/g, "/");
	for (const r of rules) {
		const isExclude = r.startsWith("-");
		const isInclude = r.startsWith("+");
		const pattern = (isExclude || isInclude ? r.slice(1) : r).trim();
		const cleanPattern = pattern.replace(/^\/+/, "");
		if (p.includes(cleanPattern) || skillName === cleanPattern || skillName.includes(cleanPattern)) {
			return isExclude ? "exclude" : "include";
		}
	}
	return "none";
}

function selectedCoreGuidelines(
	customCore: string[] | undefined,
	activeToolsOrHasSubagent: Set<string> | boolean = false,
): string[] {
	if (customCore) return customCore;

	if (typeof activeToolsOrHasSubagent === "boolean") {
		if (activeToolsOrHasSubagent) return DEFAULT_CORE_GUIDELINES;
		return DEFAULT_CORE_GUIDELINES.filter((g) => !g.startsWith("- Subagent Delegation:"));
	}

	const active = activeToolsOrHasSubagent;
	const lines: string[] = [];

	if (active.has("find") || active.has("grep") || active.has("ast_grep_search")) {
		lines.push("- Search Discipline: Use find for path search and grep / ast_grep_search for content search. NEVER use bash find, grep, cat, sed, head, or tail to search or inspect files.");
	}

	if (active.has("read")) {
		lines.push("- File Reading: Use read to inspect files (specify offset and limit when dealing with large files).");
	}

	if (active.has("replace")) {
		lines.push("- File Editing: If replace is available (pi-hashline-edit-pro), use replace with unique line-hash anchors (remove_from, remove_to, replacement_lines) for surgical changes. If using edit, edits[].oldText must match uniquely and exactly. NEVER rewrite entire files.");
	} else if (active.has("edit")) {
		lines.push("- File Editing: If using edit, edits[].oldText must match uniquely and exactly. NEVER rewrite entire files.");
	}

	if (active.has("write")) {
		lines.push("- File Creation: Use write only for brand new files or complete intended overwrites.");
	}

	if (active.has("bg_run")) {
		lines.push("- Long-Running Commands: For tasks that may take more than 5 seconds (builds, test suites, servers, heavy migrations), use bg_run and track progress with bg_status / bg_logs instead of blocking the main thread in bash.");
	}

	if (active.has("subagent")) {
		lines.push("- Subagent Delegation: For complex, exploratory, or multi-perspective tasks, delegate to specialized subagents via the subagent tool:");
		lines.push("  • scout (fast local codebase reconnaissance, entry points, architecture & risk analysis)");
		lines.push("  • researcher (web/docs research with grounded citations)");
		lines.push("  • worker (focused code implementation & test verification)");
		lines.push("  • reviewer (rigorous code review, edge cases, test coverage)");
		lines.push("  • oracle (deep reasoning, architecture critique, challenging assumptions)");
		lines.push("  • delegate (general-purpose autonomous delegation)");
	}

	if (active.has("ask_user_question")) {
		lines.push("- Interactive Clarification: When requirements or designs are ambiguous, call ask_user_question to render structured options rather than guessing.");
	}

	lines.push("- Inactive Tools: Any tool listed under Inactive tools can be called directly in a single turn via call_tool(tool, parameters) without prior activation.");
	lines.push("- Be concise in your responses and show file paths clearly.");

	return lines;
}

function truncateDescription(description: string, maxLength: number): string {
	const clean = description.trim().replace(/\s+/g, " ");
	if (clean.length <= maxLength) return clean;
	const slice = clean.slice(0, Math.max(1, maxLength - 3));
	const lastSpace = slice.lastIndexOf(" ");
	const boundary = lastSpace > maxLength * 0.7 ? lastSpace : slice.length;
	return `${slice.slice(0, boundary).trimEnd()}...`;
}

function normalizeReadPath(path: string, cwd: string): string {
	return resolve(cwd, path.replace(/^@/, ""));
}

export default function promptDiet(pi: ExtensionAPI) {
	if (process.env.PI_PROMPT_DIET_DISABLE === "1" || process.env.PI_PROMPT_DIET_DISABLE === "true") {
		return;
	}

	let skillCache = loadSkillCapsuleCache();
	let toolGuidelineCache = loadToolGuidelineCapsuleCache();
	const knownSkills = new Map<string, CapabilitySkill>();
	const pendingDistillation = new Set<string>();
	const pendingToolDistillation = new Set<string>();

	if (typeof (pi as any).registerTool === "function") {
		(pi as any).registerTool({
			name: CALL_TOOL,
			label: "Call Inactive Tool",
			description: "Directly invoke any registered tool (including inactive or extension tools) in a single turn without waiting for pre-activation. Supply the tool name and arguments.",
			promptSnippet: "Call any registered tool directly in one turn",
			parameters: {
				type: "object",
				properties: {
					tool: { type: "string", description: "The exact name of the tool to execute" },
					parameters: { type: "object", description: "Arguments/parameters to pass to the tool", additionalProperties: true },
				},
				required: ["tool", "parameters"],
				additionalProperties: false,
			} as any,
			async execute(toolCallId: string, params: { tool: string; parameters?: Record<string, unknown> }, signal: any, onUpdate: any, ctx: ExtensionContext) {
				const allTools = pi.getAllTools();
				const target = allTools.find((t) => t.name === params.tool);
				if (!target) {
					const inactiveNames = allTools.filter((t) => !pi.getActiveTools().includes(t.name)).map((t) => t.name);
					return {
						content: [{ type: "text", text: `Tool "${params.tool}" not found in registered tools. Available registered tools: ${inactiveNames.join(", ")}` }],
						isError: true,
					};
				}
				const currentActive = pi.getActiveTools();
				if (!currentActive.includes(params.tool)) {
					try {
						const newActive = unique([...currentActive, params.tool]);
						pi.setActiveTools(newActive);
						const sessionName = getSessionKey(ctx);
						const stats = getOrCreateSessionStats(sessionName);
						stats.activeTools = newActive;
						saveSessionState(sessionName, { activeTools: newActive });
						const config = loadConfig(ctx.cwd);
						if (config.showNotices !== false) {
							notifyDiet(ctx, `⚡ [pi-prompt-diet] 即时调用非活跃工具: ${params.tool}`, "info");
							updateDietStatus(ctx, `🌿 Diet: 即时激活 ${params.tool} (活跃 ${newActive.length})`);
							updateDietWidget(ctx, [
								`🌿 Prompt Diet: 工具即时激活`,
								`├─ 调用工具: ${params.tool} (call_tool 单轮直通)`,
								`├─ 活跃工具数: ${newActive.length}`,
								`└─ 状态: 已动态加载执行`,
							]);
						}
					} catch (e: any) {
						if (process.env.DEBUG) {
							console.error("[CallTool] Error activating tool:", e);
						}
					}
				}
				try {
					if (typeof (target as any).execute === "function") {
						return await (target as any).execute(toolCallId, params.parameters ?? {}, signal, onUpdate, ctx);
					}
					// If target is metadata-only (standard Pi getAllTools behavior), activate the tool and notify the agent
					return {
						content: [
							{
								type: "text",
								text: `⚡ [pi-prompt-diet] Tool "${params.tool}" has been successfully activated into your active tool set. You can now execute "${params.tool}" directly.`,
							},
						],
						isError: false,
					};
				} catch (err: any) {
					return {
						content: [{ type: "text", text: `Error calling tool "${params.tool}": ${err?.message || String(err)}` }],
						isError: true,
					};
				}
			},
		});

		(pi as any).registerTool({
			name: REQUEST_CAPABILITIES_TOOL,
			label: "Request Capabilities",
			description: "Dynamically activate an inactive tool or skill when required. Supplies full usage documentation immediately upon activation.",
			promptSnippet: "Activate additional registered tools or skills on demand",
			parameters: {
				type: "object",
				properties: {
					tools: { type: "array", items: { type: "string" }, description: "Tool names to activate" },
					skills: { type: "array", items: { type: "string" }, description: "Skill names to activate" },
					reason: { type: "string", description: "Why these capabilities are required" },
				},
				required: ["reason"],
				additionalProperties: false,
			} as any,
			async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
				const allTools = pi.getAllTools();
				const current = pi.getActiveTools();
				const requestedTools = unique((params.tools ?? []) as string[]);
				const requestedSkills = unique((params.skills ?? []) as string[]);

				const addedTools = requestedTools.filter((t) => allTools.some((at) => at.name === t) && !current.includes(t));
				if (addedTools.length > 0) {
					const newActive = unique([...current, ...addedTools, CALL_TOOL, REQUEST_CAPABILITIES_TOOL]);
					pi.setActiveTools(newActive);
					const sessionName = getSessionKey(_ctx);
					const stats = getOrCreateSessionStats(sessionName);
					stats.activeTools = newActive;
					if (requestedSkills.length > 0) {
						stats.activeSkills = unique([...(stats.activeSkills || []), ...requestedSkills]);
					}
					saveSessionState(sessionName, {
						activeTools: newActive,
						activeSkills: stats.activeSkills,
					});
				}

				if (addedTools.length > 0 || requestedSkills.length > 0) {
					const config = loadConfig(_ctx.cwd);
					if (config.showNotices !== false) {
						const caps: string[] = [];
						if (addedTools.length > 0) caps.push(`工具 [${addedTools.join(", ")}]`);
						if (requestedSkills.length > 0) caps.push(`技能 [${requestedSkills.join(", ")}]`);
						notifyDiet(_ctx, `⚡ [pi-prompt-diet] 按需激活: ${caps.join("，")}`, "info");
						const desc = addedTools.length > 0 ? `工具: ${addedTools.join(", ")}` : `技能: ${requestedSkills.join(", ")}`;
						updateDietStatus(_ctx, `🌿 Diet: 按需激活 ${desc}`);
						updateDietWidget(_ctx, [
							`🌿 Prompt Diet: 能力按需激活`,
							...(addedTools.length > 0 ? [`├─ 新增工具: ${addedTools.join(", ")}`] : []),
							...(requestedSkills.length > 0 ? [`├─ 新增技能: ${requestedSkills.join(", ")}`] : []),
							`├─ 原因说明: ${params.reason || "无"}`,
							`└─ 状态: 完整文档已按需注入`,
						]);
					}
				}

				const toolDocs = allTools
					.filter((t) => addedTools.includes(t.name))
					.map((t) => `### Tool: ${t.name}\n${t.description}`);

				const skillDocs = [...knownSkills.values()]
					.filter((s) => requestedSkills.includes(s.name))
					.map((s) => `### Skill: ${s.name}\nPath: ${s.filePath}\nDescription: ${s.description}`);

				const responseBlocks: string[] = [];
				if (toolDocs.length > 0) {
					responseBlocks.push(`Activated Tools with full instructions:\n${toolDocs.join("\n\n")}`);
				}
				if (skillDocs.length > 0) {
					responseBlocks.push(`Activated Skills with instructions:\n${skillDocs.join("\n\n")}`);
				}
				if (responseBlocks.length === 0) {
					responseBlocks.push("No new tools or skills needed activation (already active or not found).");
				}

				return {
					content: [{ type: "text", text: responseBlocks.join("\n\n") }],
					details: { addedTools, addedSkills: requestedSkills },
				};
			},
		});
	}

function maskSessionId(id: string): string {
	if (!id || id.length <= 10) return id;
	return `${id.slice(0, 6)}***${id.slice(-4)}`;
}

	if (typeof (pi as any).registerCommand === "function") {
		const commandDef = {
			description: "Inspect Prompt Diet status, active tools, and saved tokens",
			handler: async (_args: string, _ctx: ExtensionContext) => {
				const allTools = pi.getAllTools();
				const activeTools = pi.getActiveTools();
				const inactiveTools = allTools.filter((t) => !activeTools.includes(t.name) && t.name !== REQUEST_CAPABILITIES_TOOL && t.name !== CALL_TOOL);
				const skillCapsulesCount = Object.keys(skillCache.skills).length;
				const toolCapsulesCount = Object.keys(toolGuidelineCache.tools).length;
				const sessionKey = getSessionKey(_ctx);
				const stats = getOrCreateSessionStats(sessionKey);

				const lines = [
					"=== pi-prompt-diet Status ===",
					`• Session: ${maskSessionId(sessionKey)}`,
					`• Total Tools: ${allTools.length} (${activeTools.length} active, ${inactiveTools.length} on-demand)`,
					`• Active Tools: ${activeTools.join(", ")}`,
				];
				if (inactiveTools.length > 0) {
					lines.push(`• On-demand Tools: ${inactiveTools.map((t) => t.name).join(", ")}`);
				}
				lines.push(`• Known Skills: ${knownSkills.size}`);
				if (stats && stats.promptInitialChars > 0) {
					const saved = stats.promptInitialChars - stats.promptSlimmedChars;
					if (saved > 0) {
						const pct = Math.round((saved / stats.promptInitialChars) * 100);
						lines.push(`• System Prompt: ${(stats.promptInitialChars / 1024).toFixed(1)}KB ➔ ${(stats.promptSlimmedChars / 1024).toFixed(1)}KB (-${pct}%, ~${Math.round(saved / 4)} tokens saved)`);
					} else {
						lines.push(`• System Prompt: ${(stats.promptSlimmedChars / 1024).toFixed(1)}KB`);
					}
				}
				if (stats && stats.scrubbedSavedChars > 0) {
					lines.push(`• Scrubbed Tool Results: ${stats.scrubbedToolResultsCount} items, ${(stats.scrubbedSavedChars / 1024).toFixed(1)}KB saved (~${Math.round(stats.scrubbedSavedChars / 4)} tokens)`);
				}
				const globalStats = loadGlobalStats();
				if (globalStats && globalStats.totals.totalCharsSaved > 0) {
					lines.push(`• Global Cumulative Saved: ${(globalStats.totals.totalCharsSaved / 1024).toFixed(1)}KB (~${globalStats.totals.totalTokensSaved} tokens across ${globalStats.totals.totalRounds} turns)`);
				}
				lines.push(
					`• Skill Capsules in Cache: ${skillCapsulesCount}`,
					`• Tool Guideline Capsules in Cache: ${toolCapsulesCount}`,
					"==============================",
				);
				const output = lines.join("\n");
				if ((_ctx as any).ui?.notify) {
					(_ctx as any).ui.notify(output);
				} else {
					console.log(output);
				}
				return output;
			},
		};
		(pi as any).registerCommand("pi-prompt-diet", commandDef);
	}

	pi.on("session_start", (_event, _ctx) => {
		skillCache = loadSkillCapsuleCache();
		toolGuidelineCache = loadToolGuidelineCapsuleCache();
		knownSkills.clear();
		pendingDistillation.clear();
		pendingToolDistillation.clear();
		const sessionKey = getSessionKey(_ctx);
		if (_event.reason === "new") {
			sessionStatsMap.delete(sessionKey);
		}
		updateDietStatus(_ctx, "🌿 Diet: 监听中 (基线)");
		updateDietWidget(_ctx, [
			"🌿 Prompt Diet (提示词与上下文精简)",
			"├─ 基线工具: read, write, bash, edit (按需激活高级工具)",
			"├─ 提示词瘦身: 动态精简系统指引与技能规则",
			"└─ 状态: 会话已就绪"
		]);
	});

	pi.on("context", async (event, _ctx) => {
		const cwd = _ctx.cwd || process.cwd();
		const config = loadConfig(cwd);
		if (config.enabled === false) return { messages: event.messages };

		let currentMessages = event.messages;

		// ── 0. Step Card Context Isolation (确保所有自定义步骤卡片不渗入大模型上下文，0 Token 泄漏) ──
		if (Array.isArray(currentMessages)) {
			currentMessages = currentMessages.filter((m: any) => {
				if (m.role === "custom") return false;
				if (typeof m.customType === "string" && (
					m.customType.startsWith("prompt-diet:") ||
					m.customType.startsWith("distill:") ||
					m.customType.startsWith("supervisor:")
				)) return false;
				return true;
			});
		}

		// ── 1. Tool Result Scrubbing (历史工具超大输出阶梯分块衰减，保护 KV Cache) ─────────
		const scrubConfig = config.toolResultScrubbing ?? {};
		if (scrubConfig.enabled !== false && Array.isArray(currentMessages)) {
			const keepTurns = scrubConfig.keepRecentTurns ?? 2;
			const safeWindowCount = Math.max(4, keepTurns * 2 + 2);
			const maxChars = scrubConfig.maxChars ?? 1200;

			// 阶梯式稳定边界（Chunk-aligned Step Boundary）：
			// 普通滑动窗口会在每一步都往前移动 1~2 条，导致历史前缀逐轮变动、KV Cache 全量穿透。
			// 采用阶梯步长 (stepBlock = 6)，使得连续多个回合内边界保持绝对静止，保护大模型 Prompt Cache 前缀。
			const unfreezedCount = currentMessages.length - safeWindowCount;
			const stepBlock = 6;
			const scrubBoundary = unfreezedCount <= 0
				? 0
				: (unfreezedCount <= stepBlock ? unfreezedCount : Math.floor(unfreezedCount / stepBlock) * stepBlock);

			let scrubbedCount = 0;
			let savedChars = 0;

			currentMessages = currentMessages.map((m: any, idx: number) => {
				if (idx >= scrubBoundary) return m;
				if (m.role !== "toolResult" || m.isError) return m;

				if (Array.isArray(m.content)) {
					let messageModified = false;
					const newContent = m.content.map((c: any) => {
						if (c && c.type === "text" && typeof c.text === "string" && c.text.length > maxChars) {
							const originalLength = c.text.length;
							const lines = c.text.split("\n");
							if (lines.length > 8) {
								const head = lines.slice(0, 6).join("\n");
								const tail = lines.slice(-2).join("\n");
								const omittedLines = lines.length - 8;
								const notice = `\n\n... [pi-prompt-diet: ${omittedLines} lines (~${originalLength - head.length - tail.length} chars) of historical ${m.toolName || "tool"} output scrubbed to preserve context; call ${m.toolName || "tool"} to re-inspect if needed] ...\n\n`;
								const scrubbedText = head + notice + tail;
								scrubbedCount++;
								savedChars += (originalLength - scrubbedText.length);
								messageModified = true;
								return { ...c, text: scrubbedText };
							} else {
								const head = c.text.slice(0, 600);
								const tail = c.text.slice(-200);
								const notice = `\n\n... [pi-prompt-diet: ~${originalLength - head.length - tail.length} chars of historical ${m.toolName || "tool"} output scrubbed to preserve context; call ${m.toolName || "tool"} to re-inspect if needed] ...\n\n`;
								const scrubbedText = head + notice + tail;
								scrubbedCount++;
								savedChars += (originalLength - scrubbedText.length);
								messageModified = true;
								return { ...c, text: scrubbedText };
							}
						}
						return c;
					});
					return messageModified ? { ...m, content: newContent } : m;
				} else if (typeof m.content === "string" && m.content.length > maxChars) {
					const originalLength = m.content.length;
					const lines = m.content.split("\n");
					if (lines.length > 8) {
						const head = lines.slice(0, 6).join("\n");
						const tail = lines.slice(-2).join("\n");
						const omittedLines = lines.length - 8;
						const notice = `\n\n... [pi-prompt-diet: ${omittedLines} lines (~${originalLength - head.length - tail.length} chars) of historical ${m.toolName || "tool"} output scrubbed to preserve context; call ${m.toolName || "tool"} to re-inspect if needed] ...\n\n`;
						const scrubbedText = head + notice + tail;
						scrubbedCount++;
						savedChars += (originalLength - scrubbedText.length);
						return { ...m, content: scrubbedText };
					} else {
						const head = m.content.slice(0, 600);
						const tail = m.content.slice(-200);
						const notice = `\n\n... [pi-prompt-diet: ~${originalLength - head.length - tail.length} chars of historical ${m.toolName || "tool"} output scrubbed to preserve context; call ${m.toolName || "tool"} to re-inspect if needed] ...\n\n`;
						const scrubbedText = head + notice + tail;
						scrubbedCount++;
						savedChars += (originalLength - scrubbedText.length);
						return { ...m, content: scrubbedText };
					}
				}
				return m;
			});

			if (scrubbedCount > 0) {
				const sessionName = getSessionKey(_ctx);
				const stats = getOrCreateSessionStats(sessionName);
				stats.scrubbedToolResultsCount += scrubbedCount;
				stats.scrubbedSavedChars += savedChars;

				recordStatsDelta({
					scrubbedToolResultsCount: scrubbedCount,
					scrubbedSavedChars: savedChars,
				});

				saveSessionState(sessionName, {
					scrubbedToolResultsCount: stats.scrubbedToolResultsCount,
					scrubbedSavedChars: stats.scrubbedSavedChars,
				});

				const promptPercent = stats.promptInitialChars > 0
					? Math.round(((stats.promptInitialChars - stats.promptSlimmedChars) / stats.promptInitialChars) * 100)
					: 0;
				const totalScrubbedKb = (stats.scrubbedSavedChars / 1024).toFixed(0);
				const statusText = promptPercent > 0
					? `🌿 Diet: -${promptPercent}% | 🧹 累计省 ${totalScrubbedKb}KB`
					: (stats.promptSlimmedChars > 0
						? `🌿 Diet: ${(stats.promptSlimmedChars / 1024).toFixed(1)}KB | 🧹 累计省 ${totalScrubbedKb}KB`
						: `🌿 Diet | 🧹 累计省 ${totalScrubbedKb}KB`);
				updateDietStatus(_ctx, statusText);

				const widgetLines = [
					`🌿 Prompt Diet: 历史工具超大输出阶梯衰减`,
					`├─ 本轮削减: ${scrubbedCount} 条超大输出 (衰减 ${(savedChars / 1024).toFixed(1)}KB)`,
					`├─ 累计瘦身: ${totalScrubbedKb}KB (${stats.scrubbedToolResultsCount} 条历史记录已裁剪)`,
				];
				if (stats.promptSlimmedChars > 0) {
					widgetLines.push(`├─ 提示词基线: ${(stats.promptSlimmedChars / 1024).toFixed(1)}KB (-${promptPercent}%)`);
				}
				widgetLines.push(`└─ 状态: 阶梯式静止边界对齐，KV Cache 保护已生效`);
				updateDietWidget(_ctx, widgetLines);
			}
		}

		// ── 2. Preflight 语义意图注入 (<system_directive>) ─────────────────
		const sessionName = getSessionKey(_ctx);
		const hint = turnRoutingHints.get(sessionName);
		if (!hint) return { messages: currentMessages };

		const lastUserIdx = currentMessages.findLastIndex((m: any) => m && m.role === "user");
		if (lastUserIdx === -1) return { messages: currentMessages };

		const lastUser = currentMessages[lastUserIdx];
		if (!Array.isArray(lastUser.content)) return { messages: currentMessages };

		const textIdx = lastUser.content.findIndex((c: any) => c && c.type === "text" && typeof c.text === "string");
		if (textIdx === -1) return { messages: currentMessages };

		const textBlock = lastUser.content[textIdx];
		if (textBlock.text.startsWith("<system_directive>")) {
			return { messages: currentMessages };
		}

		const newContent = [...lastUser.content];
		newContent[textIdx] = {
			...textBlock,
			text: `<system_directive>${hint}</system_directive>\n\n${textBlock.text}`,
		};

		const finalMessages = [...currentMessages];
		finalMessages[lastUserIdx] = { ...lastUser, content: newContent };
		return { messages: finalMessages };
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.isError) return;
		if (event.toolName === "read" && typeof event.input.path === "string") {
			const skill = knownSkills.get(normalizeReadPath(event.input.path, ctx.cwd));
			if (skill && !getValidSkillCapsule(skillCache, skill)) pendingDistillation.add(skill.filePath);
		}
		const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName) as CapabilityTool | undefined;
		if (tool && tool.sourceInfo?.source && tool.sourceInfo.source !== "builtin" && tool.sourceInfo.source !== "sdk" && (tool.promptGuidelines?.length ?? 0) > 0 && !getValidToolGuidelineCapsule(toolGuidelineCache, tool)) {
			pendingToolDistillation.add(tool.name);
		}
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (pendingDistillation.size === 0 && pendingToolDistillation.size === 0) return;
		const config = loadConfig(ctx.cwd);
		if (config.enabled === false || config.adaptive?.enabled === false) {
			pendingDistillation.clear();
			pendingToolDistillation.clear();
			return;
		}
		if (config.adaptive?.distillSkills !== false) {
			const pending = [...pendingDistillation];
			pendingDistillation.clear();
			for (const filePath of pending) {
				const skill = knownSkills.get(resolve(filePath));
				if (!skill || getValidSkillCapsule(skillCache, skill)) continue;
				try {
					const capsule = await distillSkill(ctx, config.adaptive ?? {}, skill);
					if (capsule) {
						skillCache.skills[skill.filePath] = capsule;
						saveSkillCapsule(skillCache, skill.filePath, capsule.fingerprint);
						emitDietStepMessage(pi, ctx, "prompt-diet:capsule", [
							`### 🌿 技能胶囊已沉淀 (\`${skill.name}\`)`,
							`- **核心规则**: ${capsule.essentialRules.length} 条约束`,
							`- **激活意图**: ${capsule.trigger}`,
							`- **完整加载条件**: ${capsule.readFullWhen}`,
						].join("\n"), {
							skill: skill.name,
							essentialRules: capsule.essentialRules,
							trigger: capsule.trigger,
							readFullWhen: capsule.readFullWhen,
							timestamp: new Date().toISOString(),
						});
						if (config.showNotices !== false) {
							notifyDiet(ctx, `✨ [pi-prompt-diet] 技能胶囊已蒸馏沉淀: ${skill.name} (${capsule.essentialRules.length} 条核心约束)`, "info");
							updateDietStatus(ctx, `🌿 Diet: 技能胶囊已沉淀 (${skill.name})`);
							updateDietWidget(ctx, [
								`🌿 Prompt Diet: 技能胶囊沉淀`,
								`├─ 技能名称: ${skill.name}`,
								`├─ 核心规则: ${capsule.essentialRules.length} 条`,
								`└─ 状态: 胶囊已持久化`,
							]);
						}
					}
				} catch (error) {
					console.warn(`[pi-prompt-diet] Failed to distill ${skill.name}:`, error);
				}
			}
		} else {
			pendingDistillation.clear();
		}
		if (config.adaptive?.distillToolGuidelines !== false) {
			const pendingTools = [...pendingToolDistillation];
			pendingToolDistillation.clear();
			for (const toolName of pendingTools) {
				const tool = pi.getAllTools().find((candidate) => candidate.name === toolName) as CapabilityTool | undefined;
				if (!tool || getValidToolGuidelineCapsule(toolGuidelineCache, tool)) continue;
				try {
					const capsule = await distillToolGuidelines(ctx, config.adaptive ?? {}, tool);
					if (!capsule) continue;
					const key = `${capsule.source}:${capsule.name}`;
					toolGuidelineCache.tools[key] = capsule;
					saveToolGuidelineCapsule(toolGuidelineCache, key, tool);
					const count = capsule.mode === "capsule" ? `${capsule.essentialRules.length} 条准则` : "保留完整";
					emitDietStepMessage(pi, ctx, "prompt-diet:capsule", [
						`### 🌿 工具准则胶囊已沉淀 (\`${tool.name}\`)`,
						`- **沉淀模式**: \`${capsule.mode}\``,
						`- **核心约束**: ${count}`,
					].join("\n"), {
						tool: tool.name,
						mode: capsule.mode,
						essentialRules: capsule.mode === "capsule" ? capsule.essentialRules : [],
						timestamp: new Date().toISOString(),
					});
					if (config.showNotices !== false) {
						notifyDiet(ctx, `✨ [pi-prompt-diet] 工具准则已蒸馏沉淀: ${tool.name} (${count})`, "info");
						updateDietStatus(ctx, `🌿 Diet: 工具准则已沉淀 (${tool.name})`);
						updateDietWidget(ctx, [
							`🌿 Prompt Diet: 工具准则胶囊沉淀`,
							`├─ 工具名称: ${tool.name}`,
							`├─ 模式: ${count}`,
							`└─ 状态: 胶囊已持久化`,
						]);
					}
				} catch (error) {
					console.warn(`[pi-prompt-diet] Failed to distill guidelines for ${tool.name}:`, error);
				}
			}
		} else {
			pendingToolDistillation.clear();
		}
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		const cwd = _ctx.cwd || process.cwd();
		const config = loadConfig(cwd);
		if (process.env.DEBUG) {
			console.error("[Diet] loaded config:", JSON.stringify(config.adaptive));
		}

		if (config.enabled === false) return undefined;

		const allTools = pi.getAllTools();
		const rawSkills = (event.systemPromptOptions?.skills || [])
			.filter((skill) => !skill.disableModelInvocation)
			.map((skill) => ({ name: skill.name, description: skill.description || "", filePath: skill.filePath }));
		knownSkills.clear();
		for (const skill of rawSkills) knownSkills.set(resolve(skill.filePath), skill);

		const initialPromptLength = event.systemPrompt.length;
		let prompt = event.systemPrompt;

		// ── 构建 packages 覆盖映射表 ─────────────────────────────────────────
		const overrides = new Map<string, PackageOverrideConfig>();
		if (Array.isArray(config.packages)) {
			for (const item of config.packages) {
				if (item && typeof item === "object" && typeof item.source === "string") {
					const norm = normalizeName(item.source);
					overrides.set(norm, item);
					if (norm.includes("/")) {
						overrides.set(norm.split("/").pop()!, item);
					}
				}
			}
		}

		// ── 1. 检查并提取系统文档资源（以通用 XML/标题正则匹配，严禁硬编码语言词汇） ──────
		const docsMatch = prompt.match(/(?:<docs>[\s\S]*?<\/docs>|Pi documentation[\s\S]*?(?=\n\n[<#]|$))/);
		const rawDocsBlock = docsMatch ? docsMatch[0] : "";

		// ── 3. Soft Routing Preflight (Semantic Intent Router) ───────────
		const sessionName = getSessionKey(_ctx);
		turnRoutingHints.delete(sessionName); // clear previous turn's hint
		
		let routedTools: string[] = [];
		let routedSkills: string[] = [];
		let needDocs = false;
		let preflightSucceeded = false;

		// Skip pure continuations heuristically to save preflight costs
		const isContinuation = /^(continue|go on|ok|go|ok go|go ahead|proceed|next|next step|yes|y|继续|继续做|继续吧|好的|可以|收到|下一步|推进下一步|继续下一步|再试一次|继续执行|继续优化|继续排查|继续推进|好的继续|可以继续)(\s*(做|看|排查|优化|执行|推进|吧|一下|测试|验证))?$/i.test(event.prompt.trim().replace(/[。.!！,， ]+$/, ""));
		if (isContinuation) {
			preflightSucceeded = true;
			const lastStats = sessionStatsMap.get(sessionName) || loadSessionState(sessionName);
			if (lastStats?.activeTools && lastStats.activeTools.length > 0) {
				routedTools = lastStats.activeTools.filter((t: string) => t !== REQUEST_CAPABILITIES_TOOL && t !== CALL_TOOL);
			} else if (typeof (pi as any).getActiveTools === "function") {
				routedTools = (pi as any).getActiveTools().filter((t: string) => t !== REQUEST_CAPABILITIES_TOOL && t !== CALL_TOOL);
			} else {
				routedTools = allTools.map((t) => t.name);
			}
			routedSkills = lastStats?.activeSkills ?? [];
			needDocs = lastStats?.needDocs ?? false;

			const globalContracts = ((globalThis as any).__PI_TASK_CONTRACTS__ =
				(globalThis as any).__PI_TASK_CONTRACTS__ || new Map<string, TaskContract>());
			const existingContract = globalContracts.get(sessionName);
			if (existingContract) {
				globalContracts.set(sessionName, {
					...existingContract,
					source: "continuation",
					updatedAt: Date.now(),
				});
			}

			const contCardLines = [
				`### ⏩ 任务顺延 (Continuation)`,
				`- **判定**: 检测到顺延推进指令，已复用既定意图与能力路由（跳过重复预检，节省 Token）`,
				`- **承接意图**: \`${existingContract ? existingContract.intent.toUpperCase() : "EXECUTION"}\` (${existingContract?.allow_write !== false ? "允许代码修改" : "纯分析/只读"})`,
				`- **活跃工具**: ${routedTools.length > 0 ? routedTools.map((t) => `\`${t}\``).join(", ") : "无"}`,
				`- **活跃技能**: ${routedSkills.length > 0 ? routedSkills.map((s) => `\`${s}\``).join(", ") : "无"}`,
			];
			emitDietStepMessage(pi, _ctx, "prompt-diet:continuation", contCardLines.join("\n"), {
				isContinuation: true,
				prompt: event.prompt,
				routedTools,
				routedSkills,
				needDocs,
				contract: existingContract,
				timestamp: new Date().toISOString(),
			});
		} else if (config.adaptive?.softRouting !== false && event.prompt.trim() !== "") {
			try {
				const preflightModelStr = config.adaptive?.preflightModel || "CPA/gemini-3.5-flash-lite";
				let preflightModel = _ctx.model;
				if (preflightModelStr) {
					const separator = preflightModelStr.indexOf("/");
					if (separator > 0) {
						const prov = preflightModelStr.slice(0, separator);
						const mId = preflightModelStr.slice(separator + 1);
						preflightModel = _ctx.modelRegistry.find(prov, mId);
						if (!preflightModel) {
							try {
								const all = _ctx.modelRegistry.getAll?.() ?? [];
								preflightModel = all.find(
									(m: any) => m && m.provider && m.provider.toLowerCase() === prov.toLowerCase() && m.id === mId
								);
							} catch (e: any) {
								if (process.env.DEBUG) {
									console.error("[Preflight] Error finding model:", e);
								}
							}
						}
						preflightModel = preflightModel || _ctx.model;
					}
				}
				
				if (preflightModel && _ctx.modelRegistry.hasConfiguredAuth(preflightModel)) {
					const catalog = {
						tools: allTools
							.map((t) => ({ name: t.name, description: compactCatalogDescription(t.description, 200) }))
							.sort((a, b) => a.name.localeCompare(b.name)),
						skills: rawSkills
							.map((s) => ({ name: s.name, description: compactCatalogDescription(s.description, 200) }))
							.sort((a, b) => a.name.localeCompare(b.name)),
					};
					const systemAnalysisPrompt = `You are an elite pre-flight intent analyzer and task contract architect for an AI coding agent.
Analyze the user's latest request and context, then return ONLY a JSON object with this exact shape:
{
  "intent": "analytical" | "execution" | "composite",
  "allow_write": boolean,
  "reason": string,
  "clarified_intent": string,
  "typo_corrections": string[],
  "protected_terms": string[],
  "focus_skills": string[],
  "focus_tools": string[],
  "need_docs": boolean
}

CRITICAL RULES:
1. "intent" and "allow_write":
   - "analytical": The user asks to inspect, check, review, compare, investigate, find, analyze, or explain WITHOUT asking to modify code. Examples: "检查...", "看看...", "排查...", "分析...", "为什么...", "check...", "inspect...", "review...". In analytical mode, "allow_write" MUST be false. Modifying files (edit/write) is strictly forbidden.
   - "execution": The user explicitly asks to modify, create, fix, refactor, implement, or delete code/files. "allow_write" is true.
   - "composite": The user gives a multi-stage task (e.g. "first check X, then if Y fix Z"). "allow_write" is true only if modification is needed.
2. "reason":
   - A short, 1-sentence explanation of the task classification.
3. "clarified_intent":
   - A concise, normalized statement of what the user is actually asking for, written in the user's language. Correct any typos, colloquialisms, or ambiguous phrasing into a clear operational intent.
4. "typo_corrections":
   - List any suspected typos, phonetically mistyped words, or slip-of-the-pen in the user's message and their corrected forms (e.g. ["plgu -> plug", "dcoment -> document"]). If none, return []. NEVER treat terms in "protected_terms" as typos.
5. "protected_terms":
   - Extract all domain jargon, package/tool names, identifiers, custom terms, or unusual proper nouns present in the request or context (e.g., "nowledge-mem", "pi-hashline-edit-pro", repo names, unique variables). The agent must NEVER treat these as typos or misspellings.
6. "focus_tools" & "focus_skills":
   - Select the minimal subset from the catalog needed for this task.

SPECIAL MEMORY & REPRODUCTION RULE:
If the user's request explicitly or implicitly references past work, historical configurations, prior discussions, reproduction, or recurring operations (e.g., words like '重新', '再次', '重跑', '复现', '更新', '像上次一样', '之前', '上次', '记得', '以前', '曾经', 'earlier', 'again', 're-run', 'reproduce', 'we configured', 'last time'), you MUST include 'search-memory' and/or 'nowledge-mem' in focus_skills / focus_tools if present in the catalog, to retrieve past working procedures and parameters.

SPECIAL BROWSER & AUTOMATION RULE:
If the user's task mentions browser operations, web pages, browser profiles, or UI interaction (e.g., '浏览器', '网页', 'profile', 'profiles', 'browser', 'GUI', 'desktop'), include relevant browser/automation skills (e.g., 'ego-browser', 'cua-driver') if present in the catalog.

SPECIAL SUBAGENT RULE:
If the user's task involves delegation, code review, secondary opinions, deep reconnaissance, multi-agent workflows, or mentions subagent roles ('subagent', 'scout', 'reviewer', 'worker', 'oracle', 'delegate', 'review', '审查', '第二意见', '子代理'), you MUST include 'subagent' in focus_tools if present in the catalog.

SPECIAL SEARCH & DISCOVERY RULE:
If the task involves finding files, locating code symbols, AST searching, inspecting existing scripts, or grepping ('find', 'grep', 'search', '定位', '查找', '搜', '脚本', '现成', '已有'), include 'find', 'grep', 'ast_grep_search', and/or 'symbol_search' in focus_tools if present in the catalog.

SPECIAL BACKGROUND TASKS RULE:
If the task involves running servers, background jobs, test suites, builds, or long-running processes ('bg_run', 'background', '后台', '长命令', '启动服务'), include 'bg_run' and/or 'bg_status' in focus_tools if present in the catalog.

SPECIAL DOCS RULE:
If the user's task asks about or involves the Pi coding agent framework itself (e.g. its SDK, extensions, themes, skills, CLI flags, internal APIs, or subprocess testing), set need_docs to true. Otherwise set need_docs to false.`;
					
					let memoryContext = "";
					const memMatch = event.systemPrompt.match(/## Nowledge Mem Context Bundle[\s\S]*?(?=\n<|$)/i);
					if (memMatch) {
						const trimmedMem = memMatch[0].trim();
						const compactMem = trimmedMem.length > 1500 ? truncateHeadTail(trimmedMem, 1500, 0.4) : trimmedMem;
						memoryContext = `\n\n【PERSISTENT MEMORY CONTEXT】:\n${compactMem}`;
					}

					let recentHistory = "";
					try {
						const history = _ctx.sessionManager?.buildSessionContext?.()?.messages || [];
						
						// Elastic History Depth based on user's prompt length (Balanced context for routing)
						const promptLen = event.prompt.trim().length;
						let historyDepth = 6; // <= 50 chars: short follow-up, keep 3 turns
						if (promptLen > 500) {
							historyDepth = 4; // > 500 chars: large input, keep 2 turns
						} else if (promptLen > 50) {
							historyDepth = 5; // 50-500 chars: standard request, keep ~2.5 turns
						}

						const recent = history.filter((m: any) => m.role === "user" || (m.role === "assistant" && (!m.content || m.content.some((c: any) => c.type === "text")))).slice(-historyDepth);
						if (recent.length > 0) {
							recentHistory = `\n\n【RECENT CONVERSATION HISTORY】:\n` + recent.map((m: any) => {
								let text = m.content?.find((c: any) => c.type === "text")?.text || "(No text)";
								const maxLength = m.role === "user" ? 800 : 800;
								// 头部意图 + 尾部最新报错/补充 截取策略
								const truncated = truncateHeadTail(text, maxLength, 0.45);
								return `${m.role.toUpperCase()}: ${truncated}`;
							}).join("\n\n");
						}
					} catch (_e) {
						// ignore history extraction errors
					}

					const promptForAnalysis = truncateHeadTail(event.prompt, 3500, 0.4);
					const userAnalysisPrompt = `CATALOG:\n${JSON.stringify(catalog, null, 2)}${memoryContext}${recentHistory}\n\n【USER LATEST REQUEST】:\n${promptForAnalysis}`;
					
					const response = await completeJson(
						_ctx,
						{ ...(config.adaptive ?? {}), model: preflightModelStr ?? config.adaptive?.model },
						systemAnalysisPrompt,
						userAnalysisPrompt,
						800
					);
					if (process.env.DEBUG) {
						console.error("[Preflight] Response:", response);
					}
					
					if (response && (Array.isArray(response.focus_tools) || Array.isArray(response.focus_skills) || typeof response.intent === "string")) {
						preflightSucceeded = true;
						if (Array.isArray(response.focus_tools)) {
							routedTools = (response.focus_tools as string[]).filter((t) => allTools.some((at) => at.name === t));
						}
						if (Array.isArray(response.focus_skills)) {
							routedSkills = (response.focus_skills as string[]).filter((s) => rawSkills.some((as) => as.name === s));
						}
						if (typeof response.need_docs === "boolean") {
							needDocs = response.need_docs;
						}

						const intent = (typeof response.intent === "string" && ["analytical", "execution", "composite"].includes(response.intent))
							? (response.intent as "analytical" | "execution" | "composite")
							: (response.allow_write === false ? "analytical" : "execution");

						const allow_write = typeof response.allow_write === "boolean"
							? response.allow_write
							: (intent !== "analytical");

						const protected_terms = Array.isArray(response.protected_terms)
							? (response.protected_terms as string[]).filter((t) => typeof t === "string" && t.trim().length > 0)
							: [];

						const clarified_intent = typeof response.clarified_intent === "string" ? response.clarified_intent.trim() : "";
						const typo_corrections = Array.isArray(response.typo_corrections)
							? (response.typo_corrections as string[]).filter((t) => typeof t === "string" && t.trim().length > 0)
							: [];

						const contract: TaskContract = {
							intent,
							allow_write,
							reason: typeof response.reason === "string" ? response.reason : "",
							clarified_intent,
							typo_corrections,
							protected_terms,
							focus_tools: routedTools,
							focus_skills: routedSkills,
							need_docs: needDocs,
							source: "preflight",
							updatedAt: Date.now(),
						};

						const globalContracts = ((globalThis as any).__PI_TASK_CONTRACTS__ =
							(globalThis as any).__PI_TASK_CONTRACTS__ || new Map<string, TaskContract>());
						globalContracts.set(sessionName, contract);

						const focusSkillsStr = routedSkills.slice(0, 5).join(", ");
						const focusToolsStr = routedTools.slice(0, 5).join(", ");
						const hintParts = [];
						if (focusSkillsStr) hintParts.push(`skills: [${focusSkillsStr}]`);
						if (focusToolsStr) hintParts.push(`tools: [${focusToolsStr}]`);
						if (needDocs) hintParts.push(`docs: [Pi Framework Docs]`);
						
						let contractHint = `[Task Contract: ${intent.toUpperCase()}${allow_write ? " | WRITE ALLOWED" : " | READ-ONLY (NO WRITES)"}]`;
						if (clarified_intent) {
							contractHint += ` Clarified user intent: "${clarified_intent}".`;
						}
						if (typo_corrections.length > 0) {
							contractHint += ` Typo corrections: [${typo_corrections.join(", ")}].`;
						}
						if (protected_terms.length > 0) {
							contractHint += ` Protected terms: [${protected_terms.join(", ")}] (NEVER treat as typos/misspellings).`;
						}
						if (!allow_write) {
							contractHint += ` Current task is inspection-only. DO NOT edit or write code. Report findings directly.`;
						}
						const routeHint = hintParts.length > 0 ? ` Focus: ${hintParts.join(" and ")}.` : "";

						const fullDirective = `Preflight route: focus on ${hintParts.join(" and ")}. ${contractHint}${routeHint} (Always match user's language and requirements for output.)`;
						turnRoutingHints.set(sessionName, fullDirective);

						const modelName = preflightModel?.id || preflightModelStr || "gemini-3.8-flash";
						const cardLines = [
							`### 🎯 意图分析与动态路由 (\`${modelName}\`)`,
							`- **任务意图**: \`${intent.toUpperCase()}\` (${allow_write ? "允许写代码/修改" : "纯分析/只读巡检"})`,
							`- **判定依据**: ${contract.reason || "无额外说明"}`,
						];
						if (clarified_intent) {
							cardLines.push(`- **规范意图 (3.5 理解)**: ${clarified_intent}`);
						}
						if (typo_corrections.length > 0) {
							cardLines.push(`- **识别纠错 (错别字)**: ${typo_corrections.map((t) => `\`${t}\``).join(", ")}`);
						}
						cardLines.push(
							`- **路由工具**: ${routedTools.length > 0 ? routedTools.map((t) => `\`${t}\``).join(", ") : "无"}`,
							`- **路由技能**: ${routedSkills.length > 0 ? routedSkills.map((s) => `\`${s}\``).join(", ") : "无"}`
						);
						if (protected_terms.length > 0) {
							cardLines.push(`- **保护术语 (防误判)**: ${protected_terms.map((t) => `\`${t}\``).join(", ")}`);
						}
						if (needDocs) {
							cardLines.push(`- **框架文档**: 已挂载 Pi Framework Docs`);
						}
						cardLines.push(`- **下发给 3.8 的指令切片**: \`${contractHint}\``);

						const fullContentGivenTo38 = `<system_directive>${fullDirective}</system_directive>\n\n${event.prompt}`;
						emitDietStepMessage(pi, _ctx, "prompt-diet:intent", cardLines.join("\n"), {
							model: modelName,
							intent,
							allow_write,
							reason: contract.reason,
							clarified_intent,
							typo_corrections,
							protected_terms,
							focus_tools: routedTools,
							focus_skills: routedSkills,
							need_docs: needDocs,
							user_original_prompt: event.prompt,
							injected_system_directive: fullDirective,
							full_content_given_to_38: fullContentGivenTo38,
							timestamp: new Date().toISOString(),
						});
					}
				}
			} catch (e: any) {
				console.error("[Preflight] Error:", e);
			}
		}

		// Fail-Open 容灾回退：预检不可用、抛错或返回空时，全量保留所有能力，保障任务不中断
		if (!preflightSucceeded) {
			console.warn("[pi-prompt-diet] Preflight soft routing bypassed or failed, falling back to fail-open (all capabilities preserved).");
			routedTools = allTools.map((t) => t.name);
			routedSkills = rawSkills.map((s) => s.name);
			needDocs = true;

			const globalContracts = ((globalThis as any).__PI_TASK_CONTRACTS__ =
				(globalThis as any).__PI_TASK_CONTRACTS__ || new Map<string, TaskContract>());
			globalContracts.set(sessionName, {
				intent: "execution",
				allow_write: true,
				source: "fallback",
				updatedAt: Date.now(),
			});

			const fallbackCardLines = [
				`### 🛡️ 容灾降级模式 (Fail-Open Fallback)`,
				`- **判定**: 意图预检跳过或异常，已激活容灾回退保护`,
				`- **安全策略**: 全量保留所有底层工具与技能能力，保障任务不中断`,
				`- **活跃能力**: 全量 ${allTools.length} 个工具、${rawSkills.length} 个技能全部就绪`,
			];
			emitDietStepMessage(pi, _ctx, "prompt-diet:fallback", fallbackCardLines.join("\n"), {
				fallback: true,
				totalTools: allTools.length,
				totalSkills: rawSkills.length,
				timestamp: new Date().toISOString(),
			});
		}

		// ── 4. 物理裁剪底层活跃工具（Required Tools + 语境路由工具） ─────────
		const explicitSkills = extractExplicitSkills(event.prompt);
		const neededSkills = new Set([...explicitSkills, ...routedSkills]);

		const baseRequired = Array.isArray(config.requiredTools) && config.requiredTools.length > 0
			? config.requiredTools
			: DEFAULT_REQUIRED_TOOLS;

		const activeToolNames = unique([
			...baseRequired,
			...routedTools,
			CALL_TOOL,
			REQUEST_CAPABILITIES_TOOL,
		]).filter((name) => allTools.some((t) => t.name === name));

		try {
			pi.setActiveTools(activeToolNames);
		} catch (error) {
			console.warn("[pi-prompt-diet] Failed to set active tools:", error);
		}

		// ── 5. 重写 System Prompt 中的工具段落、Guidelines 段落、文档段落与技能段落 ────
		const activeToolsSet = new Set(activeToolNames);
		prompt = rewriteAvailableTools(prompt, activeToolsSet, allTools);

		// Guidelines 处理：保留核心准则 + 属于活跃工具集的第三方工具准则（或其蒸馏胶囊）
		const core = selectedCoreGuidelines(config.guidelines?.customCore, activeToolsSet);
		const preservedGuidelines = new Set<string>();

		for (const tool of allTools) {
			if (!activeToolsSet.has(tool.name)) continue;
			const source = tool.sourceInfo?.source;
			if (!source || source === "builtin" || source === "sdk") continue;

			const toolSource = typeof source === "string" ? normalizeName(source) : "";
			const toolName = normalizeName(tool.name);
			const pkgCfg = (toolSource ? overrides.get(toolSource) : undefined) || overrides.get(toolName);
			const explicitMode = typeof pkgCfg?.guidelines === "object" ? pkgCfg.guidelines.mode : pkgCfg?.guidelines;
			if (explicitMode === "full") {
				for (const guideline of tool.promptGuidelines || []) preservedGuidelines.add(guideline);
				continue;
			}
			if (explicitMode === "slim" || explicitMode === "strip") continue;

			const capsule = getValidToolGuidelineCapsule(toolGuidelineCache, tool as CapabilityTool);
			if (!capsule || capsule.mode === "full") {
				for (const guideline of tool.promptGuidelines || []) preservedGuidelines.add(guideline);
			} else {
				for (const guideline of formatToolGuidelineCapsule(capsule)) preservedGuidelines.add(guideline);
			}
		}

		const allGuidelines = [...core, ...[...preservedGuidelines].map((g) => `- ${g}`)];

		const xmlRulesStart = prompt.indexOf("<rules>");
		const xmlRulesEnd = prompt.indexOf("</rules>");
		if (xmlRulesStart !== -1 && xmlRulesEnd !== -1) {
			const slimText = `<rules>\n${allGuidelines.join("\n")}\n</rules>`;
			prompt = prompt.slice(0, xmlRulesStart) + slimText + prompt.slice(xmlRulesEnd + "</rules>".length);
		} else {
			const guidelinesStart = prompt.indexOf("Guidelines:\n");
			if (guidelinesStart !== -1) {
				const rest = prompt.slice(guidelinesStart + "Guidelines:\n".length);
				const boundaryMatch = rest.match(/\n\n(?=[<#]|Pi documentation\b|Inactive skills\b)/);
				const nextSectionStart = boundaryMatch && boundaryMatch.index !== undefined
					? guidelinesStart + "Guidelines:\n".length + boundaryMatch.index
					: prompt.length;
				const slimText = `Guidelines:\n${allGuidelines.join("\n")}`;
				prompt = prompt.slice(0, guidelinesStart) + slimText + prompt.slice(nextSectionStart);
			}
		}

		// Neutralize Pi's conflicting default "Use bash for file operations like ls, rg, find"
		prompt = prompt.replace(/Use bash for file operations like ls, rg, find[^\n]*/gi, "");
		prompt = prompt.replace(/Use bash for file operations[^\n]*/gi, "");

		// 文档按需提供：如果未命中 Docs 需求且用户未显式提及框架，将文档段落移出 Prompt
		const explicitDocsMentioned = /\b(pi|pi-coding-agent|extension|extensions|sdk|skill|skills|theme|themes|tui)\b/i.test(event.prompt);
		if (!needDocs && !explicitDocsMentioned) {
			prompt = prompt.replace(/<docs>[\s\S]*?<\/docs>\n*/g, "");
			if (rawDocsBlock) {
				prompt = prompt.replace(rawDocsBlock, "");
			}
		}

		// Skill 只有在用户明确提及或语境命中时才注入完整/胶囊内容，未命中的列出名字供按需激活
		const skillsStart = prompt.indexOf("<available_skills>");
		const skillsEnd = prompt.indexOf("</available_skills>");
		if (skillsStart !== -1 && skillsEnd !== -1) {
			const promptSkills = event.systemPromptOptions?.skills || [];
			const activeSkillBlocks: string[] = [];
			const inactiveSkillNames: string[] = [];

			for (const s of promptSkills) {
				if (s.disableModelInvocation) continue;
				if (!neededSkills.has(s.name)) {
					inactiveSkillNames.push(s.name);
					continue; // 未命中的 Skill 详细内容不陪跑
				}

				let desc = (s.description || "").trim();
				const capabilitySkill = knownSkills.get(resolve(s.filePath));
				const capsule = config.adaptive?.enabled !== false && capabilitySkill
					? getValidSkillCapsule(skillCache, capabilitySkill)
					: undefined;
				if (capsule) {
					desc = formatSkillCapsule(capsule);
				} else {
					desc = formatSkillDescription(desc, 180);
				}

				desc = desc.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
				activeSkillBlocks.push(`  <skill>\n    <name>${s.name}</name>\n    <description>${desc}</description>\n    <location>${s.filePath}</location>\n  </skill>`);
			}

			let slimSkillsSection = "";
			if (activeSkillBlocks.length > 0) {
				slimSkillsSection = `<available_skills>\n${activeSkillBlocks.join("\n")}\n</available_skills>`;
			}
			if (inactiveSkillNames.length > 0) {
				const inactiveNotice = `Inactive skills (names only; call ${REQUEST_CAPABILITIES_TOOL} with skill name to activate):\n${inactiveSkillNames.join(", ")}`;
				slimSkillsSection = slimSkillsSection ? `${slimSkillsSection}\n\n${inactiveNotice}` : inactiveNotice;
			}

			// Check if <available_skills> is wrapped inside <skills>...</skills>
			const outerSkillsStart = prompt.lastIndexOf("<skills>", skillsStart);
			const outerSkillsEnd = prompt.indexOf("</skills>", skillsEnd);
			if (outerSkillsStart !== -1 && outerSkillsEnd !== -1 && outerSkillsStart < skillsStart && outerSkillsEnd > skillsEnd) {
				if (activeSkillBlocks.length === 0) {
					const replacement = slimSkillsSection ? `<skills>\n${slimSkillsSection}\n</skills>` : "";
					prompt = prompt.slice(0, outerSkillsStart) + replacement + prompt.slice(outerSkillsEnd + "</skills>".length);
				} else {
					prompt = prompt.slice(0, skillsStart) + slimSkillsSection + prompt.slice(skillsEnd + "</available_skills>".length);
				}
			} else {
				prompt = prompt.slice(0, skillsStart) + slimSkillsSection + prompt.slice(skillsEnd + "</available_skills>".length);
			}
		}

		const finalLength = prompt.length;
		const savedChars = Math.max(0, initialPromptLength - finalLength);
		const percent = initialPromptLength > 0 ? Math.round((savedChars / initialPromptLength) * 100) : 0;
		const estTokens = Math.round(savedChars / 4);

		const stats = getOrCreateSessionStats(sessionName);
		stats.promptInitialChars = initialPromptLength;
		stats.promptSlimmedChars = finalLength;
		stats.activeTools = activeToolNames;
		stats.activeSkills = [...neededSkills];
		stats.needDocs = needDocs;

		recordStatsDelta({
			promptInitialChars: initialPromptLength,
			promptSlimmedChars: finalLength,
		});

		saveSessionState(sessionName, {
			promptInitialChars: initialPromptLength,
			promptSlimmedChars: finalLength,
			activeTools: activeToolNames,
			activeSkills: [...neededSkills],
			needDocs,
		});

		if (config.showNotices !== false) {
			const activeCount = activeToolNames.length;
			const totalCount = allTools.length;
			const routingDetail = routedTools.length > 0 ? `路由: ${routedTools.join(", ")}` : "基线工具";
			const dietMsg = savedChars > 0
				? `🌿 [pi-prompt-diet] 提示词精简: ${(initialPromptLength / 1024).toFixed(1)}KB ➔ ${(finalLength / 1024).toFixed(1)}KB (-${percent}%, 估省 ~${estTokens} tokens) | 工具: ${activeCount}/${totalCount} 活跃 (${routingDetail})`
				: `🌿 [pi-prompt-diet] 提示词装配: ${(finalLength / 1024).toFixed(1)}KB | 工具: ${activeCount}/${totalCount} 活跃 (${routingDetail})`;

			notifyDiet(_ctx, dietMsg, "info");
			updateDietStatus(_ctx, savedChars > 0 ? `🌿 Diet: -${percent}% (${(finalLength / 1024).toFixed(1)}KB) | 工具: ${activeCount}/${totalCount}` : `🌿 Diet: ${(finalLength / 1024).toFixed(1)}KB | 工具: ${activeCount}/${totalCount}`);

			const widgetLines = [
				`🌿 Prompt Diet: ${(initialPromptLength / 1024).toFixed(1)}KB ➔ ${(finalLength / 1024).toFixed(1)}KB (-${percent}%, 估省 ~${estTokens} tok)`,
				`├─ 工具精简: ${activeCount}/${totalCount} 活跃 (${routingDetail})`,
			];
			if (stats.scrubbedSavedChars > 0) {
				widgetLines.push(`├─ 历史清理: 已累计瘦身 ${(stats.scrubbedSavedChars / 1024).toFixed(0)}KB (${stats.scrubbedToolResultsCount} 条输出已削减)`);
			}
			if (neededSkills.size > 0) {
				widgetLines.push(`├─ 动态技能: ${Array.from(neededSkills).join(", ")}`);
			}
			widgetLines.push(`└─ 状态: 最新轮次已优化`);
			updateDietWidget(_ctx, widgetLines);
		}

		if (process.env.DEBUG) {
			console.error("[Diet] Final forced system prompt length:", prompt.length);
			const matches = prompt.match(/<([a-z_]+)>([\s\S]*?)<\/\1>/g) || [];
			for (const m of matches) {
				const tag = m.match(/<([a-z_]+)>/)?.[1];
				console.error(`[Diet] Section <${tag}>: ${m.length} chars`);
			}
		}

		return { systemPrompt: prompt };
	});
}
