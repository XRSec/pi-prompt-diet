import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import {
	distillSkill,
	distillToolGuidelines,
	formatSkillCapsule,
	formatToolGuidelineCapsule,
	getValidSkillCapsule,
	getValidToolGuidelineCapsule,
	loadSkillCapsuleCache,
	loadToolGuidelineCapsuleCache,
	routeCapabilities,
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

export interface SessionCapabilityState {
	version: 1;
	firstRouteCompleted: boolean;
	managedActiveTools: string[];
	managedActiveSkills: string[];
	lastAppliedTools: string[];
	observedExternalTools: string[];
	registeredTools: string[];
	recentUserRequests: string[];
	turnRequestCount?: number;
	totalExpansions?: number;
	pendingTask?: string;
	intentSummary?: string;
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


const CAPABILITY_STATE_ENTRY = "pi-prompt-diet-capabilities";
const REQUEST_CAPABILITIES_TOOL = "request_capabilities";
const PURE_CONTINUATIONS = new Set(["继续", "继续做", "再试一次", "好的", "可以", "continue", "go on", "try again"]);

function emptyCapabilityState(): SessionCapabilityState {
	return {
		version: 1,
		firstRouteCompleted: false,
		managedActiveTools: [],
		managedActiveSkills: [],
		lastAppliedTools: [],
		observedExternalTools: [],
		registeredTools: [],
		recentUserRequests: [],
		turnRequestCount: 0,
		totalExpansions: 0,
	};
}

function unique(values: Iterable<string>): string[] {
	return [...new Set(values)];
}

function isPureContinuation(prompt: string): boolean {
	return PURE_CONTINUATIONS.has(prompt.trim().toLowerCase().replace(/[。.!！]$/, ""));
}

function routingIntent(prompt: string): string {
	let remaining = prompt.trimStart();
	const invokedSkills: string[] = [];
	while (remaining.startsWith("<skill ")) {
		const open = remaining.match(/^<skill name="([^"]+)" location="[^"]+">\r?\n/);
		if (!open) break;
		const closeMarker = "\n</skill>";
		const close = remaining.indexOf(closeMarker, open[0].length);
		if (close === -1) break;
		invokedSkills.push(open[1]);
		remaining = remaining.slice(close + closeMarker.length).trimStart();
	}
	if (invokedSkills.length === 0) return prompt.trim();
	const task = remaining.trim();
	return task || `Explicitly invoked skill: ${invokedSkills.join(", ")}.`;
}

function restoreCapabilityState(ctx: ExtensionContext): SessionCapabilityState {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (entry.type !== "custom" || entry.customType !== CAPABILITY_STATE_ENTRY) continue;
		const data = entry.data as Partial<SessionCapabilityState> | undefined;
		if (data?.version !== 1) break;
		return {
			...emptyCapabilityState(),
			...data,
			managedActiveTools: unique(data.managedActiveTools ?? []),
			managedActiveSkills: unique(data.managedActiveSkills ?? []),
			lastAppliedTools: unique(data.lastAppliedTools ?? []),
			observedExternalTools: unique(data.observedExternalTools ?? []),
			registeredTools: unique(data.registeredTools ?? []),
			recentUserRequests: (data.recentUserRequests ?? []).map(routingIntent).filter(Boolean).slice(-4),
			pendingTask: data.pendingTask ? routingIntent(data.pendingTask) : undefined,
			intentSummary: data.intentSummary ? routingIntent(data.intentSummary) : undefined,
		};
	}
	return emptyCapabilityState();
}

