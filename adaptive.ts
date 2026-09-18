import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AdaptiveConfig {
	enabled?: boolean;
	model?: string;
	alwaysTools?: string[];
	maxTools?: number;
	maxSkills?: number;
	distillSkills?: boolean;
	distillToolGuidelines?: boolean;
	neverAutoActivate?: string[];
	requireExplicitUserIntent?: string[];
	maxAdditionsPerRequest?: number;
	maxRequestsPerTurn?: number;
	/** When false (default), route only on cold start and registry changes; later turns rely on request_capabilities. */
	routeEveryTurn?: boolean;
	/** Abort routing/distillation LLM calls after this many ms; fall back to current capabilities. Default 5000. */
	routingTimeoutMs?: number;
}

export interface CapabilityTool {
	name: string;
	description: string;
	parameters?: unknown;
	promptGuidelines?: string[];
	sourceInfo?: { source?: string; path?: string };
}

export interface CapabilitySkill {
	name: string;
	description: string;
	filePath: string;
}

export interface PromptRoute {
	tools: string[];
	skills: string[];
}

export interface IncrementalRouteContext {
	activeTools?: string[];
	activeSkills?: string[];
	recentUserRequests?: string[];
	pendingTask?: string;
	intentSummary?: string;
	registryAdded?: string[];
}

export interface SkillCapsule {
	name: string;
	filePath: string;
	fingerprint: string;
	trigger: string;
	essentialRules: string[];
	readFullWhen: string;
	generatedAt: string;
}

export const DISTILLER_VERSION = "v3.2";

export interface SkillCapsuleCache {
	version: 1;
	skills: Record<string, SkillCapsule>;
}

export type ToolGuidelineCapsule = {
	name: string;
	source: string;
	fingerprint: string;
	mode: "full";
	reason: string;
	generatedAt: string;
} | {
	name: string;
	source: string;
	fingerprint: string;
	mode: "capsule";
	essentialRules: string[];
	reason: string;
	generatedAt: string;
};

export interface ToolGuidelineCapsuleCache {
	version: 1;
	tools: Record<string, ToolGuidelineCapsule>;
}

const ROUTER_SYSTEM_PROMPT = `You are an incremental capability router for a coding agent. Select only newly required registered tools and skills that are not already active.
Return JSON only, with exactly this shape: {"tools":["tool-name"],"skills":["skill-name"]}.
Use the current request together with continuation context and recent requests. A short continuation such as "continue" inherits the pending task. Only return names present in the supplied inactive catalog. Prefer recall when a missing capability would block completion, but do not select unrelated capabilities. Honor explicit prohibitions and hypothetical/planning-only framing: if the user says not to call, use, delegate, execute, or modify, do not activate capabilities for that prohibited action merely because capability names or execution scenarios are mentioned. A skill is guidance, while a tool is executable. If a newly selected skill must be opened, include read when it is inactive and available. Do not answer the user and do not emit prose.`

const DISTILL_SYSTEM_PROMPT = `You distill a reusable routing capsule from one agent Skill file. Return JSON only with exactly this shape: {"trigger":"...","essentialRules":["..."],"readFullWhen":"..."}.
The trigger must state when the skill applies.
Extract at most four non-obvious, operationally critical rules:
- Prioritize negative constraints ("never", "do not", "must not") and safety/data-integrity limits.
- Prioritize sequential ordering and prerequisite rules ("before X, always Y", "after 1-2 tries, stop").
- Keep concrete boundaries rather than generic advice.
The readFullWhen field must state when the agent should open the complete Skill file for full workflows or edge cases. Each text field and rule must be at most 300 characters and contain complete statements. Do not invent rules and keep the result concise.`;

