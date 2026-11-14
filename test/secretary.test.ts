/**
 * THU-106 单元测试：/secretary 扩展（factory 闭包开关 + 自有 section 注入）。
 *
 * 这些测试直接 import 包内 `index.ts` 的默认 factory，
 * 用最小 mock 的 `pi` / command ctx 驱动，不启动真实 Pi 进程、不发任何模型请求。
 * 真实 Pi SDK 的 stub-provider 捕获测试见 `secretary.sdk.test.ts`。
 *
 * 运行：bun test test/secretary.test.ts
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_PATH = join(dirname(fileURLToPath(import.meta.url)), "../index.ts");

/** 与扩展正文里唯一身份标识一致的标记（`body/identity.md` 的 H1）。 */
const IDENTITY_MARKER = "WF-002 Secretary / Router 注入提示";
/** 扩展自有 section key（XML tag 名）。 */
const SECTION_KEY = "secretary";
/** 项目级覆盖正文的位置（优先级高于包内 `body/identity.md`）。 */
const BODY_FILENAME = ".pi/secretary-identity.md";

type Handler = (event: any, ctx: any) => any;

interface MockPi {
	handlers: Map<string, Handler[]>;
	commands: Map<string, { description: string; handler: (args: string, ctx: any) => Promise<void> }>;
	tools: Map<string, any>;
	activeTools: string[];
	modelCalls: string[];
	on(event: string, handler: Handler): () => void;
	registerCommand(name: string, def: any): void;
	registerTool(def: any): void;
	getActiveTools(): string[];
	sendUserMessage(...args: unknown[]): void;
	sendMessage(...args: unknown[]): void;
}

function makeMockPi(): MockPi {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map();
	const tools = new Map();
	const activeTools: string[] = [];
	const modelCalls: string[] = [];
	return {
		handlers,
		commands,
		tools,
		activeTools,
		modelCalls,
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand(name, def) {
			commands.set(name, def);
		},
		registerTool(def) {
			tools.set(def.name, def);
		},
		getActiveTools() {
			return [...activeTools];
		},
		sendUserMessage(...args) {
			modelCalls.push(`sendUserMessage:${JSON.stringify(args)}`);
		},
		sendMessage(...args) {
			modelCalls.push(`sendMessage:${JSON.stringify(args)}`);
		},
	};
}

interface MockCtx {
	cwd: string;
	notifications: Array<{ message: string; type?: string }>;
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
	getSystemPromptOptions: () => { appendSystemPrompt?: string; sections?: Record<string, string> };
}

function makeMockCtx(cwd: string, basePromptOptions: Record<string, unknown> = {}): MockCtx {
	const notifications: Array<{ message: string; type?: string }> = [];
	return {
		cwd,
		notifications,
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
		},
		getSystemPromptOptions: () => ({ ...basePromptOptions }) as any,
	};
}

