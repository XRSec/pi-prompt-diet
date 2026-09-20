import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const testHome = mkdtempSync(join(tmpdir(), "pi-prompt-diet-test-"));
process.env.HOME = testHome;

const { default: promptDiet } = await import("../index.ts");
const {
	distillSkill,
	distillToolGuidelines,
	fingerprintSkill,
	fingerprintToolGuidelines,
	getValidSkillCapsule,
	getValidToolGuidelineCapsule,
	loadSkillCapsuleCache,
	loadToolGuidelineCapsuleCache,
	saveSkillCapsule,
	saveSkillCapsuleCache,
	saveToolGuidelineCapsule,
} = await import("../adaptive.ts");

const tools = [
	{ name: "read", description: "Read a file", promptGuidelines: ["Use read for files."], sourceInfo: { source: "builtin" } },
	{ name: "web_search", description: "Search current facts", promptGuidelines: ["Use web_search for current facts."], sourceInfo: { source: "npm:web" } },
	{ name: "edit", description: "Edit files", promptGuidelines: ["Use edit precisely."], sourceInfo: { source: "builtin" } },
];

const systemPrompt = `Available tools:
- read: Read
- web_search: Search
- edit: Edit

Guidelines:
- Use read for files.
- Use web_search for current facts.
- Use edit precisely.

<available_skills>
placeholder
</available_skills>`;