function appendInactiveCapabilityCatalog(
	prompt: string,
	allTools: ReturnType<ExtensionAPI["getAllTools"]>,
	activeTools: Set<string>,
	skills: CapabilitySkill[],
	activeSkills: Set<string>,
): string {
	const toolLines = allTools
		.filter((tool) => !activeTools.has(tool.name))
		.map((tool) => `- tool ${tool.name}: ${shortToolDescription(tool.description)}`);
	const skillLines = skills
		.filter((skill) => !activeSkills.has(skill.name))
		.map((skill) => `- skill ${skill.name}: ${truncateDescription(skill.description, 180)}`);
	const lines = [...toolLines, ...skillLines];
	if (lines.length === 0) return prompt;
	return `${prompt}

Inactive capabilities (use ${REQUEST_CAPABILITIES_TOOL} when the current task needs one):
${lines.join("\n")}`;
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
		maxTools: 16,
		maxSkills: 8,
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

const configCache = new Map<string, { mtimeKey: string; config: PromptDietConfig }>();

function configMtimeKey(paths: string[]): string {
	return paths
		.filter((path) => existsSync(path))
		.map((path) => `${path}:${statSync(path).mtimeMs}`)
		.join("|");
}

function loadConfig(cwd: string): PromptDietConfig {
	const userConfigDir = join(homedir(), ".pi", "agent");
	const primaryUserConfigPath = join(userConfigDir, "pi-prompt-diet.json");
	const legacyUserConfigPath = join(userConfigDir, "prompt-diet.json");
	const projectConfigPath = join(cwd, ".pi", "pi-prompt-diet.json");
	const legacyProjectConfigPath = join(cwd, ".pi", "prompt-diet.json");
	const configPaths = [legacyUserConfigPath, primaryUserConfigPath, legacyProjectConfigPath, projectConfigPath];
	const cacheKey = `${cwd}::${configMtimeKey(configPaths)}`;
	const cached = configCache.get(cacheKey);
	if (cached) return cached.config;

	// 1. 如果用户全局配置不存在，自动创建标准的默认配置文件
	if (!existsSync(primaryUserConfigPath) && !existsSync(legacyUserConfigPath)) {
		try {
			mkdirSync(userConfigDir, { recursive: true });
			writeConfigFile(primaryUserConfigPath, DEFAULT_CONFIG);
		} catch {}
	}

	let config: PromptDietConfig = structuredClone(DEFAULT_CONFIG);

	// 2. 合并用户配置。
	for (const p of [legacyUserConfigPath, primaryUserConfigPath]) {
		if (existsSync(p)) {
			try {
				config = mergeConfig(config, JSON.parse(readFileSync(p, "utf8")));
			} catch {}
		}
	}

	// 3. 项目配置保持最高优先级。
	for (const p of [legacyProjectConfigPath, projectConfigPath]) {
		if (existsSync(p)) {
			try {
				config = mergeConfig(config, JSON.parse(readFileSync(p, "utf8")));
			} catch {}
		}
	}
	configCache.set(cacheKey, { mtimeKey: cacheKey, config });
	return config;
}

function formatSkillDescription(rawDesc: string, maxLen: number): string {
	const cleaned = rawDesc.trim().replace(/\n\s*/g, " ");
	// 1. 优先提取完整首句（支持中英文标点）
	const periodIdx = cleaned.search(/[.!?。！？](\s|$)/);
	let sentence = periodIdx !== -1 ? cleaned.slice(0, periodIdx + 1) : cleaned.split("\n")[0];

	// 2. 如果首句在 maxLen 内，直接返回完整首句
	if (sentence.length <= maxLen) {
		return sentence.trim();
	}

	// 3. 如果首句超长，执行智能单词/词边界截断，绝不在单词中间切开
	let slice = sentence.slice(0, maxLen - 3);
	// 如果是西文，寻找最后一个空格避免截断单词
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

function selectedCoreGuidelines(customCore: string[] | undefined, selectedTools?: Set<string>): string[] {
	if (customCore) return customCore;
	if (!selectedTools) return DEFAULT_CORE_GUIDELINES;
	return DEFAULT_CORE_GUIDELINES.filter((guideline) => {
		if (guideline.includes("Use read ")) return selectedTools.has("read");
		if (guideline.includes("Use edit ") || guideline.includes("edits[].oldText") || guideline.includes("multiple separate locations")) {
			return selectedTools.has("edit");
		}
		if (guideline.includes("Use write ")) return selectedTools.has("write");
		return true;
	});
}

function cleanDescription(description: string): string {
	return description.trim().replace(/\s+/g, " ");
}

function shortToolDescription(description: string): string {
	const clean = cleanDescription(description);
	// 弹性缓冲区：目标截断线是 350，但如果总长度不超过 450，干脆全盘保留，避免毫无意义的腰斩
	if (clean.length <= 450) return clean;
	
	// 超过 450 的超长描述，执行优雅截断（寻找最近的句号或单词边界）
	const slice = clean.slice(0, 350);
	const lastDot = slice.lastIndexOf(". ");
	let boundary = lastDot;
	
	if (boundary < 200) {
		const lastSpace = slice.lastIndexOf(" ");
		boundary = lastSpace > 250 ? lastSpace : 350;
	} else {
		boundary += 1; // 保留句号
	}
	
	return `${slice.slice(0, boundary).trimEnd()}... (request capability to read full details)`;
}

function truncateDescription(description: string, maxLength: number): string {
	const clean = description.trim().replace(/\s+/g, " ");
	if (clean.length <= maxLength) return clean;
	const slice = clean.slice(0, Math.max(1, maxLength - 3));
	const lastSpace = slice.lastIndexOf(" ");
	const boundary = lastSpace > maxLength * 0.7 ? lastSpace : slice.length;
	return `${slice.slice(0, boundary).trimEnd()}...`;
}

function rewriteAvailableTools(prompt: string, selectedTools: Set<string>, allTools: ReturnType<ExtensionAPI["getAllTools"]>): string {
	const start = prompt.indexOf("Available tools:\n");
	if (start === -1) return prompt;
	const end = prompt.indexOf("\n\nGuidelines:", start);
	if (end === -1) return prompt;
	const lines = allTools
		.filter((tool) => selectedTools.has(tool.name))
		.map((tool) => `- ${tool.name}: ${cleanDescription(tool.description)}`);
	const section = lines.length > 0 ? `Available tools:\n${lines.join("\n")}` : "";
	return prompt.slice(0, start) + section + prompt.slice(end);
}

function normalizeReadPath(path: string, cwd: string): string {
	return resolve(cwd, path.replace(/^@/, ""));
}

export default function promptDiet(pi: ExtensionAPI) {
	if (process.env.PI_PROMPT_DIET_DISABLE === "1" || process.env.PI_PROMPT_DIET_DISABLE === "true") {
		return;
	}

	let capabilityState = emptyCapabilityState();
	let skillCache = loadSkillCapsuleCache();
	let toolGuidelineCache = loadToolGuidelineCapsuleCache();
	const knownSkills = new Map<string, CapabilitySkill>();
	const pendingDistillation = new Set<string>();
	const pendingToolDistillation = new Set<string>();

	const persistCapabilityState = () => {
		pi.appendEntry(CAPABILITY_STATE_ENTRY, structuredClone(capabilityState));
	};

	pi.registerTool({
		name: REQUEST_CAPABILITIES_TOOL,
		label: "Request Capabilities",
		description: "Enable registered tools or Skills needed to continue the current task. Names only; schemas and wildcards are not accepted.",
		promptSnippet: "Enable additional registered tools or Skills when the active capabilities cannot complete the task",
		parameters: {
			type: "object",
			properties: {
				tools: { type: "array", items: { type: "string" }, maxItems: 16 },
				skills: { type: "array", items: { type: "string" }, maxItems: 16 },
				reason: { type: "string", minLength: 1 },
			},
			required: ["reason"],
			additionalProperties: false,
		} as any,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const config = loadConfig(ctx.cwd).adaptive ?? {};
			const maxRequestsPerTurn = config.maxRequestsPerTurn ?? 2;
			const currentTurnRequests = capabilityState.turnRequestCount ?? 0;
			if (currentTurnRequests >= maxRequestsPerTurn) {
				return {
					content: [{
						type: "text",
						text: `Capability request budget exceeded: at most ${maxRequestsPerTurn} request_capabilities calls are allowed per turn. Please proceed using currently active capabilities.`,
					}],
					details: {
						status: "failed",
						addedTools: [],
						addedSkills: [],
						unavailable: [],
						failures: [{
							capability: (params.tools ?? []).concat(params.skills ?? []).join(","),
							code: "turn_budget_exceeded",
							message: `Maximum calls per turn is ${maxRequestsPerTurn}.`,
						}],
					},
				};
			}

			// Count every attempt, including rejected requests and activation failures.
			capabilityState.turnRequestCount = currentTurnRequests + 1;
			persistCapabilityState();
			const allTools = pi.getAllTools();
			const current = pi.getActiveTools();
			const availableTools = new Set(allTools.map((tool) => tool.name));
			const availableSkills = new Set([...knownSkills.values()].map((skill) => skill.name));
			const requestedTools = unique(params.tools ?? []);
			const requestedSkills = unique(params.skills ?? []);
			const unavailable: string[] = [];
			const failures: Array<{ capability: string; code: string; message: string }> = [];
			const maxAdditions = config.maxAdditionsPerRequest ?? 8;
			const forbidden = new Set(config.neverAutoActivate ?? []);
			const explicitOnly = new Set(config.requireExplicitUserIntent ?? []);
			const recentIntent = capabilityState.recentUserRequests.join(" ").toLowerCase();

			const validate = (name: string, kind: "tool" | "skill", available: Set<string>): boolean => {
				if (name === "*" || name.includes("*")) {
					failures.push({ capability: name, code: "wildcard_forbidden", message: "Wildcard capability requests are not allowed." });
					return false;
				}
				if (!available.has(name)) {
					unavailable.push(name);
					return false;
				}
				if (forbidden.has(name)) {
					failures.push({ capability: name, code: "policy_denied", message: `${kind} is blocked by Prompt Diet policy.` });
					return false;
				}
				if (explicitOnly.has(name) && !recentIntent.includes(name.toLowerCase())) {
					failures.push({ capability: name, code: "explicit_intent_required", message: "The user must explicitly request this capability." });
					return false;
				}
				return true;
			};

			const validTools = requestedTools.filter((name) => validate(name, "tool", availableTools));
			let validSkills = requestedSkills.filter((name) => validate(name, "skill", availableSkills));
			if (validSkills.length > 0 && !current.includes("read") && !validTools.includes("read")) {
				if (validate("read", "tool", availableTools)) validTools.push("read");
				else {
					for (const name of validSkills) failures.push({ capability: name, code: "dependency_unavailable", message: "Skill activation requires the read tool." });
					validSkills = [];
				}
			}
			const additions = [...validTools.filter((name) => !current.includes(name)), ...validSkills.filter((name) => !capabilityState.managedActiveSkills.includes(name))];
			if (additions.length > maxAdditions) {
				return { content: [{ type: "text", text: `Capability request failed: at most ${maxAdditions} additions are allowed per request.` }], details: { status: "failed", addedTools: [], addedSkills: [], unavailable, failures: [...failures, { capability: additions.join(","), code: "too_many_additions", message: `Maximum is ${maxAdditions}.` }] } };
			}

			const addedTools = validTools.filter((name) => !current.includes(name));
			const addedSkills = validSkills.filter((name) => !capabilityState.managedActiveSkills.includes(name));
			const nextTools = unique([...current, ...addedTools, REQUEST_CAPABILITIES_TOOL]);
			try {
				if (addedTools.length > 0) pi.setActiveTools(nextTools);
			} catch (error) {
				return { content: [{ type: "text", text: `Capability activation failed: ${error instanceof Error ? error.message : String(error)}` }], details: { status: "failed", addedTools: [], addedSkills: [], unavailable, failures } };
			}
			capabilityState.managedActiveTools = unique([...capabilityState.managedActiveTools, ...validTools, REQUEST_CAPABILITIES_TOOL]);
			capabilityState.managedActiveSkills = unique([...capabilityState.managedActiveSkills, ...addedSkills]);
			capabilityState.lastAppliedTools = nextTools;
			capabilityState.registeredTools = [...availableTools].sort();
			capabilityState.totalExpansions = (capabilityState.totalExpansions ?? 0) + addedTools.length;
			capabilityState.pendingTask = params.reason;
			persistCapabilityState();
			const status = failures.length || unavailable.length
				? validTools.length || validSkills.length ? "partial" : "failed"
				: addedTools.length || addedSkills.length ? "activated" : "already_active";
			const disclosedSkills = [...knownSkills.values()]
				.filter((skill) => validSkills.includes(skill.name))
				.map((skill) => ({ name: skill.name, description: skill.description, filePath: skill.filePath }));
			const skillInstructions = disclosedSkills.length > 0
				? `\nRead the relevant SKILL.md before using its workflow:\n${JSON.stringify(disclosedSkills)}` : "";
			const issues = failures.length || unavailable.length ? `\n${JSON.stringify({ unavailable, failures })}` : "";
			return {
				content: [{ type: "text", text: `Capabilities ${status}. Added tools: ${addedTools.join(", ") || "none"}.${skillInstructions}${issues}` }],
				details: { status, addedTools, addedSkills, skills: disclosedSkills, unavailable, failures },
			};
		},
	});

	if (typeof (pi as any).registerCommand === "function") {
		(pi as any).registerCommand("pi-prompt-diet", {
			description: "Inspect Prompt Diet active capabilities, inactive tools, and distillation cache status",
			handler: async (_args: string, ctx: ExtensionContext) => {
				const allTools = pi.getAllTools();
				const activeTools = pi.getActiveTools();
				const inactiveTools = allTools.filter((tool) => !activeTools.includes(tool.name));
				const skillCapsulesCount = Object.keys(skillCache.skills).length;
				const toolCapsulesCount = Object.keys(toolGuidelineCache.tools).length;
				const lines = [
					"=== pi-prompt-diet Status ===",
					`• Active Tools (${activeTools.length}): ${activeTools.join(", ") || "none"}`,
					`• Inactive Registered Tools (${inactiveTools.length}): ${inactiveTools.map((t) => t.name).join(", ") || "none"}`,
					`• Active Skills: ${capabilityState.managedActiveSkills.join(", ") || "none"}`,
					`• Skill Capsules in Cache: ${skillCapsulesCount}`,
					`• Tool Guideline Capsules in Cache: ${toolCapsulesCount}`,
					`• Total Tools Expanded this Session: ${capabilityState.totalExpansions ?? 0}`,
					"==============================",
				];
				const output = lines.join("\n");
				if ((ctx as any).ui?.notify) {
					(ctx as any).ui.notify(output);
				} else {
					console.log(output);
				}
				return output;
			},
		});
	}

	pi.on("session_start", (_event, ctx) => {
		capabilityState = restoreCapabilityState(ctx);
		const registered = new Set(pi.getAllTools().map((tool) => tool.name));
		capabilityState.managedActiveTools = capabilityState.managedActiveTools.filter((name) => registered.has(name));
		capabilityState.lastAppliedTools = capabilityState.lastAppliedTools.filter((name) => registered.has(name));
		capabilityState.registeredTools = [...registered].sort();
		if (capabilityState.firstRouteCompleted) {
			const restored = unique([...capabilityState.managedActiveTools, ...capabilityState.observedExternalTools.filter((name) => registered.has(name)), REQUEST_CAPABILITIES_TOOL]);
			try {
				pi.setActiveTools(restored);
				capabilityState.lastAppliedTools = restored;
			} catch (error) {
				console.warn("[pi-prompt-diet] Failed to restore active tools:", error);
			}
		}
		skillCache = loadSkillCapsuleCache();
		toolGuidelineCache = loadToolGuidelineCapsuleCache();
		knownSkills.clear();
		pendingDistillation.clear();
		pendingToolDistillation.clear();
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

	pi.on("before_agent_start", async (event, ctx) => {
		const cwd = ctx.cwd || process.cwd();
		const config = loadConfig(cwd);

		if (config.enabled === false) return undefined;

		capabilityState.turnRequestCount = 0;

		const allTools = pi.getAllTools();
		const rawSkills = (event.systemPromptOptions?.skills || [])
			.filter((skill) => !skill.disableModelInvocation)
			.map((skill) => ({ name: skill.name, description: skill.description || "", filePath: skill.filePath }));
		knownSkills.clear();
		for (const skill of rawSkills) knownSkills.set(resolve(skill.filePath), skill);

		const registeredTools = new Set(allTools.map((tool) => tool.name));
		const previousRegistered = new Set(capabilityState.registeredTools);
		const registryAdded = [...registeredTools].filter((name) => !previousRegistered.has(name));
		const currentPiActive = pi.getActiveTools().filter((name) => registeredTools.has(name));
		const lastApplied = new Set(capabilityState.lastAppliedTools);
		const externallyAddedTools = capabilityState.firstRouteCompleted
			? currentPiActive.filter((name) => !lastApplied.has(name))
			: [];
		capabilityState.observedExternalTools = unique([
			...capabilityState.observedExternalTools.filter((name) => registeredTools.has(name)),
			...externallyAddedTools,
		]);
		capabilityState.registeredTools = [...registeredTools].sort();
		capabilityState.managedActiveTools = capabilityState.managedActiveTools.filter((name) => registeredTools.has(name));
		capabilityState.managedActiveSkills = capabilityState.managedActiveSkills.filter((name) => rawSkills.some((skill) => skill.name === name));

		const routePrompt = routingIntent(event.prompt);
		const pureContinuation = isPureContinuation(routePrompt);
		const routeEveryTurn = config.adaptive?.routeEveryTurn === true;
		const configuredAlwaysTools = (config.adaptive?.alwaysTools ?? []).filter((name) => registeredTools.has(name));
		// When alwaysTools is set and per-turn routing is off, skip the blocking router LLM entirely.
		const fastStart = !routeEveryTurn && configuredAlwaysTools.length > 0;
		const shouldRoute = config.adaptive?.enabled !== false && !fastStart && (
			!capabilityState.firstRouteCompleted
			|| registryAdded.length > 0
			|| (routeEveryTurn && !(pureContinuation && capabilityState.pendingTask))
		);
		let routingSucceeded = false;
		if (fastStart && !capabilityState.firstRouteCompleted) {
			const nextTools = unique([...configuredAlwaysTools, REQUEST_CAPABILITIES_TOOL]);
			try {
				pi.setActiveTools(nextTools);
				capabilityState.managedActiveTools = nextTools;
				capabilityState.lastAppliedTools = nextTools;
				capabilityState.firstRouteCompleted = true;
				routingSucceeded = true;
			} catch (error) {
				console.warn("[pi-prompt-diet] Failed to apply fastStart alwaysTools:", error);
			}
		}
		if (shouldRoute) {
			try {
				const candidateRoute = await routeCapabilities(
					ctx,
					config.adaptive ?? {},
					routePrompt,
					allTools.map((tool) => ({ name: tool.name, description: tool.description })),
					rawSkills,
					skillCache,
					{
						activeTools: unique([...capabilityState.managedActiveTools, ...capabilityState.observedExternalTools, REQUEST_CAPABILITIES_TOOL]),
						activeSkills: capabilityState.managedActiveSkills,
						recentUserRequests: capabilityState.recentUserRequests,
						pendingTask: capabilityState.pendingTask,
						intentSummary: capabilityState.intentSummary,
						registryAdded,
					},
				);
				if (candidateRoute) {
					const adaptive = config.adaptive ?? {};
					const forbidden = new Set(adaptive.neverAutoActivate ?? []);
					const explicitOnly = new Set(adaptive.requireExplicitUserIntent ?? []);
					const explicitText = routePrompt.toLowerCase();
					const maxAdditions = adaptive.maxAdditionsPerRequest ?? 8;
					const routedTools = candidateRoute.tools
						.filter((name) => !forbidden.has(name))
						.filter((name) => !explicitOnly.has(name) || explicitText.includes(name.toLowerCase()))
						.slice(0, maxAdditions);
					const alwaysTools = (adaptive.alwaysTools ?? []).filter((name) => registeredTools.has(name));
					const nextManagedTools = capabilityState.firstRouteCompleted
						? unique([...capabilityState.managedActiveTools, ...routedTools, REQUEST_CAPABILITIES_TOOL])
						: unique([...alwaysTools, ...routedTools, REQUEST_CAPABILITIES_TOOL]);
					const nextTools = capabilityState.firstRouteCompleted
						? unique([...nextManagedTools, ...capabilityState.observedExternalTools])
						: nextManagedTools;
					const routedSkills = nextTools.includes("read") ? candidateRoute.skills
						.filter((name) => !forbidden.has(name))
						.filter((name) => !explicitOnly.has(name) || explicitText.includes(name.toLowerCase()))
						.slice(0, maxAdditions - routedTools.length) : [];
					pi.setActiveTools(nextTools);
					capabilityState.managedActiveTools = nextManagedTools;
					capabilityState.managedActiveSkills = unique([...capabilityState.managedActiveSkills, ...routedSkills]);
					capabilityState.lastAppliedTools = nextTools;
					capabilityState.firstRouteCompleted = true;
					routingSucceeded = true;
				}
			} catch (error) {
				console.warn("[pi-prompt-diet] Incremental capability routing failed; preserving current capabilities:", error);
			}
		}

		if (!capabilityState.firstRouteCompleted && !routingSucceeded && configuredAlwaysTools.length > 0) {
			const fallbackTools = unique([...configuredAlwaysTools, REQUEST_CAPABILITIES_TOOL]);
			try {
				pi.setActiveTools(fallbackTools);
				capabilityState.managedActiveTools = fallbackTools;
				capabilityState.lastAppliedTools = fallbackTools;
				capabilityState.firstRouteCompleted = true;
				routingSucceeded = true;
			} catch (error) {
				console.warn("[pi-prompt-diet] Failed to apply alwaysTools fallback:", error);
			}
		}

		if (capabilityState.firstRouteCompleted && !routingSucceeded && externallyAddedTools.length > 0) {
			const nextTools = unique([...capabilityState.managedActiveTools, ...capabilityState.observedExternalTools, REQUEST_CAPABILITIES_TOOL]);
			try {
				pi.setActiveTools(nextTools);
				capabilityState.lastAppliedTools = nextTools;
			} catch (error) {
				console.warn("[pi-prompt-diet] Failed to preserve externally activated tools:", error);
			}
		}

		capabilityState.recentUserRequests = [...capabilityState.recentUserRequests, routePrompt].filter(Boolean).slice(-4);
		if (!pureContinuation) {
			capabilityState.pendingTask = routePrompt;
			capabilityState.intentSummary = routePrompt;
		}
		if (capabilityState.firstRouteCompleted || routingSucceeded) persistCapabilityState();

		const selectedTools = capabilityState.firstRouteCompleted ? new Set(capabilityState.lastAppliedTools) : undefined;
		const selectedSkills = capabilityState.firstRouteCompleted ? new Set(capabilityState.managedActiveSkills) : undefined;
		let prompt = selectedTools ? rewriteAvailableTools(event.systemPrompt, selectedTools, allTools) : event.systemPrompt;

		// ── 构建 packages 覆盖映射表 ─────────────────────────────────────────
		const overrides = new Map<string, PackageOverrideConfig>();
		if (Array.isArray(config.packages)) {
			for (const item of config.packages) {
				if (item && typeof item === "object" && typeof item.source === "string") {
					const norm = normalizeName(item.source);
					overrides.set(norm, item);
					// 同时支持短名称匹配（如 @juicesharp/rpiv-todo 与 rpiv-todo）
					if (norm.includes("/")) {
						overrides.set(norm.split("/").pop()!, item);
					}
				}
			}
		}

		// ── 1. Guidelines 处理 ──────────────────────────────────────────────────
		const globalGMode = config.guidelines?.mode ?? "slim";
		if (globalGMode !== "full") {
			const guidelinesStart = prompt.indexOf("Guidelines:\n");
			if (guidelinesStart !== -1) {
				const candidates = [
					prompt.indexOf("\n\nPi documentation", guidelinesStart),
					prompt.indexOf("\n\nAlways respond in Chinese", guidelinesStart),
					prompt.indexOf("\n\n<available_skills>", guidelinesStart),
				].filter((idx) => idx !== -1);

				if (candidates.length > 0) {
					const nextSectionStart = Math.min(...candidates);

					// 用户显式 override 优先；未配置的第三方工具首次完整保留，真实使用后采用已缓存的 full/capsule 判断。
					const preservedGuidelines = new Set<string>();
					for (const tool of allTools) {
						if (selectedTools && !selectedTools.has(tool.name)) continue;
						const toolSource = typeof tool.sourceInfo?.source === "string" ? normalizeName(tool.sourceInfo.source) : "";
						const toolName = normalizeName(tool.name);
						const pkgCfg = (toolSource ? overrides.get(toolSource) : undefined) || overrides.get(toolName);
						const explicitMode = typeof pkgCfg?.guidelines === "object" ? pkgCfg.guidelines.mode : pkgCfg?.guidelines;
						if (explicitMode === "full") {
							for (const guideline of tool.promptGuidelines || []) preservedGuidelines.add(guideline);
							continue;
						}
						if (explicitMode === "slim" || explicitMode === "strip") continue;
						const source = tool.sourceInfo?.source;
						if (!source || source === "builtin" || source === "sdk") continue;
						const capsule = getValidToolGuidelineCapsule(toolGuidelineCache, tool as CapabilityTool);
						if (!capsule || capsule.mode === "full") {
							for (const guideline of tool.promptGuidelines || []) preservedGuidelines.add(guideline);
						} else {
							for (const guideline of formatToolGuidelineCapsule(capsule)) preservedGuidelines.add(guideline);
						}
					}
					const preservedFullRules = [...preservedGuidelines].map((guideline) => `- ${guideline}`);

					let slimText = "";
					if (globalGMode === "slim") {
						const core = selectedCoreGuidelines(config.guidelines?.customCore, selectedTools);
						const allLines = [...core, ...preservedFullRules];
						slimText = `Guidelines:\n${allLines.join("\n")}`;
					} else if (globalGMode === "strip" && preservedFullRules.length > 0) {
						slimText = `Guidelines:\n${preservedFullRules.join("\n")}`;
					}

					prompt = prompt.slice(0, guidelinesStart) + slimText + prompt.slice(nextSectionStart);
				}
			}
		}

		// ── 2. Skills 处理（支持按包/技能独立指定 compress / strip / full） ────────
		const globalSMode = config.skills?.mode ?? "compress";
		if (globalSMode !== "full" || overrides.size > 0 || selectedSkills) {
			const skillsStart = prompt.indexOf("<available_skills>");
			const skillsEnd = prompt.indexOf("</available_skills>");
			if (skillsStart !== -1 && skillsEnd !== -1) {
				const promptSkills = event.systemPromptOptions?.skills || [];
				const globalMaxLen = config.skills?.maxDescriptionLength ?? 120;

				const activeSkillBlocks: string[] = [];

				for (const s of promptSkills) {
					if (s.disableModelInvocation || (selectedSkills && !selectedSkills.has(s.name))) continue;

					// 查找该 Skill 是否命中了 package override
					const sNameNorm = normalizeName(s.name);
					const sSourceNorm = typeof s.sourceInfo?.source === "string" ? normalizeName(s.sourceInfo.source) : "";
					
					const override = overrides.get(sNameNorm) || (sSourceNorm ? overrides.get(sSourceNorm) : undefined);
					const rawOverrideSkills = override?.skills;
					
					let effectiveMode = globalSMode;
					let itemMaxLen: number | undefined = undefined;

					// ── 1. 细粒度规则数组模式 (["-skills/council-mode", ...]) ──
					if (Array.isArray(rawOverrideSkills)) {
						const res = matchSkillRule(s.filePath, s.name, rawOverrideSkills);
						if (res === "exclude") continue;
					} 
					// ── 2. 精准文件路径键值映射模式 ({"skills/council-mode": "full", "skills/pi-subagents": "strip"}) ──
					else if (typeof rawOverrideSkills === "object" && rawOverrideSkills !== null) {
						if (Array.isArray((rawOverrideSkills as any).rules)) {
							const res = matchSkillRule(s.filePath, s.name, (rawOverrideSkills as any).rules);
							if (res === "exclude") continue;
						} else if ("mode" in rawOverrideSkills) {
							effectiveMode = (rawOverrideSkills as any).mode ?? globalSMode;
							itemMaxLen = (rawOverrideSkills as any).maxDescriptionLength;
						} else {
							// 遍历键值对匹配技能路径或名称
							const p = s.filePath.replace(/\\/g, "/");
							for (const [key, val] of Object.entries(rawOverrideSkills)) {
								const cleanKey = key.replace(/^\/+/, "");
								if (p.includes(cleanKey) || s.name === cleanKey || s.name.includes(cleanKey)) {
									if (typeof val === "string") {
										effectiveMode = (val === "slim" ? "compress" : val) as TreatmentMode;
									} else if (typeof val === "object" && val !== null) {
										effectiveMode = (val.mode === "slim" ? "compress" : val.mode) ?? globalSMode;
										itemMaxLen = val.maxDescriptionLength;
									}
									break;
								}
							}
						}
					} 
					// ── 3. 统一字符串模式 ("strip" | "compress" | "full") ──
					else if (typeof rawOverrideSkills === "string") {
						effectiveMode = (rawOverrideSkills === "slim" ? "compress" : rawOverrideSkills) as TreatmentMode;
					}

					if (effectiveMode === "strip") {
						// 彻底剥离该技能
						continue;
					}

					let desc = (s.description || "").trim();
					if (effectiveMode === "compress" || effectiveMode === "slim") {
						const maxLen = itemMaxLen ?? override?.maxDescriptionLength ?? globalMaxLen;
						const capabilitySkill = knownSkills.get(resolve(s.filePath));
						const capsule = config.adaptive?.enabled !== false && capabilitySkill
							? getValidSkillCapsule(skillCache, capabilitySkill)
							: undefined;
						if (capsule) {
							// Capsules are already bounded by the distiller. Keep complete constraints.
							desc = formatSkillCapsule(capsule);
						} else if (!selectedSkills) {
							desc = formatSkillDescription(desc, maxLen);
						}
					}
					// 自适应冷启动保留原始描述；胶囊生成后改用蒸馏内容。full 模式始终保留原描述。

					desc = desc.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
					activeSkillBlocks.push(`  <skill>\n    <name>${s.name}</name>\n    <description>${desc}</description>\n    <location>${s.filePath}</location>\n  </skill>`);
				}

				const slimSkillsSection = activeSkillBlocks.length > 0
					? `<available_skills>\n${activeSkillBlocks.join("\n")}\n</available_skills>`
					: "";

				prompt = prompt.slice(0, skillsStart) + slimSkillsSection + prompt.slice(skillsEnd + "</available_skills>".length);
			}
		}

		if (selectedTools && selectedSkills) {
			prompt = appendInactiveCapabilityCatalog(prompt, allTools, selectedTools, rawSkills, selectedSkills);
		}
		return { systemPrompt: prompt };
	});
}