const TOOL_GUIDELINE_DISTILL_SYSTEM_PROMPT = `You evaluate the prompt guidelines of one third-party agent tool after it has been used. Return JSON only in one of these exact shapes:
{"mode":"full","reason":"..."}
{"mode":"capsule","essentialRules":["..."],"reason":"..."}
Choose full when the original guidelines are already concise, semantically dense, safety-critical, contain strict sequential orders or negative constraints, or cannot be shortened without changing tool-call behavior. Choose capsule only when real redundancy can be removed while strictly preserving every non-obvious operational rule, parameter semantic, stop condition, negative constraint ("do not", "never"), and concurrency/data-integrity constraint. Keep at most four complete rules of at most 320 characters each; choose full if preserving all constraints needs more space. Never invent a rule. Do not choose capsule merely to reduce character count.`;

function cacheRoot(): string {
	return join(homedir(), ".pi", "agent", "cache", "pi-prompt-diet");
}

function legacyCachePath(): string {
	return join(cacheRoot(), "skills.json");
}

function capsuleDirectory(): string {
	return join(cacheRoot(), "skills");
}

function capsulePath(filePath: string): string {
	const key = createHash("sha256").update(filePath).digest("hex");
	return join(capsuleDirectory(), `${key}.json`);
}

function toolCapsuleDirectory(): string {
	return join(cacheRoot(), "tools");
}

function toolCacheKey(tool: CapabilityTool): string {
	return `${tool.sourceInfo?.source ?? "unknown"}:${tool.name}`;
}

function toolCapsulePath(key: string): string {
	return join(toolCapsuleDirectory(), `${createHash("sha256").update(key).digest("hex")}.json`);
}

function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(temporaryPath, JSON.stringify(value, null, 2), "utf8");
		renameSync(temporaryPath, path);
	} finally {
		rmSync(temporaryPath, { force: true });
	}
}

export function loadSkillCapsuleCache(): SkillCapsuleCache {
	const cache: SkillCapsuleCache = { version: 1, skills: {} };
	const legacyPath = legacyCachePath();
	let loadedLegacy = false;
	if (existsSync(legacyPath)) {
		try {
			const legacy = JSON.parse(readFileSync(legacyPath, "utf8")) as SkillCapsuleCache;
			if (legacy.version === 1 && legacy.skills && typeof legacy.skills === "object") {
				for (const capsule of Object.values(legacy.skills)) {
					if (isSkillCapsule(capsule)) cache.skills[capsule.filePath] = capsule;
				}
				loadedLegacy = true;
			}
		} catch {}
	}
	const directory = capsuleDirectory();
	if (existsSync(directory)) {
		for (const file of readdirSync(directory)) {
			if (!file.endsWith(".json")) continue;
			try {
				const capsule = JSON.parse(readFileSync(join(directory, file), "utf8")) as SkillCapsule;
				if (isSkillCapsule(capsule)) {
					cache.skills[capsule.filePath] = capsule;
				}
			} catch {}
		}
	}
	if (loadedLegacy) {
		try {
			saveSkillCapsuleCache(cache);
			rmSync(legacyPath, { force: true });
		} catch (error) {
			console.warn("[pi-prompt-diet] Failed to migrate the legacy Skill capsule cache:", error);
		}
	}
	return cache;
}

export function saveSkillCapsule(cache: SkillCapsuleCache, filePath: string, expectedFingerprint?: string): boolean {
	const capsule = cache.skills[filePath];
	if (!capsule) return false;
	if (expectedFingerprint && fingerprintSkill(filePath) !== expectedFingerprint) {
		console.warn(`[pi-prompt-diet] CAS check failed for Skill ${filePath}; source was modified concurrently.`);
		return false;
	}
	writeJsonAtomic(capsulePath(filePath), capsule);
	return true;
}

export function saveSkillCapsuleCache(cache: SkillCapsuleCache): void {
	for (const capsule of Object.values(cache.skills)) {
		saveSkillCapsule(cache, capsule.filePath);
	}
}

