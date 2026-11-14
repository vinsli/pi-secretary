/**
 * THU-106 WF-004: /secretary 扩展 —— 真实 Pi SDK 集成测试（stub provider 捕获）。
 *
 * 与 secretary.test.ts（单元/事件 mock）互补，本文件用已安装的 Pi SDK +
 * pi-ai fauxProvider 做真实链路验证：
 *   - 真实 DefaultResourceLoader 对项目本地 .pi/extensions/secretary.ts 的发现；
 *   - prompt("/secretary") 命令分发零 provider 请求；
 *   - 开启/关闭后，真正传给 provider 的系统提示里 <secretary> section 的
 *     出现/消失（经 streamSimple 捕获 getCurrentSystemPrompt(context.messages)）；
 *   - 每次开启重读唯一正文文件；
 *   - 非法参数不产生请求且不改状态；
 *   - legacy 追加（.pi/APPEND_SYSTEM.md 含身份标识）去重；
 *   - AgentSessionRuntime 替换（newSession/switchSession/fork）后状态复位；
 *   - 两个独立会话（独立工厂实例）默认隔离。
 *
 * 测试不访问网络（faux streamSimple 纯内存）、不使用付费模型、不读写用户的
 * auth/models/settings（authPath/modelsPath/agentDir 全部指向临时沙箱）。
 * Pi 包位置运行时从 `command -v pi` 解析（realpath 上溯两级并校验包名），
 * 不含机器硬编码路径。
 *
 * 边界（明确为 mock/单元层覆盖，不冒充 SDK 证据）：
 *   - /reload 的 session_start reason="reload"：SDK 无运行时 reload 入口，
 *     由单元测试的 session_start mock 覆盖五种 reason；
 *   - /tree 同会话保留：SDK 无树导航入口，由单元测试的 session_tree mock 覆盖；
 *   - Herdr 子代理 canary：属 Router 验收步骤，不在本文件。
 */

import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** 包根目录（index.ts / lib / roles / body 所在处）。 */
const PKG_ROOT = path.resolve(import.meta.dir, "..");
const IDENTITY_MARKER = "WF-002 Secretary / Router 注入提示";
const SECTION_OPEN = "<secretary>";

interface PiModules {
	sdk: any;
	piAi: any;
	piPkgDir: string;
}

let modules: PiModules | undefined;

/** 从已安装 pi 入口解析 Pi 包目录（不做机器硬编码）。 */
function resolvePiPkgDir(): string {
	const bin = execSync("command -v pi", { encoding: "utf8" }).trim();
	if (!bin) throw new Error("PATH 中找不到 pi，无法定位已安装的 Pi SDK");
	const real = fs.realpathSync(bin);
	const pkgDir = path.resolve(path.dirname(real), "..", "..");
	const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
	assert.equal(pkgJson.name, "@earendil-works/pi-coding-agent", "pi 入口上溯两级不是 Pi 包目录");
	return pkgDir;
}

