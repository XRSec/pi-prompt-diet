import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import {
	completeJson,
	compactCatalogDescription,
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

export interface PromptDietConfig {
	enabled?: boolean;
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
const REQUEST_CAPABILITIES_TOOL = "request_capabilities";
const DEFAULT_REQUIRED_TOOLS = ["read", "bash", "edit", "write"];

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
	const start = prompt.indexOf("Available tools:\n");
	if (start === -1) return prompt;
	const end = prompt.indexOf("\n\nGuidelines:", start);
	if (end === -1) return prompt;

	const activeLines = allTools
		.filter((t) => activeTools.has(t.name))
		.map((t) => `- ${t.name}: ${t.description.split("\n")[0].slice(0, 160)}`);

	const inactiveNames = allTools
		.filter((t) => !activeTools.has(t.name) && t.name !== REQUEST_CAPABILITIES_TOOL)
		.map((t) => t.name);

	let section = `Available tools:\n${activeLines.join("\n")}`;
	if (inactiveNames.length > 0) {
		section += `\n\nInactive tools (names only; call ${REQUEST_CAPABILITIES_TOOL} with its name to activate and view documentation):\n${inactiveNames.join(", ")}`;
	}

	return prompt.slice(0, start) + section + prompt.slice(end);
}

const DEFAULT_CORE_GUIDELINES = [
	"- Use read to examine files instead of cat or sed.",
	"- Use edit for precise changes (edits[].oldText must match exactly).",
	"- When changing multiple separate locations in one file, use one edit call with multiple entries.",
	"- Keep edits[].oldText as small as possible while still unique; do not pad with large unchanged regions.",
	"- Use write only for new files or complete rewrites.",
	"- Rely on each tool's parameter schema or read skills on demand for advanced workflows.",
	"- Be concise in your responses and show file paths clearly.",
];

const DEFAULT_CONFIG: PromptDietConfig = {
	enabled: true,
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
		guidelines: { ...base.guidelines, ...(next.guidelines || {}) },
		skills: { ...base.skills, ...(next.skills || {}) },
		adaptive: { ...base.adaptive, ...(next.adaptive || {}) },
		packages: next.packages ?? base.packages,
	};
}