export function loadToolGuidelineCapsuleCache(): ToolGuidelineCapsuleCache {
	const cache: ToolGuidelineCapsuleCache = { version: 1, tools: {} };
	const directory = toolCapsuleDirectory();
	if (!existsSync(directory)) return cache;
	for (const file of readdirSync(directory)) {
		if (!file.endsWith(".json")) continue;
		try {
			const capsule = JSON.parse(readFileSync(join(directory, file), "utf8")) as ToolGuidelineCapsule;
			if (isToolCapsule(capsule)) {
				cache.tools[`${capsule.source}:${capsule.name}`] = capsule;
			}
		} catch {}
	}
	return cache;
}

export function saveToolGuidelineCapsule(cache: ToolGuidelineCapsuleCache, key: string, currentTool?: CapabilityTool): boolean {
	const capsule = cache.tools[key];
	if (!capsule) return false;
	if (currentTool && fingerprintToolGuidelines(currentTool) !== capsule.fingerprint) {
		console.warn(`[pi-prompt-diet] CAS check failed for Tool ${key}; tool metadata was modified concurrently.`);
		return false;
	}
	writeJsonAtomic(toolCapsulePath(key), capsule);
	return true;
}

export function fingerprintToolGuidelines(tool: CapabilityTool): string {
	return createHash("sha256").update(JSON.stringify({
		distillerVersion: DISTILLER_VERSION,
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters ?? null,
		promptGuidelines: tool.promptGuidelines ?? [],
		source: tool.sourceInfo?.source ?? "unknown",
		path: tool.sourceInfo?.path ?? "",
	})).digest("hex");
}

export function getValidToolGuidelineCapsule(cache: ToolGuidelineCapsuleCache, tool: CapabilityTool): ToolGuidelineCapsule | undefined {
	const capsule = cache.tools[toolCacheKey(tool)];
	return isToolCapsule(capsule) && capsule.fingerprint === fingerprintToolGuidelines(tool) ? capsule : undefined;
}

export function formatToolGuidelineCapsule(capsule: ToolGuidelineCapsule): string[] {
	return capsule.mode === "capsule" ? capsule.essentialRules : [];
}

export function fingerprintSkill(filePath: string): string | undefined {
	try {
		return createHash("sha256").update(JSON.stringify({
			distillerVersion: DISTILLER_VERSION,
			content: readFileSync(filePath, "utf8"),
		})).digest("hex");
	} catch {
		return undefined;
	}
}

export function getValidSkillCapsule(cache: SkillCapsuleCache, skill: CapabilitySkill): SkillCapsule | undefined {
	const capsule = cache.skills[skill.filePath];
	if (!isSkillCapsule(capsule)) return undefined;
	const fingerprint = fingerprintSkill(skill.filePath);
	return fingerprint && capsule.fingerprint === fingerprint ? capsule : undefined;
}

export function formatSkillCapsule(capsule: SkillCapsule): string {
	const readCondition = capsule.readFullWhen ? ` Read the full Skill when ${capsule.readFullWhen}` : "";
	const rules = capsule.essentialRules.join(" ");
	return `${capsule.trigger}${readCondition}${rules ? ` ${rules}` : ""}`.trim();
}

function compactCatalogDescription(value: string, maxLength: number): string {
	const clean = value.trim().replace(/\s+/g, " ");
	if (clean.length <= maxLength) return clean;
	return `${clean.slice(0, maxLength - 3).trimEnd()}...`;
}