async function loadModules(): Promise<PiModules> {
	if (modules) return modules;
	const piPkgDir = resolvePiPkgDir();
	const sdk = await import(path.join(piPkgDir, "dist", "index.js"));
	const piAi = await import(
		path.join(piPkgDir, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js")
	);
	modules = { sdk, piAi, piPkgDir };
	return modules;
}

interface Sandbox {
	dir: string;
	bodyPath: string;
	appendSystemPath: string;
}

function makeSandbox(body: string): Sandbox {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf004-sdk-"));
	const extDir = path.join(dir, ".pi", "extensions");
	fs.mkdirSync(extDir, { recursive: true });
	fs.mkdirSync(path.join(dir, ".pi-agent-empty"), { recursive: true });
	// 把包内容摆成“项目本地扩展”布局：index.ts 平铺，lib/ roles/ body/ 走相对 import。
	for (const part of ["lib", "roles", "body"]) {
		fs.cpSync(path.join(PKG_ROOT, part), path.join(extDir, part), { recursive: true });
	}
	fs.copyFileSync(path.join(PKG_ROOT, "index.ts"), path.join(extDir, "secretary.ts"));
	// 正文用项目级覆盖（优先级高于包内 body/identity.md），便于测试改写。
	const bodyPath = path.join(dir, ".pi", "secretary-identity.md");
	fs.writeFileSync(bodyPath, body, "utf8");
	const appendSystemPath = path.join(dir, ".pi", "APPEND_SYSTEM.md");
	return { dir, bodyPath, appendSystemPath };
}

const BODY_V1 = `# ${IDENTITY_MARKER}\n\n沙箱身份正文 SDK-BODY-V1。\n`;

interface Stub {
	modelRuntime: any;
	model: any;
	faux: any;
	captures: string[];
}

async function makeStub(sandbox: Sandbox, responseCount: number): Promise<Stub> {
	const { sdk, piAi } = await loadModules();
	const faux = piAi.fauxProvider();
	const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const captures: string[] = [];
	const steps = Array.from({ length: responseCount }, () => (context: any) => {
		captures.push(piAi.getCurrentSystemPrompt(context.messages));
		return piAi.fauxAssistantMessage("stub-reply");
	});
	faux.setResponses(steps);
	const modelRuntime = await sdk.ModelRuntime.create({
		authPath: path.join(sandbox.dir, "auth.json"),
		modelsPath: path.join(sandbox.dir, "models.json"),
	});
	modelRuntime.registerProvider("wf004-faux", {
		name: "WF004 Faux",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:9/",
		apiKey: "wf004-stub-key",
		streamSimple: faux.provider.streamSimple,
		models: [
			{
				type: "chat",
				id: "wf004-stub",
				name: "WF004 Stub",
				api: "openai-completions",
				reasoning: false,
				input: ["text"],
				cost: zeroCost,
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
	});
	const model = modelRuntime.getModel("wf004-faux", "wf004-stub");
	assert.ok(model, "stub 模型未注册成功");
	return { modelRuntime, model, faux, captures };
}

async function makeSession(sandbox: Sandbox, stub: Stub, tools: string[] = []) {
	const { sdk } = await loadModules();
	const resourceLoader = new sdk.DefaultResourceLoader({
		cwd: sandbox.dir,
		agentDir: path.join(sandbox.dir, ".pi-agent-empty"),
	});
	await resourceLoader.reload();
	const created = await sdk.createAgentSession({
		cwd: sandbox.dir,
		model: stub.model,
		thinkingLevel: "off",
		modelRuntime: stub.modelRuntime,
		resourceLoader,
		sessionManager: sdk.SessionManager.inMemory(),
		settingsManager: sdk.SettingsManager.inMemory({
			retry: { enabled: false },
			compaction: { enabled: false },
		}),
		tools: tools.length > 0 ? tools : undefined,
	});
	return { session: created.session, dispose: () => created.session.dispose(), resourceLoader };
}

function countMarker(text: string | undefined): number {
	if (!text) return 0;
	let count = 0;
	let idx = text.indexOf(IDENTITY_MARKER);
	while (idx !== -1) {
		count++;
		idx = text.indexOf(IDENTITY_MARKER, idx + 1);
	}
	return count;
}

describe("THU-106 /secretary —— 真实 Pi SDK 捕获", () => {
	test("pi 包定位与项目本地扩展真实发现", async () => {
		const { sdk } = await loadModules();
		const sandbox = makeSandbox(BODY_V1);
		try {
			const resourceLoader = new sdk.DefaultResourceLoader({
				cwd: sandbox.dir,
				agentDir: path.join(sandbox.dir, ".pi-agent-empty"),
			});
			await resourceLoader.reload();
			const discovered = resourceLoader
				.getExtensions()
				.extensions.map((e: any) => String(e.path));
			assert.equal(discovered.length, 1, `应恰好发现一个扩展: ${discovered.join(", ")}`);
			assert.ok(discovered[0].includes("secretary.ts"), "发现的扩展应是 secretary.ts");
			assert.equal(resourceLoader.getExtensions().errors.length, 0, "扩展发现不应有错误");
		} finally {
			fs.rmSync(sandbox.dir, { recursive: true, force: true });
		}
	});

	test("/secretary 命令分发：零 provider 请求", async () => {
		const sandbox = makeSandbox(BODY_V1);
		try {
			const stub = await makeStub(sandbox, 1);
			const { session, dispose } = await makeSession(sandbox, stub);
			try {
				await session.prompt("/secretary");
				assert.equal(stub.faux.state.callCount, 0, "命令不得产生任何 provider 请求");
				await session.prompt("/secretary on");
				assert.equal(stub.faux.state.callCount, 0, "on 也不得产生 provider 请求");
			} finally {
				dispose();
			}
		} finally {
			fs.rmSync(sandbox.dir, { recursive: true, force: true });
		}
	});

	test("默认 off → 开启 → 关闭：真实 sections 捕获", async () => {
		const sandbox = makeSandbox(BODY_V1);
		try {
			const stub = await makeStub(sandbox, 3);
			const { session, dispose } = await makeSession(sandbox, stub);
			try {
				await session.prompt("m1 默认关闭");
				const c1 = stub.captures[0];
				assert.ok(c1, "第一轮应产生 provider 请求");
				assert.equal(countMarker(c1), 0, "默认 off：不得含身份标识");
				assert.ok(!c1.includes(SECTION_OPEN), "默认 off：不得有 <secretary> section");

				await session.prompt("/secretary");
				assert.equal(stub.faux.state.callCount, 1, "/secretary 无参=开启，仍是零新增请求");
				await session.prompt("m2 已开启");
				const c2 = stub.captures[1];
				assert.equal(countMarker(c2), 1, "开启后恰好出现一次身份标识（来自自有 section）");
				assert.ok(c2.includes(SECTION_OPEN), "开启后应有 <secretary> section");
				assert.ok(c2.includes("SDK-BODY-V1"), "section 内容应来自唯一正文文件");

				await session.prompt("/secretary off");
				await session.prompt("m3 已关闭");
				const c3 = stub.captures[2];
				assert.equal(countMarker(c3), 0, "off 后下一请求不得再带身份标识");
				assert.ok(!c3.includes(SECTION_OPEN), "off 后不得有 <secretary> section");
			} finally {
				dispose();
			}
		} finally {
			fs.rmSync(sandbox.dir, { recursive: true, force: true });
		}
	});

	test("每次开启重读唯一正文（文件更新后生效，不用旧缓存）", async () => {
		const sandbox = makeSandbox(BODY_V1);
		try {
			const stub = await makeStub(sandbox, 2);
			const { session, dispose } = await makeSession(sandbox, stub);
			try {
				await session.prompt("/secretary");
				await session.prompt("m1 v1");
				assert.ok(stub.captures[0].includes("SDK-BODY-V1"));

				fs.writeFileSync(
					sandbox.bodyPath,
					`# ${IDENTITY_MARKER}\n\n沙箱身份正文 SDK-BODY-V2 更新。\n`,
					"utf8"
				);
				await session.prompt("/secretary on");
				await session.prompt("m2 v2");
				assert.ok(stub.captures[1].includes("SDK-BODY-V2"), "重开启应读到新正文");
				assert.ok(!stub.captures[1].includes("SDK-BODY-V1"), "不应残留旧正文");
			} finally {
				dispose();
			}
		} finally {
			fs.rmSync(sandbox.dir, { recursive: true, force: true });
		}
	});

	test("非法参数：零请求且状态不变（随后消息仍无 section）", async () => {
		const sandbox = makeSandbox(BODY_V1);
		try {
			const stub = await makeStub(sandbox, 1);
			const { session, dispose } = await makeSession(sandbox, stub);
			try {
				await session.prompt("/secretary bogus");
				assert.equal(stub.faux.state.callCount, 0, "非法参数不得产生请求");
				await session.prompt("m1 仍应关闭");
				const c1 = stub.captures[0];
				assert.ok(c1, "非法参数后普通消息应正常发请求");
				assert.equal(countMarker(c1), 0, "非法参数不得改变状态（仍 off）");
				assert.ok(!c1.includes(SECTION_OPEN));
			} finally {
				dispose();
			}
		} finally {
			fs.rmSync(sandbox.dir, { recursive: true, force: true });
		}
	});

	test("legacy 追加去重：appendSystemPrompt 已含身份标识时不重复注入", async () => {
		const sandbox = makeSandbox(BODY_V1);
		// 模拟旧启动器经 --append-system-prompt 显式注入完整身份正文：
		// SDK 层以项目本地 .pi/APPEND_SYSTEM.md 承载同样的 appendSystemPrompt 效果。
		fs.writeFileSync(sandbox.appendSystemPath, BODY_V1, "utf8");
		try {
			const stub = await makeStub(sandbox, 2);
			const { session, dispose } = await makeSession(sandbox, stub);
			try {
				await session.prompt("m1 legacy 已在");
				const c1 = stub.captures[0];
				assert.equal(countMarker(c1), 1, "legacy 场景基线：追加源本身出现一次");

				await session.prompt("/secretary");
				await session.prompt("m2 开启后不得双份");
				const c2 = stub.captures[1];
				assert.equal(countMarker(c2), 1, "已含身份标识时扩展不得再注入第二份");
				assert.ok(!c2.includes(SECTION_OPEN), "去重时不应再写 <secretary> section");
			} finally {
				dispose();
			}
		} finally {
			fs.rmSync(sandbox.dir, { recursive: true, force: true });
		}
	});

	test("AgentSessionRuntime 替换后复位（newSession/switchSession/fork）", async () => {
		const { sdk } = await loadModules();
		const sandbox = makeSandbox(BODY_V1);
		try {
			const stub = await makeStub(sandbox, 6);
			const createRuntime: any = async ({ sessionManager, sessionStartEvent }: any) => {
				const services = await sdk.createAgentSessionServices({
					cwd: sandbox.dir,
					agentDir: path.join(sandbox.dir, ".pi-agent-empty"),
					settingsManager: sdk.SettingsManager.inMemory({
						retry: { enabled: false },
						compaction: { enabled: false },
					}),
					modelRuntime: stub.modelRuntime,
				});
				return {
					...(await sdk.createAgentSessionFromServices({
						services,
						sessionManager,
						sessionStartEvent,
						model: stub.model,
						thinkingLevel: "off",
					})),
					services,
					diagnostics: services.diagnostics,
				};
			};
			const runtime = await sdk.createAgentSessionRuntime(createRuntime, {
				cwd: sandbox.dir,
				agentDir: path.join(sandbox.dir, ".pi-agent-empty"),
				sessionManager: await sdk.SessionManager.create(sandbox.dir, path.join(sandbox.dir, "sessions")),
			});
			const bind = async () => {
				const session = runtime.session;
				await session.bindExtensions({});
				return session;
			};
			try {
				let session = await bind();
				await session.prompt("/secretary");
				await session.prompt("m1 开启");
				assert.equal(countMarker(stub.captures[0]), 1, "runtime 会话内开启生效");
				const original = session.sessionFile;
				assert.ok(original, "必须有持久会话文件，resume 分支不能静默跳过");
				assert.ok(original.startsWith(sandbox.dir + path.sep), "持久会话也必须位于临时沙箱，不能写用户全局 sessions");

				await runtime.newSession();
				session = await bind();
				await session.prompt("m2 新会话应复位");
				assert.equal(countMarker(stub.captures[1]), 0, "newSession 后默认 off");
				assert.ok(!stub.captures[1].includes(SECTION_OPEN));

				// 每种替换前都重新开启，避免用“本来就是 off”冒充复位证据。
				await session.prompt("/secretary");
				await session.prompt("m2b resume 前已开启");
				assert.equal(countMarker(stub.captures[2]), 1, "resume 前必须处于 on");
				await runtime.switchSession(original);
				session = await bind();
				await session.prompt("m3 resume 后也复位");
				assert.equal(countMarker(stub.captures[3]), 0, "switchSession(resume) 后默认 off");

				await session.prompt("/secretary");
				await session.prompt("m3b fork 前已开启");
				assert.equal(countMarker(stub.captures[4]), 1, "fork 前必须处于 on");
				// fork：从首个用户消息处分叉也应复位。
				const entries = session.sessionManager
					? session.sessionManager.getEntries()
					: runtime.session.sessionManager.getEntries();
				const userEntry = entries.find((e: any) => e.type === "message" && e.message?.role === "user");
				assert.ok(userEntry, "必须有用户消息，fork 分支不能静默跳过");
				await runtime.fork(userEntry.id);
				session = await bind();
				await session.prompt("m4 fork 后也复位");
				assert.equal(countMarker(stub.captures[5]), 0, "fork 后默认 off");
				assert.ok(!stub.captures[5].includes(SECTION_OPEN));
				assert.equal(stub.captures.length, 6, "全部 on/off 替换分支必须真正请求并验证");
			} finally {
				await runtime.dispose();
			}
		} finally {
			fs.rmSync(sandbox.dir, { recursive: true, force: true });
		}
	});

	test("两个独立会话（独立工厂实例）默认隔离", async () => {
		const sandbox = makeSandbox(BODY_V1);
		try {
			const stubA = await makeStub(sandbox, 1);
			const a = await makeSession(sandbox, stubA);
			const stubB = await makeStub(sandbox, 1);
			const b = await makeSession(sandbox, stubB);
			try {
				await a.session.prompt("/secretary");
				await a.session.prompt("m1 A 开启");
				assert.equal(countMarker(stubA.captures[0]), 1, "会话 A 开启生效");

				await b.session.prompt("m1 B 默认 off");
				assert.equal(countMarker(stubB.captures[0]), 0, "独立会话 B 不受 A 影响");
				assert.ok(!stubB.captures[0].includes(SECTION_OPEN));
			} finally {
				a.dispose();
				b.dispose();
			}
		} finally {
			fs.rmSync(sandbox.dir, { recursive: true, force: true });
		}
	});

	test("真实 SDK runtime canary：faux tool call → timer → secretary_notice", async () => {
		const sandbox = makeSandbox(BODY_V1);
		try {
			const stub = await makeStub(sandbox, 4);
			const { piAi } = await loadModules();
			stub.faux.setResponses([
				(context: any) => {
					stub.captures.push(piAi.getCurrentSystemPrompt(context.messages));
					return piAi.fauxAssistantMessage(piAi.fauxToolCall("secretary_schedule", {
						job: { kind: "delay", delayMs: 0, action: { type: "enqueue_secretary", payload: { source: "sdk-canary" } } },
					}));
				},
				...Array.from({ length: 3 }, () => (context: any) => {
					stub.captures.push(piAi.getCurrentSystemPrompt(context.messages));
					return piAi.fauxAssistantMessage("canary-reply");
				}),
			]);
			const { session, dispose } = await makeSession(sandbox, stub, [
				"+secretary_schedule",
				"+secretary_runtime_status",
			]);
			try {
				await session.prompt("run the scheduler canary");
				await new Promise((resolve) => setTimeout(resolve, 25));
				const entries = session.sessionManager.getEntries();
				const notices = entries.filter((entry: any) =>
					entry.type === "custom_message" && (entry.customType === "secretary_notice" || entry.data?.customType === "secretary_notice"),
				);
				assert.ok(stub.faux.state.callCount >= 1, "faux provider should be called");
				assert.ok(stub.captures.length >= 1, "system prompt should be captured");
				assert.ok(notices.length >= 1, "timer action should deliver secretary_notice");
				assert.ok(notices.some((entry: any) => JSON.stringify(entry).includes("sdk-canary")));
			} finally {
				dispose();
			}
		} finally {
			fs.rmSync(sandbox.dir, { recursive: true, force: true });
		}
	});
});
