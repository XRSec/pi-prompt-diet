import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const testHome = mkdtempSync(join(tmpdir(), "pi-prompt-diet-test-"));
process.env.HOME = testHome;

const { default: promptDiet } = await import("../index.ts");
const {
	compactCatalogDescription,
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
	truncateHeadTail,
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

function createHarness(complete, extraTools = [], configOverride = {}) {
	const harnessDir = mkdtempSync(join(testHome, "harness-"));
	mkdirSync(join(harnessDir, ".pi"), { recursive: true });
	writeFileSync(join(harnessDir, ".pi", "pi-prompt-diet.json"), JSON.stringify({
		adaptive: {
			softRouting: false,
			distillSkills: true,
			distillToolGuidelines: true,
			...configOverride.adaptive,
		},
		...configOverride,
	}));

	const handlers = new Map();
	const registeredTools = [...tools, ...extraTools];
	let activeTools = registeredTools.map((t) => t.name);
	const commandDefinitions = new Map();
	const registeredToolDefs = new Map();
	const pi = {
		on(name, handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand(name, definition) {
			commandDefinitions.set(name, definition);
		},
		registerTool(definition) {
			registeredToolDefs.set(definition.name, definition);
		},
		getAllTools: () => registeredTools,
		getActiveTools: () => activeTools,
		setActiveTools(names) {
			activeTools = names;
		},
	};
	promptDiet(pi);
	const ctx = {
		cwd: harnessDir,
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
		registeredToolDefs,
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

test("truncateHeadTail preserves both head intent and tail error context", () => {
	const text = "HEADER: Task initialization and background information.\n" +
		"MIDDLE: " + "step repeating details. ".repeat(40) + "\n" +
		"TAIL: Critical error trace and latest user supplement.";
	const truncated = truncateHeadTail(text, 120, 0.45);
	assert.ok(truncated.includes("HEADER: Task initialization"));
	assert.ok(truncated.includes("... [truncated] ..."));
	assert.ok(truncated.includes("Critical error trace"));
	assert.ok(truncated.length <= 130);
});

test("preflight routing failure falls back to fail-open and unrouted skills appear as inactive notice", async () => {
	const { skills } = createSkills("soft-routing-skills");
	// 模拟预检成功，仅路由出 weather-helper，other 成为 inactive skill
	const harness = createHarness(async () => ({
		stopReason: "stop",
		content: [{ type: "text", text: '{"focus_tools":["read"],"focus_skills":["weather-helper"],"need_docs":false}' }],
	}), [], { adaptive: { softRouting: true } });
	await harness.emit("session_start", { reason: "startup" }, harness.ctx);
	const routed = await harness.emit("before_agent_start", eventFor(skills), harness.ctx);
	assert.match(routed.systemPrompt, /<name>weather-helper<\/name>/);
	assert.doesNotMatch(routed.systemPrompt, /<name>other<\/name>/);
	assert.match(routed.systemPrompt, /Inactive skills \(names only; call request_capabilities with skill name to activate\):\s*other/);
});

test("preflight complete exception triggers fail-open preserving all tools and skills", async () => {
	const { skills } = createSkills("fail-open");
	const harness = createHarness(async () => {
		throw new Error("Network timeout to preflight model");
	}, [], { adaptive: { softRouting: true } });
	await harness.emit("session_start", { reason: "startup" }, harness.ctx);
	const result = await harness.emit("before_agent_start", eventFor(skills), harness.ctx);
	// Fail-open: all tools and skills remain active
	assert.ok(result.systemPrompt);
	assert.match(result.systemPrompt, /<name>weather-helper<\/name>/);
	assert.match(result.systemPrompt, /<name>other<\/name>/);
	assert.doesNotMatch(result.systemPrompt, /Inactive skills/);
});

test("context event injects preflight hints into last user message safely and idempotently", async () => {
	const { skills } = createSkills("context-injection");
	const harness = createHarness(async () => ({
		stopReason: "stop",
		content: [{ type: "text", text: '{"focus_tools":["read"],"focus_skills":["weather-helper"],"need_docs":false}' }],
	}), [], { adaptive: { softRouting: true } });
	await harness.emit("session_start", { reason: "startup" }, harness.ctx);
	await harness.emit("before_agent_start", eventFor(skills), harness.ctx);

	const originalMessages = [
		{ role: "user", content: [{ type: "text", text: "Check today weather" }] }
	];
	const contextRes1 = await harness.emit("context", { messages: originalMessages }, harness.ctx);
	assert.ok(contextRes1.messages[0].content[0].text.includes("<system_directive>Preflight route: focus on skills: [weather-helper] and tools: [read]."));
	assert.ok(contextRes1.messages[0].content[0].text.includes("Check today weather"));
	// Original message remains untouched
	assert.equal(originalMessages[0].content[0].text, "Check today weather");

	// Second call with the transformed messages must be idempotent
	const contextRes2 = await harness.emit("context", { messages: contextRes1.messages }, harness.ctx);
	const directiveCount = (contextRes2.messages[0].content[0].text.match(/<system_directive>/g) || []).length;
	assert.equal(directiveCount, 1);
});

test("pure affirmative continuations bypass preflight model call", async () => {
	const { skills } = createSkills("continuations");
	let modelCalled = false;
	const harness = createHarness(async () => {
		modelCalled = true;
		return { stopReason: "stop", content: [{ type: "text", text: "{}" }] };
	}, [], { adaptive: { softRouting: true } });

	for (const phrase of ["ok go", "go", "ok", "proceed", "继续吧", "收到", "yes"]) {
		modelCalled = false;
		const event = { ...eventFor(skills), prompt: phrase };
		await harness.emit("before_agent_start", event, harness.ctx);
		assert.equal(modelCalled, false, `Expected '${phrase}' to bypass preflight`);
	}
});

test("call_tool meta-tool executes inactive tools directly in a single turn", async () => {
	let executedWith = null;
	const customTool = {
		name: "pi_custom_action",
		description: "Perform custom action",
		promptGuidelines: [],
		sourceInfo: { source: "test" },
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			executedWith = params;
			return { content: [{ type: "text", text: `Success: ${params.foo}` }] };
		},
	};
	const harness = createHarness(async () => ({
		stopReason: "stop",
		content: [{ type: "text", text: "{}" }],
	}), [customTool], { adaptive: { softRouting: false } });

	const callToolDef = harness.registeredToolDefs.get("call_tool");
	assert.ok(callToolDef, "call_tool should be registered");

	const res = await callToolDef.execute("call-1", { tool: "pi_custom_action", parameters: { foo: "bar" } }, undefined, undefined, harness.ctx);
	assert.equal(executedWith?.foo, "bar");
	assert.equal(res.content[0].text, "Success: bar");
});

test("promptDiet removes Pi default 'Use bash for file operations like ls, rg, find' guideline", async () => {
	const harness = createHarness(async () => ({
		stopReason: "stop",
		content: [{ type: "text", text: "{}" }],
	}));
	const messyPrompt = `Available tools:\n- bash\n\nGuidelines:\n- Use bash for file operations like ls, rg, find, etc.\n- Do other stuff.`;
	const result = await harness.emit("before_agent_start", { systemPrompt: messyPrompt, prompt: "do something" }, harness.ctx);
	assert.doesNotMatch(result.systemPrompt, /Use bash for file operations like ls, rg, find/i);
});

test.after(() => rmSync(testHome, { recursive: true, force: true }));