function responseText(response: { content: Array<{ type: string; text?: string }> }): string {
	return response.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n");
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) return undefined;
	try {
		const value = JSON.parse(text.slice(start, end + 1));
		return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function selectModel(ctx: ExtensionContext, configuredModel?: string) {
	if (!configuredModel) return ctx.model;
	const separator = configuredModel.indexOf("/");
	if (separator <= 0 || separator === configuredModel.length - 1) return undefined;
	return ctx.modelRegistry.find(configuredModel.slice(0, separator), configuredModel.slice(separator + 1));
}

async function completeJson(
	ctx: ExtensionContext,
	config: AdaptiveConfig,
	systemPrompt: string,
	prompt: string,
	maxTokens: number,
): Promise<Record<string, unknown> | undefined> {
	const model = selectModel(ctx, config.model);
	if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return undefined;
	const timeoutMs = config.routingTimeoutMs ?? 5000;
	const parentSignal = ctx.signal;
	const timeoutController = new AbortController();
	const onParentAbort = () => timeoutController.abort(parentSignal?.reason);
	parentSignal?.addEventListener("abort", onParentAbort, { once: true });
	const timer = setTimeout(() => timeoutController.abort(new Error("routing timeout")), timeoutMs);
	try {
		const response = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt,
				messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
			},
			{ signal: timeoutController.signal, maxTokens, cacheRetention: "none" },
		);
		if (response.stopReason === "aborted" || response.stopReason === "error") return undefined;
		return parseJsonObject(responseText(response));
	} catch (error) {
		if (timeoutController.signal.aborted && !parentSignal?.aborted) {
			console.warn(`[pi-prompt-diet] Routing LLM call timed out after ${timeoutMs}ms; keeping current capabilities.`);
		}
		return undefined;
	} finally {
		clearTimeout(timer);
		parentSignal?.removeEventListener("abort", onParentAbort);
	}
}

function strictStringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function conciseText(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function completeRules(value: unknown, maxLength: number): value is string[] {
	return Array.isArray(value) && value.length <= 4 && value.every((rule) => conciseText(rule, maxLength));
}

function isSkillCapsule(value: unknown): value is SkillCapsule {
	if (!value || typeof value !== "object") return false;
	const capsule = value as SkillCapsule;
	return typeof capsule.name === "string" && typeof capsule.filePath === "string"
		&& typeof capsule.fingerprint === "string" && conciseText(capsule.trigger, 300)
		&& conciseText(capsule.readFullWhen, 300) && completeRules(capsule.essentialRules, 300);
}

function isToolCapsule(value: unknown): value is ToolGuidelineCapsule {
	if (!value || typeof value !== "object") return false;
	const capsule = value as ToolGuidelineCapsule;
	return typeof capsule.name === "string" && typeof capsule.source === "string"
		&& typeof capsule.fingerprint === "string" && typeof capsule.reason === "string"
		&& (capsule.mode === "full" || (capsule.mode === "capsule"
			&& completeRules(capsule.essentialRules, 320) && capsule.essentialRules.length > 0));
}

export async function routeCapabilities(
	ctx: ExtensionContext,
	config: AdaptiveConfig,
	userPrompt: string,
	tools: CapabilityTool[],
	skills: CapabilitySkill[],
	cache: SkillCapsuleCache,
	context: IncrementalRouteContext = {},
): Promise<PromptRoute | undefined> {
	const activeTools = new Set(context.activeTools ?? []);
	const activeSkills = new Set(context.activeSkills ?? []);
	const inactiveTools = tools.filter((tool) => !activeTools.has(tool.name)).map((tool) => ({
		name: tool.name,
		description: compactCatalogDescription(tool.description, 220),
	}));
	const inactiveSkills = skills.filter((skill) => !activeSkills.has(skill.name)).map((skill) => {
		const capsule = getValidSkillCapsule(cache, skill);
		return {
			name: skill.name,
			description: capsule
				? compactCatalogDescription(formatSkillCapsule(capsule), 400)
				: compactCatalogDescription(skill.description, 500),
		};
	});
	if (inactiveTools.length === 0 && inactiveSkills.length === 0) return { tools: [], skills: [] };
	const pendingTask = context.pendingTask?.trim() || undefined;
	const intentSummary = context.intentSummary?.trim() || undefined;
	const recentUserRequests = [...new Set((context.recentUserRequests ?? []).map((request) => request.trim()).filter(Boolean))]
		.filter((request) => request !== pendingTask && request !== intentSummary);
	const result = await completeJson(
		ctx,
		config,
		ROUTER_SYSTEM_PROMPT,
		JSON.stringify({
			userRequest: userPrompt,
			recentUserRequests,
			pendingTask,
			intentSummary: intentSummary === pendingTask ? undefined : intentSummary,
			activeTools: [...activeTools],
			activeSkills: [...activeSkills],
			registryAdded: context.registryAdded ?? [],
			tools: inactiveTools,
			skills: inactiveSkills,
		}),
		1000,
	);
	if (!result) return undefined;

	const requestedTools = strictStringArray(result.tools);
	const requestedSkills = strictStringArray(result.skills);
	if (!requestedTools || !requestedSkills) return undefined;

	const availableTools = new Set(tools.map((tool) => tool.name));
	const availableSkills = new Set(skills.map((skill) => skill.name));
	const selectedSkills = [...new Set(requestedSkills)]
		.filter((name) => availableSkills.has(name) && !activeSkills.has(name))
		.slice(0, config.maxSkills ?? 8);
	const selectedTools = requestedTools.filter((name) => availableTools.has(name) && !activeTools.has(name));
	if (requestedTools.length + requestedSkills.length > 0 && selectedTools.length + selectedSkills.length === 0) return undefined;

	const requiredTools: string[] = [];
	if (selectedSkills.length > 0 && availableTools.has("read") && !activeTools.has("read")) requiredTools.push("read");
	const additions = [...new Set([...requiredTools, ...selectedTools])];

	return {
		tools: additions.slice(0, config.maxTools ?? 16),
		skills: [...new Set(selectedSkills)],
	};
}

export async function distillToolGuidelines(
	ctx: ExtensionContext,
	config: AdaptiveConfig,
	tool: CapabilityTool,
): Promise<ToolGuidelineCapsule | undefined> {
	const guidelines = tool.promptGuidelines ?? [];
	if (guidelines.length === 0) return undefined;
	const source = tool.sourceInfo?.source ?? "unknown";
	const fingerprint = fingerprintToolGuidelines(tool);
	const result = await completeJson(
		ctx,
		config,
		TOOL_GUIDELINE_DISTILL_SYSTEM_PROMPT,
		JSON.stringify({
			name: tool.name,
			source,
			description: tool.description,
			parameters: tool.parameters ?? null,
			promptGuidelines: guidelines,
		}),
		1400,
	);
	if (!result || (result.mode !== "full" && result.mode !== "capsule") || typeof result.reason !== "string") return undefined;
	const common = {
		name: tool.name,
		source,
		fingerprint,
		reason: compactCatalogDescription(result.reason, 300),
		generatedAt: new Date().toISOString(),
	};
	if (result.mode === "full") return { ...common, mode: "full" };
	const essentialRules = result.essentialRules;
	// Reject an unsafe summary rather than cutting off constraints or dropping rules.
	if (!completeRules(essentialRules, 320) || essentialRules.length === 0
		|| essentialRules.join("\n").length >= guidelines.join("\n").length) {
		return { ...common, mode: "full", reason: "Capsule is invalid, exceeds the rule budget, or is not shorter than the original." };
	}
	return {
		...common,
		mode: "capsule",
		essentialRules,
	};
}

export async function distillSkill(
	ctx: ExtensionContext,
	config: AdaptiveConfig,
	skill: CapabilitySkill,
): Promise<SkillCapsule | undefined> {
	const fingerprint = fingerprintSkill(skill.filePath);
	if (!fingerprint) return undefined;
	let content: string;
	try {
		content = readFileSync(skill.filePath, "utf8");
	} catch {
		return undefined;
	}
	const result = await completeJson(
		ctx,
		config,
		DISTILL_SYSTEM_PROMPT,
		`Skill name: ${skill.name}\nSkill path: ${skill.filePath}\n\n<skill>\n${content}\n</skill>`,
		1200,
	);
	if (!result || !conciseText(result.trigger, 300) || !conciseText(result.readFullWhen, 300)
		|| !completeRules(result.essentialRules, 300)) return undefined;
	return {
		name: skill.name,
		filePath: skill.filePath,
		fingerprint,
		trigger: result.trigger,
		essentialRules: result.essentialRules,
		readFullWhen: result.readFullWhen,
		generatedAt: new Date().toISOString(),
	};
}