/** 造一个临时“仓库”：tmp/.pi/secretary-identity.md（项目级覆盖），可再建子目录。 */
function makeFakeRepo(body: string): { repo: string; bodyPath: string; cleanup: () => void } {
	const repo = mkdtempSync(join(tmpdir(), "wf004-secretary-test-"));
	const bodyPath = join(repo, BODY_FILENAME);
	mkdirSync(dirname(bodyPath), { recursive: true });
	writeFileSync(bodyPath, body, "utf8");
	return { repo, bodyPath, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}

const FAKE_BODY = `# ${IDENTITY_MARKER}\n\n你是测试身份正文。\n`;
const EMPTY_BODY = "   \n\t\n";

/** 触发 before_agent_start（所有已注册 handler，模拟 Pi 的 chained 派发）。 */
async function fireBeforeAgentStart(pi: MockPi, sections: Record<string, string>, systemPrompt = "") {
	const event = {
		type: "before_agent_start",
		messageType: "user",
		prompt: "hello",
		systemPrompt,
		systemPromptOptions: { cwd: "/tmp", sections },
	};
	for (const h of pi.handlers.get("before_agent_start") ?? []) {
		await h(event, {});
	}
	return event;
}

async function fireSessionStart(pi: MockPi, reason: string) {
	for (const h of pi.handlers.get("session_start") ?? []) {
		await h({ type: "session_start", reason }, {});
	}
}

async function runCommand(pi: MockPi, args: string, ctx: MockCtx) {
	const def = pi.commands.get("secretary");
	if (!def) throw new Error("command /secretary not registered");
	await def.handler(args, ctx);
}

let factory: (pi: MockPi) => void;

beforeEach(async () => {
	const mod = await import(EXTENSION_PATH);
	factory = mod.default;
});

describe("/secretary 命令注册与参数解析", () => {
	test("注册名为 secretary 的命令", () => {
		const pi = makeMockPi();
		factory(pi);
		expect(pi.commands.has("secretary")).toBe(true);
	});

	test("无参 / on 幂等开启；status 不改状态；off 关闭", async () => {
		const { repo, cleanup } = makeFakeRepo(FAKE_BODY);
		try {
			const pi = makeMockPi();
			factory(pi);
			const ctx = makeMockCtx(repo);

			await runCommand(pi, "", ctx); // 无参 = 开启
			await runCommand(pi, "on", ctx); // on 再开一次，幂等
			const sectionsAfterOn: Record<string, string> = { other: "keep-me" };
			await fireBeforeAgentStart(pi, sectionsAfterOn);
			expect(sectionsAfterOn[SECTION_KEY]).toContain(IDENTITY_MARKER);

			await runCommand(pi, "status", ctx); // status 不改状态
			const sectionsStatus: Record<string, string> = {};
			await fireBeforeAgentStart(pi, sectionsStatus);
			expect(sectionsStatus[SECTION_KEY]).toContain(IDENTITY_MARKER);

			await runCommand(pi, "off", ctx);
			const sectionsOff: Record<string, string> = {};
			await fireBeforeAgentStart(pi, sectionsOff);
			expect(sectionsOff[SECTION_KEY]).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	test("非法参数：报用法错误且状态不变（开→仍开）", async () => {
		const { repo, cleanup } = makeFakeRepo(FAKE_BODY);
		try {
			const pi = makeMockPi();
			factory(pi);
			const ctx = makeMockCtx(repo);
			await runCommand(pi, "on", ctx);

			await runCommand(pi, "banana", ctx);
			const errNotify = ctx.notifications.find((n) => n.type === "error");
			expect(errNotify).toBeDefined();
			expect(errNotify!.message).toContain("用法");

			const sections: Record<string, string> = {};
			await fireBeforeAgentStart(pi, sections);
			expect(sections[SECTION_KEY]).toContain(IDENTITY_MARKER); // 状态未变
		} finally {
			cleanup();
		}
	});

	test("off / status 诚实说明只控制扩展，不能撤销旧 CLI 追加或历史", async () => {
		const { repo, cleanup } = makeFakeRepo(FAKE_BODY);
		try {
			const pi = makeMockPi();
			factory(pi);
			const ctx = makeMockCtx(repo);
			await runCommand(pi, "on", ctx);
			ctx.notifications.length = 0;
			await runCommand(pi, "off", ctx);
			expect(ctx.notifications.some((n) => /只控制|only controls/.test(n.message))).toBe(true);
			expect(ctx.notifications.some((n) => /不能|cannot/i.test(n.message))).toBe(true);

			ctx.notifications.length = 0;
			await runCommand(pi, "status", ctx);
			const statusText = ctx.notifications.map((n) => n.message).join("\n");
			expect(/只控制|only controls/.test(statusText)).toBe(true);
			expect(/CLI/.test(statusText)).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("命令本身绝不触达模型路径 API（sendUserMessage/sendMessage 零调用）", async () => {
		const { repo, cleanup } = makeFakeRepo(FAKE_BODY);
		try {
			const pi = makeMockPi();
			factory(pi);
			const ctx = makeMockCtx(repo);
			for (const args of ["", "on", "off", "status", "bad-arg"]) {
				await runCommand(pi, args, ctx);
			}
			expect(pi.modelCalls).toEqual([]);
		} finally {
			cleanup();
		}
	});
});

describe("正文读取与失败降级", () => {
	test("on 每次重新读取正文（文件更新后下一次 on 生效新内容）", async () => {
		const { repo, bodyPath, cleanup } = makeFakeRepo(FAKE_BODY);
		try {
			const pi = makeMockPi();
			factory(pi);
			const ctx = makeMockCtx(repo);
			await runCommand(pi, "on", ctx);
			const s1: Record<string, string> = {};
			await fireBeforeAgentStart(pi, s1);
			expect(s1[SECTION_KEY]).toContain("你是测试身份正文");

			writeFileSync(bodyPath, `# ${IDENTITY_MARKER}\n\n更新后的正文 v2。\n`, "utf8");
			await runCommand(pi, "on", ctx);
			const s2: Record<string, string> = {};
			await fireBeforeAgentStart(pi, s2);
			expect(s2[SECTION_KEY]).toContain("更新后的正文 v2");
		} finally {
			cleanup();
		}
	});

	test("项目覆盖被删后重开：回落包内正文，不静默沿用旧缓存", async () => {
		const { repo, bodyPath, cleanup } = makeFakeRepo(FAKE_BODY);
		try {
			const pi = makeMockPi();
			factory(pi);
			const ctx = makeMockCtx(repo);
			await runCommand(pi, "on", ctx);
			const before: Record<string, string> = {};
			await fireBeforeAgentStart(pi, before);
			expect(before[SECTION_KEY]).toContain("测试身份正文");

			rmSync(bodyPath);
			await runCommand(pi, "on", ctx); // 重开：项目覆盖已不存在
			expect(ctx.notifications.some((n) => n.type === "error")).toBe(false);

			const sections: Record<string, string> = {};
			await fireBeforeAgentStart(pi, sections);
			// 用的是包内正文，不是旧缓存的覆盖正文。
			expect(sections[SECTION_KEY]).toContain(IDENTITY_MARKER);
			expect(sections[SECTION_KEY]).not.toContain("测试身份正文");
		} finally {
			cleanup();
		}
	});

	test("正文为空（仅空白）：报错并降为 off", async () => {
		const { repo, cleanup } = makeFakeRepo(EMPTY_BODY);
		try {
			const pi = makeMockPi();
			factory(pi);
			const ctx = makeMockCtx(repo);
			await runCommand(pi, "on", ctx);
			expect(ctx.notifications.some((n) => n.type === "error")).toBe(true);

			const sections: Record<string, string> = {};
			await fireBeforeAgentStart(pi, sections);
			expect(sections[SECTION_KEY]).toBeUndefined();
		} finally {
			cleanup();
		}
	});

	test("从仓库子目录启动也能定位正文（向上搜索）", async () => {
		const { repo, cleanup } = makeFakeRepo(FAKE_BODY);
		try {
			const deep = join(repo, "src/sub/deep");
			mkdirSync(deep, { recursive: true });
			const pi = makeMockPi();
			factory(pi);
			const ctx = makeMockCtx(deep);
			await runCommand(pi, "on", ctx);
			expect(ctx.notifications.some((n) => n.type === "error")).toBe(false);

			const sections: Record<string, string> = {};
			await fireBeforeAgentStart(pi, sections);
			expect(sections[SECTION_KEY]).toContain(IDENTITY_MARKER);
		} finally {
			cleanup();
		}
	});

	test("cwd 与任何仓库无关：仍用包内正文（不依赖宿主仓库，也不跨仓库借用覆盖）", async () => {
		const pi = makeMockPi();
		factory(pi);
		const ctx = makeMockCtx(join(tmpdir(), "definitely-not-a-repo"));
		await runCommand(pi, "on", ctx);
		expect(ctx.notifications.some((n) => n.type === "error")).toBe(false);

		const sections: Record<string, string> = {};
		await fireBeforeAgentStart(pi, sections);
		expect(sections[SECTION_KEY]).toBeDefined();
		expect(sections[SECTION_KEY]).toContain(IDENTITY_MARKER);
	});
});

for (const gitKind of ["directory", "file"] as const) {
	test(`项目级覆盖不穿过最近的 .git ${gitKind} 边界（回落到包内正文）`, async () => {
		const outer = makeFakeRepo(FAKE_BODY + "OUTER_OVERRIDE\n");
		try {
			const inner = join(outer.repo, "independent-project");
			mkdirSync(inner);
			if (gitKind === "directory") mkdirSync(join(inner, ".git"));
			else writeFileSync(join(inner, ".git"), "gitdir: /unused/worktree-metadata\n");
			const cwd = join(inner, "nested");
			mkdirSync(cwd);
			const pi = makeMockPi();
			factory(pi);
			const ctx = makeMockCtx(cwd);
			await runCommand(pi, "on", ctx);
			expect(ctx.notifications.some((n) => n.type === "error")).toBe(false);
			const sections: Record<string, string> = {};
			await fireBeforeAgentStart(pi, sections);
			// 内层是独立仓库：不继承外层覆盖，用包内正文。
			expect(sections[SECTION_KEY]).toContain(IDENTITY_MARKER);
			expect(sections[SECTION_KEY]).not.toContain("OUTER_OVERRIDE");

			// 独立仓库自带覆盖时，仍可从其子目录生效。
			mkdirSync(join(inner, ".pi"), { recursive: true });
			writeFileSync(join(inner, BODY_FILENAME), FAKE_BODY + "INNER_PROJECT_ONLY\n");
			await runCommand(pi, "on", ctx);
			await fireBeforeAgentStart(pi, sections);
			expect(sections[SECTION_KEY]).toContain("INNER_PROJECT_ONLY");
		} finally {
			outer.cleanup();
		}
	});
}

describe("before_agent_start 注入行为", () => {
	test("只写自有 key，不动其他 sections / 不返回整段 systemPrompt", async () => {
		const { repo, cleanup } = makeFakeRepo(FAKE_BODY);
		try {
			const pi = makeMockPi();
			factory(pi);
			await runCommand(pi, "on", makeMockCtx(repo));

			const sections: Record<string, string> = {
				common_rules: "公共硬规则",
				another_ext: "别的扩展的段",
			};
			let returned: unknown = "unset";
			for (const h of pi.handlers.get("before_agent_start") ?? []) {
				returned = await h(
					{
						type: "before_agent_start",
						messageType: "user",
						prompt: "hi",
						systemPrompt: "base prompt",
						systemPromptOptions: { cwd: repo, sections },
					},
					{},
				);
			}
			expect(sections.common_rules).toBe("公共硬规则");
			expect(sections.another_ext).toBe("别的扩展的段");
			expect(sections[SECTION_KEY]).toContain(IDENTITY_MARKER);
			expect(Object.keys(sections).sort()).toEqual(["another_ext", "common_rules", SECTION_KEY].sort());
			expect(returned).toBeUndefined(); // 只变更 sections，不替换 systemPrompt
		} finally {
			cleanup();
		}
	});

	test("messageType=custom 的 run 同样注入", async () => {
		const { repo, cleanup } = makeFakeRepo(FAKE_BODY);
		try {
			const pi = makeMockPi();
			factory(pi);
			await runCommand(pi, "on", makeMockCtx(repo));

			const sections: Record<string, string> = {};
			for (const h of pi.handlers.get("before_agent_start") ?? []) {
				await h(
					{
						type: "before_agent_start",
						messageType: "custom",
						message: { customType: "x", content: "go" },
						systemPrompt: "base",
						systemPromptOptions: { cwd: repo, sections },
					},
					{},
				);
			}
			expect(sections[SECTION_KEY]).toContain(IDENTITY_MARKER);
		} finally {
			cleanup();
		}
	});

	test("off 后下一次注入剥除自有 key（防御性 delete）", async () => {
		const { repo, cleanup } = makeFakeRepo(FAKE_BODY);
		try {
			const pi = makeMockPi();
			factory(pi);
			const ctx = makeMockCtx(repo);
			await runCommand(pi, "on", ctx);
			await runCommand(pi, "off", ctx);

			// 有人（异常路径）预置了自有 key —— off 状态下必须剥掉
			const sections: Record<string, string> = { [SECTION_KEY]: "残留", keep: "x" };
			await fireBeforeAgentStart(pi, sections);
			expect(sections[SECTION_KEY]).toBeUndefined();
			expect(sections.keep).toBe("x");
		} finally {
			cleanup();
		}
	});

	test("legacy 去重：systemPrompt 已含唯一身份标识时不重复注入", async () => {
		const { repo, cleanup } = makeFakeRepo(FAKE_BODY);
		try {
			const pi = makeMockPi();
			factory(pi);
			await runCommand(pi, "on", makeMockCtx(repo));

			const sections: Record<string, string> = {};
			await fireBeforeAgentStart(pi, sections, `base prompt\n\n# ${IDENTITY_MARKER}\n正文已在 CLI 显式注入。`);
			expect(sections[SECTION_KEY]).toBeUndefined();
		} finally {
			cleanup();
		}
	});
});

describe("会话生命周期", () => {
	test("session_start 五种 reason 全部复位为 off", async () => {
		const { repo, cleanup } = makeFakeRepo(FAKE_BODY);
		try {
			for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
				const pi = makeMockPi();
				factory(pi);
				await runCommand(pi, "on", makeMockCtx(repo));
				await fireSessionStart(pi, reason);
				const sections: Record<string, string> = {};
				await fireBeforeAgentStart(pi, sections);
				expect(sections[SECTION_KEY]).toBeUndefined();
			}
		} finally {
			cleanup();
		}
	});

	test("tree 导航（session_tree 事件）不清状态", async () => {
		const { repo, cleanup } = makeFakeRepo(FAKE_BODY);
		try {
			const pi = makeMockPi();
			factory(pi);
			await runCommand(pi, "on", makeMockCtx(repo));
			for (const h of pi.handlers.get("session_tree") ?? []) {
				await h({ type: "session_tree", newLeafId: "x", oldLeafId: "y" }, {});
			}
			const sections: Record<string, string> = {};
			await fireBeforeAgentStart(pi, sections);
			expect(sections[SECTION_KEY]).toContain(IDENTITY_MARKER);
		} finally {
			cleanup();
		}
	});

	test("两个独立 factory 闭包互不串扰（子代理默认 off）", async () => {
		const { repo, cleanup } = makeFakeRepo(FAKE_BODY);
		try {
			const piA = makeMockPi();
			const piB = makeMockPi();
			factory(piA);
			factory(piB);
			await runCommand(piA, "on", makeMockCtx(repo));

			const sectionsB: Record<string, string> = {};
			await fireBeforeAgentStart(piB, sectionsB);
			expect(sectionsB[SECTION_KEY]).toBeUndefined(); // B 默认 off

			await runCommand(piB, "on", makeMockCtx(repo));
			await runCommand(piB, "off", makeMockCtx(repo));

			const sectionsA: Record<string, string> = {};
			await fireBeforeAgentStart(piA, sectionsA);
			expect(sectionsA[SECTION_KEY]).toContain(IDENTITY_MARKER); // A 不受 B 影响
		} finally {
			cleanup();
		}
	});
});

function toolCtx(pi: MockPi, repo: string): any {
	return {
		cwd: repo,
		mode: "tui",
		hasUI: true,
		signal: undefined,
		ui: { notify() {} },
		sendMessage: pi.sendMessage.bind(pi),
		getActiveTools: pi.getActiveTools.bind(pi),
		isIdle: () => false,
	};
}

describe("Secretary runtime assembly", () => {
	test("registers the five opt-in runtime tools (role tools are separate and always active)", async () => {
		const pi = makeMockPi();
		factory(pi);
		const runtimeTools = [
			"secretary_cancel",
			"secretary_deadline",
			"secretary_runtime_status",
			"secretary_schedule",
			"secretary_subscribe",
		];
		expect([...pi.tools.keys()]).toEqual(expect.arrayContaining(runtimeTools));
		for (const name of runtimeTools) expect(pi.tools.get(name)?.defaultActive).toBe(false);
		// 角色工具中立名：直接可见、默认激活，且不受 /secretary on|off 门控。
		for (const name of ["role_list", "role_resolve", "dispatch_role"]) {
			expect(pi.tools.get(name)?.defaultActive).toBeUndefined();
			expect(pi.tools.get(name)?.exposure).toBeUndefined();
		}
		// 旧名 secretary_* 已彻底删除，不再注册。
		for (const legacy of ["secretary_role_list", "secretary_role_resolve", "secretary_dispatch"]) {
			expect(pi.tools.has(legacy)).toBe(false);
		}
	});

	test("tool execution validates parameters and rejects stale generation", async () => {
		const { repo, cleanup } = makeFakeRepo(FAKE_BODY);
		try {
			const pi = makeMockPi();
			factory(pi);
			const ctx = toolCtx(pi, repo);
			await runCommand(pi, "on", makeMockCtx(repo));
			const schedule = pi.tools.get("secretary_schedule");
			const invalid = await schedule.execute("call-1", { job: { kind: "delay", delayMs: -1, action: { type: "notify", message: "x" } } }, undefined, undefined, ctx);
			expect(invalid.isError).toBe(true);
			const valid = await schedule.execute("call-2", { job: { kind: "delay", delayMs: 1000, action: { type: "notify", message: "x" } } }, undefined, undefined, ctx);
			expect(valid.isError).not.toBe(true);
			await fireSessionStart(pi, "reload");
			const stale = await schedule.execute("call-3", { job: { kind: "delay", delayMs: 1000, action: { type: "notify", message: "x" } } }, undefined, undefined, ctx);
			expect(stale.isError).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("lifecycle wires busy/settled, dispatch events, structured custom messages, and shutdown", async () => {
		const pi = makeMockPi();
		factory(pi);
		const status = () => pi.tools.get("secretary_runtime_status");
		const ctx = toolCtx(pi, "/tmp");
		const emit = (event: string, value: unknown) => Promise.all((pi.handlers.get(event) ?? []).map((h) => h(value, ctx)));
		await emit("agent_start", { type: "agent_start" });
		await emit("tool_execution_end", { type: "tool_execution_end", toolName: "subagent", result: { customType: "PiStartedMetadata", details: { id: "p1", name: "w", task: "T", sessionFile: "/tmp/s", status: "started" } }, isError: false });
		await emit("message_end", { type: "message_end", message: { role: "custom", customType: "subagent_result", details: { logicalId: "l1", generationId: "g1" } } });
		const running = await status().execute("status-1", {}, undefined, undefined, ctx);
		expect(running.details).toMatchObject({ queue: { size: 0 }, closed: false });
		await emit("agent_settled", { type: "agent_settled", aborted: false });
		await emit("session_shutdown", { type: "session_shutdown", reason: "shutdown" });
		const after = await status().execute("status-2", {}, undefined, undefined, ctx);
		expect(after.isError).toBe(true);
	});
});