function createHarness(complete, extraTools = []) {
	const handlers = new Map();
	const registeredTools = [...tools, ...extraTools];
	const commandDefinitions = new Map();
	const pi = {
		on(name, handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand(name, definition) {
			commandDefinitions.set(name, definition);
		},
		getAllTools: () => registeredTools,
		getActiveTools: () => registeredTools.map((t) => t.name),
	};
	promptDiet(pi);
	const ctx = {
		cwd: process.cwd(),
		hasUI: false,
		signal: undefined,
		model: { provider: "test", id: "distiller" },
		modelRegistry: {
			hasConfiguredAuth: () => true,
			find: () => undefined,
			complete,
		},
		sessionManager: { getBranch: () => [] },
	};
	return {
		async emit(name, event, overrideCtx = ctx) {
			let result;
			for (const handler of handlers.get(name) ?? []) result = await handler(event, overrideCtx);
			return result;
		},
		async executeCommand(name, args = "") {
			return commandDefinitions.get(name).handler(args, ctx);
		},
		ctx,
	};
}

function createSkills(prefix) {
	const weatherDirectory = join(testHome, prefix, "weather-helper");
	const otherDirectory = join(testHome, prefix, "other");
	mkdirSync(weatherDirectory, { recursive: true });
	mkdirSync(otherDirectory, { recursive: true });
	const weatherPath = join(weatherDirectory, "SKILL.md");
	const otherPath = join(otherDirectory, "SKILL.md");
	writeFileSync(weatherPath, "# Weather helper\nUse this for current weather. Always verify freshness.");
	writeFileSync(otherPath, "# Other\nUnrelated.");
	return {
		weatherPath,
		skills: [
			{ name: "weather-helper", description: "Long original weather helper description.", filePath: weatherPath, sourceInfo: { source: "user" } },
			{ name: "other", description: "Unrelated skill.", filePath: otherPath, sourceInfo: { source: "user" } },
		],
	};
}

function eventFor(skills) {
	return {
		prompt: "What is the weather?",
		systemPrompt,
		systemPromptOptions: { skills, promptGuidelines: tools.flatMap((tool) => tool.promptGuidelines) },
	};
}

test("skill distillation creates and reuses a content-addressed capsule", async () => {
	const { skills, weatherPath } = createSkills("lifecycle");
	let completions = 0;
	const harness = createHarness(async (_model, request) => {
		completions += 1;
		const text = '{"trigger":"Use for current weather.","essentialRules":["Verify freshness."],"readFullWhen":"provider details are needed."}';
		return { stopReason: "stop", content: [{ type: "text", text }] };
	});

	await harness.emit("session_start", { reason: "startup" }, harness.ctx);
	const cold = await harness.emit("before_agent_start", eventFor(skills), harness.ctx);
	assert.equal(completions, 0);
	assert.match(cold.systemPrompt, /Long original weather helper description/);

	await harness.emit("tool_result", { toolName: "read", isError: false, input: { path: weatherPath } }, harness.ctx);
	await harness.emit("agent_settled", {}, harness.ctx);
	assert.equal(completions, 1);

	await harness.emit("session_start", { reason: "new" }, harness.ctx);
	const warm = await harness.emit("before_agent_start", eventFor(skills), harness.ctx);
	assert.equal(completions, 1);
	assert.match(warm.systemPrompt, /Verify freshness/);
	assert.doesNotMatch(warm.systemPrompt, /Long original weather helper description/);

	writeFileSync(weatherPath, `${readFileSync(weatherPath, "utf8")}\nNew rule.`);
	await harness.emit("session_start", { reason: "new" }, harness.ctx);
	const invalidated = await harness.emit("before_agent_start", eventFor(skills), harness.ctx);
	assert.match(invalidated.systemPrompt, /Long original weather helper description/);
});

test("a used third-party tool is distilled once and its capsule replaces cold full guidelines", async () => {
	const pluginTool = {
		name: "plugin_search",
		description: "Search plugin data.",
		parameters: { type: "object", properties: { query: { type: "string" } } },
		promptGuidelines: [
			"plugin_search matches complete logical paths, not only leaf names.",
			"plugin_search uses query for fuzzy matching and exactPath for exact matching.",
		],
		sourceInfo: { source: "npm:test-plugin", path: "/test/plugin.ts" },
	};
	let completions = 0;
	const harness = createHarness(async (_model, request) => {
		completions += 1;
		return { stopReason: "stop", content: [{ type: "text", text: '{"mode":"capsule","essentialRules":["plugin_search: query is fuzzy; use exactPath for exact matching."],"reason":"The path rule can be combined without loss."}' }] };
	}, [pluginTool]);
	const pluginPrompt = `Available tools:\n- read: Read\n- web_search: Search\n- edit: Edit\n- plugin_search: Search plugin data\n\nGuidelines:\n- Use read for files.\n- Use web_search for current facts.\n- Use edit precisely.\n- ${pluginTool.promptGuidelines[0]}\n- ${pluginTool.promptGuidelines[1]}\n\n<available_skills>\nplaceholder\n</available_skills>`;
	const event = { prompt: "Search plugin data", systemPrompt: pluginPrompt, systemPromptOptions: { skills: [], promptGuidelines: [...tools.flatMap((tool) => tool.promptGuidelines), ...pluginTool.promptGuidelines] } };

	await harness.emit("session_start", { reason: "startup" }, harness.ctx);
	const cold = await harness.emit("before_agent_start", event, harness.ctx);
	assert.match(cold.systemPrompt, /matches complete logical paths/);
	assert.match(cold.systemPrompt, /uses query for fuzzy matching/);

	await harness.emit("tool_result", { toolName: "plugin_search", isError: false, input: { query: "x" } }, harness.ctx);
	await harness.emit("agent_settled", {}, harness.ctx);
	assert.equal(completions, 1);

	await harness.emit("session_start", { reason: "new" }, harness.ctx);
	const warm = await harness.emit("before_agent_start", event, harness.ctx);
	assert.match(warm.systemPrompt, /query is fuzzy; use exactPath/);
	assert.doesNotMatch(warm.systemPrompt, /matches complete logical paths/);
});

test("an already concise third-party guideline decision stays full until metadata changes", () => {
	const tool = {
		name: "dense_tool",
		description: "Dense tool.",
		parameters: { type: "object" },
		promptGuidelines: ["dense_tool must preserve this complete rule."],
		sourceInfo: { source: "npm:dense", path: "/dense.ts" },
	};
	const cache = loadToolGuidelineCapsuleCache();
	const key = "npm:dense:dense_tool";
	cache.tools[key] = {
		name: tool.name,
		source: tool.sourceInfo.source,
		fingerprint: fingerprintToolGuidelines(tool),
		mode: "full",
		reason: "Already concise.",
		generatedAt: "now",
	};
	saveToolGuidelineCapsule(cache, key);
	assert.equal(getValidToolGuidelineCapsule(loadToolGuidelineCapsuleCache(), tool)?.mode, "full");
	tool.promptGuidelines.push("A new rule.");
	assert.equal(getValidToolGuidelineCapsule(loadToolGuidelineCapsuleCache(), tool), undefined);
});

test("CAS check rejects stale capsule writes if source was modified concurrently", async () => {
	const { weatherPath } = createSkills("cas");
	const cache = loadSkillCapsuleCache();
	const initialFingerprint = fingerprintSkill(weatherPath);
	cache.skills[weatherPath] = {
		name: "weather-helper",
		filePath: weatherPath,
		fingerprint: initialFingerprint,
		trigger: "Test",
		essentialRules: ["Test rule"],
		readFullWhen: "Always",
		generatedAt: "now",
	};

	writeFileSync(weatherPath, `${readFileSync(weatherPath, "utf8")}\nConcurrent modification.`);
	const saved = saveSkillCapsule(cache, weatherPath, initialFingerprint);
	assert.equal(saved, false);
});

test("pi-prompt-diet command reports cache status", async () => {
	const harness = createHarness(async () => ({ stopReason: "stop", content: [{ type: "text", text: "{}" }] }));
	await harness.emit("session_start", { reason: "startup" }, harness.ctx);
	await harness.emit("before_agent_start", eventFor([]), harness.ctx);

	const output = await harness.executeCommand("pi-prompt-diet");
	assert.match(output, /=== pi-prompt-diet Status ===/);
	assert.match(output, /Total Tools/);
	assert.match(output, /Skill Capsules in Cache/);
	assert.match(output, /Tool Guideline Capsules in Cache/);
});

test("stale cache snapshots cannot overwrite unrelated Skill capsules", () => {
	const first = loadSkillCapsuleCache();
	const second = loadSkillCapsuleCache();
	first.skills["/skill/one"] = {
		name: "one", filePath: "/skill/one", fingerprint: "one", trigger: "one", essentialRules: [], readFullWhen: "needed", generatedAt: "now",
	};
	second.skills["/skill/two"] = {
		name: "two", filePath: "/skill/two", fingerprint: "two", trigger: "two", essentialRules: [], readFullWhen: "needed", generatedAt: "now",
	};
	saveSkillCapsuleCache(first);
	saveSkillCapsuleCache(second);
	const merged = loadSkillCapsuleCache();
	assert.ok(merged.skills["/skill/one"]);
	assert.ok(merged.skills["/skill/two"]);
});

test("warm Skill capsules retain complete constraints beyond the description limit", async () => {
	const { skills, weatherPath } = createSkills("complete-capsule");
	const rule = `Before publishing a forecast, ${"verify the source and timestamp; ".repeat(6)}never fabricate missing readings.`;
	const cache = loadSkillCapsuleCache();
	cache.skills[weatherPath] = {
		name: "weather-helper", filePath: weatherPath, fingerprint: fingerprintSkill(weatherPath),
		trigger: "Use for current weather.", essentialRules: [rule], readFullWhen: "using provider-specific workflows.", generatedAt: "now",
	};
	saveSkillCapsuleCache(cache);
	const harness = createHarness(async () => ({ stopReason: "stop", content: [{ type: "text", text: "{}" }] }));
	const result = await harness.emit("before_agent_start", eventFor(skills));
	assert.ok(result.systemPrompt.includes(rule));
	assert.match(result.systemPrompt, /never fabricate missing readings/);
});

test("unsafe or non-saving tool distillations keep the full original guidelines", async () => {
	const tool = { ...tools[1], promptGuidelines: ["Never publish unverified data."] };
	for (const essentialRules of [["x".repeat(321)], ["one", "two", "three", "four", "Never publish"], [""], [null], ["A longer summary that provides no character savings over the original rule."]]) {
		const harness = createHarness(async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ mode: "capsule", essentialRules, reason: "Shorten" }) }] }));
		assert.equal((await distillToolGuidelines(harness.ctx, {}, tool)).mode, "full");
	}
});