function loadConfig(cwd: string): PromptDietConfig {
	const userConfigDir = join(homedir(), ".pi", "agent");
	const primaryUserConfigPath = join(userConfigDir, "pi-prompt-diet.json");
	const legacyUserConfigPath = join(userConfigDir, "prompt-diet.json");
	const projectConfigPath = join(cwd, ".pi", "pi-prompt-diet.json");
	const legacyProjectConfigPath = join(cwd, ".pi", "prompt-diet.json");

	if (!existsSync(primaryUserConfigPath) && !existsSync(legacyUserConfigPath)) {
		try {
			mkdirSync(userConfigDir, { recursive: true });
			writeConfigFile(primaryUserConfigPath, DEFAULT_CONFIG);
		} catch {}
	}

	let config: PromptDietConfig = structuredClone(DEFAULT_CONFIG);

	for (const p of [legacyUserConfigPath, primaryUserConfigPath]) {
		if (existsSync(p)) {
			try {
				config = mergeConfig(config, JSON.parse(readFileSync(p, "utf8")));
			} catch {}
		}
	}

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

function selectedCoreGuidelines(customCore: string[] | undefined): string[] {
	if (customCore) return customCore;
	return DEFAULT_CORE_GUIDELINES;
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

	pi.registerTool({
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
				pi.setActiveTools(unique([...current, ...addedTools, REQUEST_CAPABILITIES_TOOL]));
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

	if (typeof (pi as any).registerCommand === "function") {
		(pi as any).registerCommand("pi-prompt-diet", {
			description: "Inspect Prompt Diet distillation cache status",
			handler: async (_args: string, _ctx: ExtensionContext) => {
				const allTools = pi.getAllTools();
				const activeTools = pi.getActiveTools();
				const skillCapsulesCount = Object.keys(skillCache.skills).length;
				const toolCapsulesCount = Object.keys(toolGuidelineCache.tools).length;
				const lines = [
					"=== pi-prompt-diet Status ===",
					`• Total Tools: ${allTools.length}`,
					`• Active Tools: ${activeTools.length}`,
					`• Known Skills: ${knownSkills.size}`,
					`• Skill Capsules in Cache: ${skillCapsulesCount}`,
					`• Tool Guideline Capsules in Cache: ${toolCapsulesCount}`,
					"==============================",
				];
				const output = lines.join("\n");
				if ((_ctx as any).ui?.notify) {
					(_ctx as any).ui.notify(output);
				} else {
					console.log(output);
				}
				return output;
			},
		});
	}

	pi.on("session_start", (_event, _ctx) => {
		skillCache = loadSkillCapsuleCache();
		toolGuidelineCache = loadToolGuidelineCapsuleCache();
		knownSkills.clear();
		pendingDistillation.clear();
		pendingToolDistillation.clear();
	});

	pi.on("context", async (event, _ctx) => {
		const sessionName = _ctx.sessionManager?.getSessionName?.() || _ctx.cwd || "default";
		const hint = turnRoutingHints.get(sessionName);
		if (hint) {
			const lastUser = event.messages.findLast((m: any) => m.role === "user");
			if (lastUser && Array.isArray(lastUser.content)) {
				const textBlock = lastUser.content.find((c: any) => c.type === "text");
				if (textBlock && typeof textBlock.text === "string") {
					textBlock.text = `<system_directive>${hint}</system_directive>\n\n${textBlock.text}`;
				}
			}
		}
		return { messages: event.messages };
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
		console.error("[Diet] loaded config:", JSON.stringify(config.adaptive));

		if (config.enabled === false) return undefined;

		const allTools = pi.getAllTools();
		const rawSkills = (event.systemPromptOptions?.skills || [])
			.filter((skill) => !skill.disableModelInvocation)
			.map((skill) => ({ name: skill.name, description: skill.description || "", filePath: skill.filePath }));
		knownSkills.clear();
		for (const skill of rawSkills) knownSkills.set(resolve(skill.filePath), skill);

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

		// ── 1. Guidelines 处理（未激活的工具绝不配留准则，默认仅保留精简核心） ─────────
		const guidelinesStart = prompt.indexOf("Guidelines:\n");
		if (guidelinesStart !== -1) {
			// 寻找下一个合法的结构化区块边界（以 XML 标签 < 或 Markdown 标题 # 或文档块开头）
			const rest = prompt.slice(guidelinesStart + "Guidelines:\n".length);
			const boundaryMatch = rest.match(/\n\n(?=[<#]|Pi documentation\b)/);
			const nextSectionStart = boundaryMatch && boundaryMatch.index !== undefined
				? guidelinesStart + "Guidelines:\n".length + boundaryMatch.index
				: prompt.length;

			const core = selectedCoreGuidelines(config.guidelines?.customCore);
			const slimText = `Guidelines:\n${core.join("\n")}`;
			prompt = prompt.slice(0, guidelinesStart) + slimText + prompt.slice(nextSectionStart);
		}

		// ── 2. 检查并提取系统文档资源（以通用 XML/标题正则匹配，严禁硬编码语言词汇） ──────
		const docsMatch = prompt.match(/(?:<docs>[\s\S]*?<\/docs>|Pi documentation[\s\S]*?(?=\n\n[<#]|$))/);
		const rawDocsBlock = docsMatch ? docsMatch[0] : "";

		// ── 3. Soft Routing Preflight (Semantic Intent Router) ───────────
		const sessionName = _ctx.sessionManager?.getSessionName?.() || _ctx.cwd || "default";
		turnRoutingHints.delete(sessionName); // clear previous turn's hint
		
		let routedTools: string[] = [];
		let routedSkills: string[] = [];
		let needDocs = false;

		// Skip pure continuations heuristically to save preflight costs
		const isContinuation = /^(continue|go on|继续|继续做|好的|可以|再试一次)$/i.test(event.prompt.trim().replace(/[。.!！]$/, ""));
		if (config.adaptive?.softRouting !== false && event.prompt.trim() !== "" && !isContinuation) {
			try {
				const preflightModelStr = config.adaptive?.preflightModel || "cpa/gemini-3.5-flash-lite";
				let preflightModel = _ctx.model;
				if (preflightModelStr) {
					const separator = preflightModelStr.indexOf("/");
					if (separator > 0) {
						preflightModel = _ctx.modelRegistry.find(preflightModelStr.slice(0, separator), preflightModelStr.slice(separator + 1)) || _ctx.model;
					}
				}
				
				if (preflightModel && _ctx.modelRegistry.hasConfiguredAuth(preflightModel)) {
					const catalog = {
						tools: allTools.map((t) => ({ name: t.name, description: compactCatalogDescription(t.description, 200) })),
						skills: rawSkills.map((s) => ({ name: s.name, description: compactCatalogDescription(s.description, 200) })),
					};
					const systemAnalysisPrompt = `You are a pre-flight intent analyzer for an AI coding agent.
Read the user's request and identify EXACTLY which tools, skills, and documentation are needed to solve it efficiently.
The agent already has access to all tools, but we want to guide its attention to the most relevant ones to avoid distraction and hallucinations.
Respond ONLY with a JSON object: { "focus_skills": string[], "focus_tools": string[], "need_docs": boolean }.
Only include names that exist in the catalog. If unsure, prefer a minimal set.

SPECIAL MEMORY RULE:
If the user's request explicitly or implicitly references past work, historical configurations, prior discussions, or unresolved context (e.g., words like '之前', '上次', '记得', '以前', '曾经', 'earlier', 'we configured', 'last time'), you MUST include 'search-memory' in focus_skills and/or 'memory_recall' in focus_tools if present in the catalog.

SPECIAL DOCS RULE:
If the user's task asks about or involves the Pi coding agent framework itself (e.g. its SDK, extensions, themes, skills, CLI flags, internal APIs, or subprocess testing), set need_docs to true. Otherwise set need_docs to false.`;
					
					let memoryContext = "";
					const memMatch = event.systemPrompt.match(/## Nowledge Mem Context Bundle[\s\S]*?(?=\n<|$)/i);
					if (memMatch) {
						memoryContext = `\n\n【PERSISTENT MEMORY CONTEXT】:\n${memMatch[0].trim()}`;
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
								text = text.trim();
								const maxLength = m.role === "user" ? 400 : 600;
								return `${m.role.toUpperCase()}: ${text.slice(0, maxLength)}${text.length > maxLength ? "..." : ""}`;
							}).join("\n\n");
						}
					} catch (e) {
						// ignore history extraction errors
					}

					const userAnalysisPrompt = `CATALOG:\n${JSON.stringify(catalog, null, 2)}${memoryContext}${recentHistory}\n\n【USER LATEST REQUEST】:\n${event.prompt}`;
					
					const response = await completeJson(
						_ctx,
						{ ...(config.adaptive ?? {}), model: preflightModelStr ?? config.adaptive?.model },
						systemAnalysisPrompt,
						userAnalysisPrompt,
						250
					);
					console.error("[Preflight] Response:", response);
					
					if (response) {
						if (Array.isArray(response.focus_tools)) {
							routedTools = (response.focus_tools as string[]).filter((t) => allTools.some((at) => at.name === t));
						}
						if (Array.isArray(response.focus_skills)) {
							routedSkills = (response.focus_skills as string[]).filter((s) => rawSkills.some((as) => as.name === s));
						}
						if (typeof response.need_docs === "boolean") {
							needDocs = response.need_docs;
						}

						const focusSkillsStr = routedSkills.slice(0, 5).join(", ");
						const focusToolsStr = routedTools.slice(0, 5).join(", ");
						const hintParts = [];
						if (focusSkillsStr) hintParts.push(`skills: [${focusSkillsStr}]`);
						if (focusToolsStr) hintParts.push(`tools: [${focusToolsStr}]`);
						if (needDocs) hintParts.push(`docs: [Pi Framework Docs]`);
						
						if (hintParts.length > 0) {
							turnRoutingHints.set(
								sessionName,
								`Pre-flight suggestion: focus on ${hintParts.join(" and ")}. (If past context is needed or details are missing, feel free to use memory tools/skills. Always match user's language and requirements for output.)`
							);
						}
					}
				}
			} catch (e) {
				console.error("[Preflight] Error:", e);
				// Ignore preflight failures to avoid breaking the main loop
			}
		}

		// ── 4. 物理裁剪底层活跃工具（Required Tools + 语境路由工具） ─────────
		const explicitSkills = extractExplicitSkills(event.prompt);
		const neededSkills = new Set([...explicitSkills, ...routedSkills]);

		const activeToolNames = unique([
			...DEFAULT_REQUIRED_TOOLS,
			...routedTools,
			REQUEST_CAPABILITIES_TOOL,
		]).filter((name) => allTools.some((t) => t.name === name));

		try {
			pi.setActiveTools(activeToolNames);
		} catch (error) {
			console.warn("[pi-prompt-diet] Failed to set active tools:", error);
		}

		// ── 5. 重写 System Prompt 中的工具段落、文档段落与技能段落 ──────────────────
		prompt = rewriteAvailableTools(prompt, new Set(activeToolNames), allTools);

		// 文档按需提供：如果未命中 Docs 需求且用户未显式提及框架，将文档段落移出 Prompt
		const explicitDocsMentioned = /\b(pi|pi-coding-agent|extension|extensions|sdk|skill|skills|theme|themes|tui)\b/i.test(event.prompt);
		if (!needDocs && !explicitDocsMentioned && rawDocsBlock) {
			prompt = prompt.replace(rawDocsBlock, "");
		}

		// Skill 只有在用户明确提及或语境命中时才注入，未命中的彻底移除
		const skillsStart = prompt.indexOf("<available_skills>");
		const skillsEnd = prompt.indexOf("</available_skills>");
		if (skillsStart !== -1 && skillsEnd !== -1) {
			const promptSkills = event.systemPromptOptions?.skills || [];
			const activeSkillBlocks: string[] = [];

			for (const s of promptSkills) {
				if (s.disableModelInvocation) continue;
				if (!neededSkills.has(s.name)) continue; // 未命中的 Skill 彻底不陪跑！

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

			const slimSkillsSection = activeSkillBlocks.length > 0
				? `<available_skills>\n${activeSkillBlocks.join("\n")}\n</available_skills>`
				: "";

			prompt = prompt.slice(0, skillsStart) + slimSkillsSection + prompt.slice(skillsEnd + "</available_skills>".length);
		}

		return { systemPrompt: prompt };
	});
}
