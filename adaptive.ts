import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface AdaptiveConfig {
	enabled?: boolean;
	model?: string;
	preflightModel?: string;
	softRouting?: boolean;
	distillSkills?: boolean;
	distillToolGuidelines?: boolean;
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

export function compactCatalogDescription(value: string, maxLength: number): string {
	const clean = value.trim().replace(/\s+/g, " ");
	if (clean.length <= maxLength) return clean;
	return `${clean.slice(0, maxLength - 3).trimEnd()}...`;
}

export function truncateHeadTail(text: string, maxLength: number, headRatio = 0.5): string {
	const clean = text.trim();
	if (clean.length <= maxLength) return clean;
	const marker = "\n... [truncated] ...\n";
	const available = maxLength - marker.length;
	if (available <= 20) return clean.slice(0, maxLength);

	const headLen = Math.floor(available * headRatio);
	const tailLen = available - headLen;
	return `${clean.slice(0, headLen).trimEnd()}${marker}${clean.slice(-tailLen).trimStart()}`;
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
	if (separator <= 0 || separator === configuredModel.length - 1) return ctx.model;
	const provider = configuredModel.slice(0, separator);
	const modelId = configuredModel.slice(separator + 1);

	// 1. Exact match
	const exact = ctx.modelRegistry.find(provider, modelId);
	if (exact) return exact;

	// 2. Case-insensitive provider match
	try {
		const all = ctx.modelRegistry.getAll?.() ?? [];
		const matched = all.find(
			(m: any) => m && m.provider && m.provider.toLowerCase() === provider.toLowerCase() && m.id === modelId
		);
		if (matched) return matched;
	} catch {}

	return ctx.model;
}

export async function completeJson(
	ctx: ExtensionContext,
	config: AdaptiveConfig,
	systemPrompt: string,
	prompt: string,
	maxTokens: number,
): Promise<Record<string, unknown> | undefined> {
	const model = selectModel(ctx, config.model);
	if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
		if (process.env.DEBUG) {
			console.error(`[pi-prompt-diet] Model not available or not authenticated: ${config.model}`);
		}
		return undefined;
	}
	try {
		const response = await ctx.modelRegistry.complete(
			model,
			{
				systemPrompt,
				messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
			},
			{ signal: ctx.signal, maxTokens, cacheRetention: "none" },
		);
		if (response.stopReason === "aborted" || response.stopReason === "error") {
			if (process.env.DEBUG) {
				console.error(`[pi-prompt-diet] preflight complete ended with stopReason: ${response.stopReason}, error: ${(response as any).errorMessage}`);
			}
			return undefined;
		}
		const parsed = parseJsonObject(responseText(response));
		if (!parsed && process.env.DEBUG) {
			console.error(`[pi-prompt-diet] Failed to parse JSON from preflight response: ${responseText(response)}`);
		}
		return parsed;
	} catch (e) {
		if (process.env.DEBUG) {
			console.error("[pi-prompt-diet] completeJson error:", e);
		}
		return undefined;
	}
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

export interface SessionStatEntry {
	promptInitialChars: number;
	promptSlimmedChars: number;
	scrubbedToolResultsCount: number;
	scrubbedSavedChars: number;
	activeTools?: string[];
	activeSkills?: string[];
	needDocs?: boolean;
	lastUpdated: string;
}

export interface DietGlobalStats {
	version: 1;
	updatedAt: string;
	totals: {
		totalPromptInitialChars: number;
		totalPromptSlimmedChars: number;
		totalCharsSaved: number;
		totalTokensSaved: number;
		totalScrubbedToolResultsCount: number;
		totalScrubbedSavedChars: number;
		totalRounds: number;
	};
	sessions: Record<string, SessionStatEntry>;
}

export function globalStatsPath(): string {
	return join(cacheRoot(), "stats.json");
}

export function loadGlobalStats(): DietGlobalStats {
	const file = globalStatsPath();
	const defaultStats: DietGlobalStats = {
		version: 1,
		updatedAt: new Date().toISOString(),
		totals: {
			totalPromptInitialChars: 0,
			totalPromptSlimmedChars: 0,
			totalCharsSaved: 0,
			totalTokensSaved: 0,
			totalScrubbedToolResultsCount: 0,
			totalScrubbedSavedChars: 0,
			totalRounds: 0,
		},
		sessions: {},
	};

	if (!existsSync(file)) return defaultStats;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		if (parsed?.version === 1 && parsed?.totals) {
			return {
				...defaultStats,
				...parsed,
				totals: { ...defaultStats.totals, ...parsed.totals },
				sessions: parsed.sessions || {},
			};
		}
	} catch {
		// Ignore parse errors on corrupted stats
	}
	return defaultStats;
}

export function loadSessionState(sessionId: string): SessionStatEntry | undefined {
	const stats = loadGlobalStats();
	return stats.sessions?.[sessionId];
}

export function saveSessionState(sessionId: string, patch: Partial<SessionStatEntry>): void {
	try {
		const stats = loadGlobalStats();
		if (!stats.sessions) stats.sessions = {};
		const existing = stats.sessions[sessionId] || {
			promptInitialChars: 0,
			promptSlimmedChars: 0,
			scrubbedToolResultsCount: 0,
			scrubbedSavedChars: 0,
			lastUpdated: new Date().toISOString(),
		};
		stats.sessions[sessionId] = {
			...existing,
			...patch,
			lastUpdated: new Date().toISOString(),
		};
		// FIFO prune to keep max 50 sessions
		const keys = Object.keys(stats.sessions);
		if (keys.length > 50) {
			delete stats.sessions[keys[0]];
		}
		writeJsonAtomic(globalStatsPath(), stats);
	} catch (err) {
		console.warn(`[pi-prompt-diet] Failed to save session state:`, err);
	}
}

export interface StatsDelta {
	promptInitialChars?: number;
	promptSlimmedChars?: number;
	scrubbedToolResultsCount?: number;
	scrubbedSavedChars?: number;
}

export function recordStatsDelta(delta: StatsDelta): void {
	try {
		const stats = loadGlobalStats();
		const initial = delta.promptInitialChars || 0;
		const slimmed = delta.promptSlimmedChars || 0;
		const promptSaved = Math.max(0, initial - slimmed);
		const scrubSaved = delta.scrubbedSavedChars || 0;
		const totalSaved = promptSaved + scrubSaved;
		const tokensSaved = Math.round(totalSaved / 4);

		stats.updatedAt = new Date().toISOString();
		stats.totals.totalPromptInitialChars += initial;
		stats.totals.totalPromptSlimmedChars += slimmed;
		stats.totals.totalCharsSaved += totalSaved;
		stats.totals.totalTokensSaved += tokensSaved;
		stats.totals.totalScrubbedToolResultsCount += (delta.scrubbedToolResultsCount || 0);
		stats.totals.totalScrubbedSavedChars += scrubSaved;
		if (initial > 0 || scrubSaved > 0) stats.totals.totalRounds += 1;

		writeJsonAtomic(globalStatsPath(), stats);
	} catch (err) {
		console.warn(`[pi-prompt-diet] Failed to record stats delta:`, err);
	}
}