test("invalid Skill distillations fall back instead of truncating operational rules", async () => {
	const { skills } = createSkills("invalid-distillation");
	for (const essentialRules of [["x".repeat(301)], ["one", "two", "three", "four", "Never publish"], [""], [null], undefined]) {
		const harness = createHarness(async () => ({ stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ trigger: "Weather", essentialRules, readFullWhen: "Needed" }) }] }));
		assert.equal(await distillSkill(harness.ctx, {}, skills[0]), undefined);
	}
});

test("malformed disk caches are ignored even when their fingerprints match", () => {
	const { skills, weatherPath } = createSkills("invalid-cache");
	const skillCache = { version: 1, skills: { [weatherPath]: { name: "weather-helper", filePath: weatherPath, fingerprint: fingerprintSkill(weatherPath) } } };
	const tool = tools[1];
	const key = "npm:web:web_search";
	const toolCache = { version: 1, tools: { [key]: { name: tool.name, source: "npm:web", fingerprint: fingerprintToolGuidelines(tool), mode: "capsule", reason: "Missing rules" } } };
	saveSkillCapsuleCache(skillCache);
	saveToolGuidelineCapsule(toolCache, key);
	assert.equal(getValidSkillCapsule(skillCache, skills[0]), undefined);
	assert.equal(getValidToolGuidelineCapsule(toolCache, tool), undefined);
	assert.equal(loadSkillCapsuleCache().skills[weatherPath], undefined);
	assert.equal(loadToolGuidelineCapsuleCache().tools[key], undefined);
});

test("before_agent_start processes guidelines and skills without routing", async () => {
	const { skills } = createSkills("no-routing");
	const harness = createHarness(async () => { throw new Error("Must not call the model"); });
	await harness.emit("session_start", { reason: "startup" }, harness.ctx);
	const result = await harness.emit("before_agent_start", eventFor(skills), harness.ctx);
	assert.ok(result.systemPrompt);
	assert.match(result.systemPrompt, /Guidelines:/);
	assert.match(result.systemPrompt, /<name>weather-helper<\/name>/);
	assert.match(result.systemPrompt, /<name>other<\/name>/);
	assert.doesNotMatch(result.systemPrompt, /Use read for files/);
	assert.doesNotMatch(result.systemPrompt, /Use edit precisely/);
});

test.after(() => rmSync(testHome, { recursive: true, force: true }));
