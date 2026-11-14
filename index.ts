/**
 * /secretary —— WF-002 Secretary / Router 身份扩展（THU-106）。
 *
 * 作用：把身份正文以自有 system-prompt section 的形式注入当前会话。正文默认
 * 来自包内 `body/identity.md`（随包分发）；仓库根若有
 * `.pi/secretary-identity.md` 则优先使用该项目的自定义正文。
 *
 *   /secretary          开启（幂等；每次重新读取正文）
 *   /secretary on       同上
 *   /secretary off      关闭（下一次模型请求剥除自有 section）
 *   /secretary status   查看当前状态与正文路径
 *
 * 设计约束（WF-004 spec）：
 *   - 开关状态只存于 factory 闭包，不做模块共享、不做持久化、不看环境变量；
 *     独立进程（子代理）各自默认 off。
 *   - 命令只做通知与开关翻转，绝不发起模型请求（不 sendUserMessage），
 *     不自动派工 / Watchdog；下一条普通消息才触发带身份的模型请求。
 *   - `before_agent_start` 只变更自有 key（`sections.secretary`），
 *     不覆写公共规则、其他扩展的 section 或整段 systemPrompt。
 *   - `session_start`（startup/reload/new/resume/fork 五种 reason）一律复位 off；
 *     `/tree` 导航只换分支、不换运行时，状态保留。
 *   - legacy 兼容：若 CLI 显式 `--append-system-prompt` 注入的提示词已包含
 *     本身份的唯一标识（正文 H1），则不重复注入；off/status 也如实说明
 *     只控制本扩展，不能撤销 CLI 显式追加或抹掉历史消息。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { createSecretaryRuntime } from "./lib/runtime";
import { classifyHerdrEvent } from "./lib/catalog";
import { createDeadlineTracker } from "./lib/l2-deadline";
import type { Clock, JobSpec, RuntimeStatus } from "./lib/types";
import { ROLE_IDS, ROLE_REGISTRY } from "./roles/registry";
import { loadRoleOverrides } from "./roles/config";
import { candidatesFor, describeLaunch, readRoleBody, resolveRole } from "./roles/resolve";
import { appendRosterRecord, buildRosterRecord, findRepoRoot } from "./roles/roster";
import { DISPATCHER_KINDS, normalizeDispatcher } from "./roles/dispatcher";
import { assertWritableTarget } from "./roles/worktree";
import { type GateOutcome, type GateRequest, type TddAction, TddGateError, createTddGate, defaultTddDeps } from "./lib/tdd";

/** 扩展自有 section 的 key（systemPromptOptions.sections 的 tag 名）。 */
const SECTION_KEY = "secretary";

/** 包内身份正文（随扩展分发，与宿主仓库无关）。 */
const BODY_RELATIVE_PATH = path.join("body", "identity.md");

/** 包根目录：`index.ts` 所在目录（打包/安装后位置由 pi 决定，不写死）。 */
const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * 项目级覆盖（可选）：仓库根下 `.pi/secretary-identity.md`。
 * 存在时优先于包内正文，用于项目自定义身份；不做跨仓库回退。
 */
const PROJECT_BODY_OVERRIDE = path.join(".pi", "secretary-identity.md");

/**
 * 唯一身份标识：正文文件的 H1 标题。legacy 判断（CLI 是否已显式注入同一身份）
 * 以它在既有 system prompt 中的出现为准。
 */
const IDENTITY_MARKER = "WF-002 Secretary / Router 注入提示";

/** 向上搜索的层级上限（防御无限循环；仓库一般很浅）。 */
const MAX_UPWARD_SEARCH = 12;

interface ResolvedBody {
	path: string;
	content: string;
}

/**
 * 定位正文，两级优先级：
 *   1. 项目级覆盖 `.pi/secretary-identity.md`：从 cwd 向上搜索，最近的 .git
 *      （目录或文件）是边界，独立嵌套仓库不继承外层仓库的覆盖。
 *   2. 包内 `body/identity.md`：随扩展分发，任何目录下都可开启，不读宿主仓库。
 * 两者都缺失时返回 undefined，由调用方降级处理；不含任何机器硬编码路径。
 */
function resolveBodyPath(cwd: string): string | undefined {
	let dir: string | undefined = path.resolve(cwd);
	for (let i = 0; i < MAX_UPWARD_SEARCH && dir; i++) {
		const candidate = path.join(dir, PROJECT_BODY_OVERRIDE);
		if (fs.existsSync(candidate)) return candidate;
		// Git worktree/submodule 的 .git 可以是文件，两种形态都必须停住。
		if (fs.existsSync(path.join(dir, ".git"))) break;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	const bundled = path.join(PACKAGE_ROOT, BODY_RELATIVE_PATH);
	return fs.existsSync(bundled) ? bundled : undefined;
}

/** 读取并校验正文；缺失/为空/不可读返回 undefined（不缓存旧值）。 */
function readBody(cwd: string): ResolvedBody | undefined {
	const bodyPath = resolveBodyPath(cwd);
	if (!bodyPath) return undefined;
	let content: string;
	try {
		content = fs.readFileSync(bodyPath, "utf8");
	} catch {
		return undefined;
	}
	if (content.trim().length === 0) return undefined;
	return { path: bodyPath, content };
}

const HONESTY_NOTE =
	"只控制本扩展的 section 注入：不能移除经 CLI --append-system-prompt 显式追加的身份提示词，也不能抹掉会话历史中已出现的内容";

/**
 * roles 目录 = 包自身 `roles/`（角色正文随包分发）。
 * 不按 cwd 搜索：打包后角色正文只能有一份真相，否则宿主仓的旧副本会静默
 * 覆盖已安装的包。项目级差异走 `.pi/secretary-roles.json`（候选模型/effort）。
 */
function resolveRolePromptRoot(): string {
	return path.join(PACKAGE_ROOT, "roles");
}

const TOOL_NAMES = [
	"secretary_schedule",
	"secretary_cancel",
	"secretary_subscribe",
	"secretary_runtime_status",
	"secretary_deadline",
] as const;

type RuntimeToolResult = {
	content: [{ type: "text"; text: string }];
	details: unknown;
	structuredContent?: unknown;
	isError?: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const result = (details: unknown): RuntimeToolResult => ({
	content: [{ type: "text", text: JSON.stringify(details) }],
	details,
	structuredContent: details,
});

const failure = (message: string): RuntimeToolResult => ({
	content: [{ type: "text", text: message }],
	details: { error: message },
	isError: true,
});

export default function secretaryExtension(pi: ExtensionAPI): void {
	const host = pi as ExtensionAPI & { getActiveTools?: () => string[] };
	const clock: Clock = {
		now: () => Date.now(),
		setTimeout: (fn, ms) => setTimeout(fn, ms),
		clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	};
	let runtimeGeneration = 0;
	let runtimeEnabled = true;
	let lastContext: any;
	let runtime = createSecretaryRuntime({
		clock,
		sendSink: (notice) => {
			pi.sendMessage({
				customType: "secretary_notice",
				content: JSON.stringify(notice),
				display: false,
				details: notice,
			}, { triggerTurn: true, deliverAs: "followUp" });
		},
		uiSink: (value) => {
			if (lastContext?.ui?.notify && isRecord(value)) lastContext.ui.notify(String(value.message ?? ""), value.level);
		},
	});
	let deadlines = createDeadlineTracker({ clock, enqueue: (payload) => runtime.enqueueSecretary(payload) });

	const rebuildRuntime = () => {
		runtime.destroy();
		runtimeGeneration++;
		runtime = createSecretaryRuntime({
			clock,
			sendSink: (notice) => {
				pi.sendMessage({ customType: "secretary_notice", content: JSON.stringify(notice), display: false, details: notice }, { triggerTurn: true, deliverAs: "followUp" });
			},
			uiSink: (value) => {
				if (lastContext?.ui?.notify && isRecord(value)) lastContext.ui.notify(String(value.message ?? ""), value.level);
			},
		});
		deadlines = createDeadlineTracker({ clock, enqueue: (payload) => runtime.enqueueSecretary(payload) });
	};

	const guard = (ctx: any): RuntimeToolResult | undefined => {
		lastContext = ctx;
		const active = host.getActiveTools?.() ?? TOOL_NAMES;
		const runtimeState = runtime.status();
		if (!runtimeEnabled || runtimeState.closed) {
			return failure("Secretary runtime is disabled or stale");
		}
		if (active.length > 0 && !active.some((name) => TOOL_NAMES.includes(name as (typeof TOOL_NAMES)[number]))) {
			return failure("Secretary runtime tools are not active");
		}
		return undefined;
	};

	const executeTool = (fn: (params: any) => unknown) => async (_id: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any): Promise<RuntimeToolResult> => {
		const blocked = guard(ctx);
		if (blocked) return blocked;
		try {
			return result(fn(params));
		} catch (error) {
			return failure(error instanceof Error ? error.message : String(error));
		}
	};

	const empty = { type: "object", properties: {}, additionalProperties: false };
	const anyValue = { type: ["object", "array", "string", "number", "boolean", "null"] };
	const registerRuntimeTool = (definition: any) => pi.registerTool({ ...definition, defaultActive: false });
	registerRuntimeTool({
		name: "secretary_schedule", label: "Secretary schedule", description: "Schedule a bounded Secretary runtime job.", parameters: { type: "object", properties: { job: anyValue }, required: ["job"], additionalProperties: false },
		execute: executeTool(({ job }: { job: JobSpec }) => {
			if (!isRecord(job)) throw new RangeError("job must be an object");
			return { id: runtime.schedule(job as JobSpec), generation: runtimeGeneration };
		}),
	});
	registerRuntimeTool({
		name: "secretary_cancel", label: "Secretary cancel", description: "Cancel a Secretary runtime job.", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
		execute: executeTool(({ id }: { id: string }) => {
			if (typeof id !== "string" || id.length === 0) throw new TypeError("id must be a non-empty string");
			return { cancelled: runtime.cancelJob(id) };
		}),
	});
	registerRuntimeTool({
		name: "secretary_subscribe", label: "Secretary subscribe", description: "Subscribe to a structured Secretary event source.", parameters: { type: "object", properties: { source: { type: "string" } }, required: ["source"], additionalProperties: false },
		execute: executeTool(({ source }: { source: string }) => {
			if (typeof source !== "string" || source.length === 0) throw new TypeError("source must be a non-empty string");
			return { id: runtime.subscribe(source, (event) => runtime.enqueueSecretary({ source, event })) };
		}),
	});
	registerRuntimeTool({
		name: "secretary_runtime_status", label: "Secretary runtime status", description: "Inspect Secretary jobs, subscriptions, queue and wake state.", parameters: empty,
		execute: executeTool(() => runtime.runtimeStatus() as RuntimeStatus),
	});
	registerRuntimeTool({
		name: "secretary_deadline", label: "Secretary deadline", description: "Register a deadline that enqueues a notice when polled.", parameters: { type: "object", properties: { id: { type: "string" }, deadline: { type: "number" }, payload: anyValue }, required: ["id", "deadline"], additionalProperties: false },
		execute: executeTool(({ id, deadline, payload }: { id: string; deadline: number; payload?: unknown }) => {
			if (typeof id !== "string" || id.length === 0) throw new TypeError("id must be a non-empty string");
			if (typeof deadline !== "number" || !Number.isFinite(deadline)) throw new RangeError("deadline must be finite");
			deadlines.set(id, deadline, payload);
			return { id, deadline, pending: deadlines.pending() };
		}),
	});

	// ---- 角色派工（THU-119.1 / S0+S1）----
	// 角色契约全部在本扩展内：registry（role→agent 映射 + 权限 + fallback 枚举）、
	// prompts/（单一真相正文）、config（.pi/secretary-roles.json 覆盖）。
	// 这里只做解析与派工编排，pane 操作交给 external_worker，不轮询、不选模型。
	const roleFailure = (message: string, details: Record<string, unknown> = {}): RuntimeToolResult => ({
		content: [{ type: "text", text: message }],
		details: { error: message, ...details },
		isError: true,
	});

	/**
	 * `ctx.executeTool()` resolves to an AgentToolCallOutcome (`{ toolCall, result, isError }`),
	 * not to the tool's own return value. Tolerate the bare result too so a caller that
	 * stubs executeTool (tests, other hosts) need not reproduce the wrapper.
	 */
	const unwrapToolOutcome = (outcome: any): { result: any; isError: boolean } => {
		if (isRecord(outcome) && isRecord(outcome.result)) {
			return { result: outcome.result, isError: outcome.isError === true || outcome.result.isError === true };
		}
		return { result: outcome, isError: isRecord(outcome) && outcome.isError === true };
	};

	const roleTool = (
		fn: (params: any, ctx: any) => unknown | Promise<unknown>,
	) =>
		async (_id: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any): Promise<RuntimeToolResult> => {
			lastContext = ctx;
			try {
				const value = await fn(params ?? {}, ctx);
				if (isRecord(value) && value.isError === true) return value as RuntimeToolResult;
				return result(value);
			} catch (error) {
				return roleFailure(error instanceof Error ? error.message : String(error));
			}
		};

	// 三个角色工具：role_list / role_resolve / dispatch_role。
	// 「谁能派工」不写死在这里——任何加载本扩展的 pi（Secretary / Team Lead / 用户主会话）
	// 都拿到同一组工具，调用方身份由 dispatch_role 的 dispatcher 参数声明。
	pi.registerTool({
		name: "role_list",
		label: "Role list",
		description:
			"List the worker roles available to this project: role→agent candidates, permissions, fallback triggers, prompt file paths, and the dispatcher kinds dispatch_role accepts.",
		parameters: empty,
		execute: roleTool((_params: any, ctx: any) => {
			const promptRoot = resolveRolePromptRoot();
			const loaded = loadRoleOverrides(findRepoRoot(ctx?.cwd ?? process.cwd()));
			return {
				promptRoot,
				overrides: { path: loaded.path ?? null, roles: Object.keys(loaded.overrides) },
				dispatchers: [...DISPATCHER_KINDS],
				roles: ROLE_IDS.map((id) => {
					const definition = ROLE_REGISTRY[id];
					let promptPath = path.join(promptRoot, definition.promptFile);
					let promptReadable = false;
					try {
						promptPath = readRoleBody(definition, promptRoot).path;
						promptReadable = true;
					} catch {
						promptReadable = false;
					}
					return {
						id: definition.id,
						title: definition.title,
						purpose: definition.purpose,
						promptPath,
						promptReadable,
						candidates: candidatesFor(id, loaded.overrides),
						fallback: definition.fallback,
						permissions: definition.permissions,
					};
				}),
			};
		}),
	});

	pi.registerTool({
		name: "role_resolve",
		label: "Resolve role",
		description:
			"Resolve which agent a role maps to for a Backlog task: returns kind/model/effort/sandbox plus the exact prompt (role body + task brief) and its path. Pure and deterministic; starts nothing.",
		parameters: {
			type: "object",
			properties: {
				role: { type: "string", enum: [...ROLE_IDS] },
				taskId: { type: "string", description: "Backlog task id, e.g. THU-119.1" },
				item: { type: "string", description: "Optional sub-item label, e.g. S0" },
				brief: { type: "string", description: "What the role should actually do this time (free text)" },
				candidateIndex: {
					type: "number",
					description:
						"DIAGNOSTIC ONLY: force the 1-based candidate instead of candidate 1. Production dispatch must not use this — candidate order and fallback belong to the registry.",
				},
			},
			required: ["role", "taskId"],
			additionalProperties: false,
		},
		execute: roleTool((params: any, ctx: any) => {
			const promptRoot = resolveRolePromptRoot();
			const repoRoot = findRepoRoot(ctx?.cwd ?? process.cwd());
			const loaded = loadRoleOverrides(repoRoot);
			// 契约面是 role + taskId + item + brief；candidateIndex 只作诊断（矩阵冒烟要显式
			// 跑 fallback 候选），生产派工的候选顺序与切换由注册表 + fallback 决定。
			const launch = resolveRole(
				{
					role: params.role,
					taskId: params.taskId,
					item: params.item,
					brief: params.brief,
					candidateIndex: params.candidateIndex,
				},
				{ promptRoot, cwd: repoRoot, overrides: loaded.overrides },
			);
			return {
				summary: describeLaunch(launch),
				role: launch.role,
				roleTitle: launch.roleTitle,
				taskId: launch.taskId,
				item: launch.item ?? null,
				candidateIndex: launch.candidateIndex,
				candidateCount: launch.candidateCount,
				kind: launch.kind,
				model: launch.model,
				effort: launch.effort,
				sandbox: launch.sandbox ?? null,
				wireApi: launch.wireApi ?? null,
				cwd: launch.cwd,
				worktree: launch.permissions.worktree,
				promptPath: launch.promptPath,
				briefProvided: Boolean(launch.brief),
				promptChars: launch.prompt.length,
				prompt: launch.prompt,
				fallback: launch.fallback,
				overridesPath: loaded.path ?? null,
			};
		}),
	});

	pi.registerTool({
		name: "dispatch_role",
		label: "Dispatch role",
		description:
			"Dispatch a worker for a role: resolves the role, then starts external_worker with that agent/model/effort and the composed prompt. Writes .handoff/worker-roster.jsonl only when the pane actually started. Any dispatcher (secretary, team lead, user session) may call it; declare yourself in `dispatcher`.",
		parameters: {
			type: "object",
			properties: {
				role: { type: "string", enum: [...ROLE_IDS] },
				taskId: { type: "string" },
				item: { type: "string" },
				brief: { type: "string", description: "What the role should actually do this time (free text)" },
				cwd: {
					type: "string",
					description:
						"Directory the worker runs in (defaults to the caller's repo root). Write roles must point at an isolated git worktree: pass the worktree path here, or dispatch is rejected.",
				},
				dispatcher: {
					type: ["string", "object"],
					description:
						"Who is dispatching: `user` | `secretary` | `teamlead`, or { kind, id? }. Recorded in the roster as dispatchedBy/dispatchedById (id defaults to this session id). It is a traceable self-declaration, not a permission check — the same pi process can be any of them.",
				},
				candidateIndex: {
					type: "number",
					description:
						"DIAGNOSTIC ONLY: force the 1-based candidate instead of candidate 1. Production dispatch must not use this — candidate order and fallback belong to the registry.",
				},
			},
			required: ["role", "taskId"],
			additionalProperties: false,
		},
		execute: roleTool(async (params: any, ctx: any) => {
			const promptRoot = resolveRolePromptRoot();
			const repoRoot = findRepoRoot(ctx?.cwd ?? process.cwd());
			const loaded = loadRoleOverrides(repoRoot);
			// 调用方轴与角色正交：dispatcher 只影响台账归属，不影响选谁、用什么参数。
			const dispatcher = normalizeDispatcher(params.dispatcher, ctx?.sessionManager?.getSessionId?.());
			// 目标目录与调用方目录分开：主会话在主工作树上，写角色只能进隔离 worktree。
			// 不传 cwd 时行为与以前一致（就在调用方仓库根），由闸门拒绝写角色。
			const targetRoot = params.cwd ? findRepoRoot(path.resolve(params.cwd)) : repoRoot;
			const launch = resolveRole(
				{
					role: params.role,
					taskId: params.taskId,
					item: params.item,
					brief: params.brief,
					candidateIndex: params.candidateIndex,
				},
				{ promptRoot, cwd: targetRoot, overrides: loaded.overrides },
			);
			const summary = describeLaunch(launch);
			// 写角色只允许在隔离 worktree 里动手：这是一道机器闸门，不是 prompt 约束。
			// 判的是**目标**目录（worker 实际改文件的地方），不是调用方所在仓库。
			try {
				assertWritableTarget(targetRoot, launch.permissions.write);
			} catch (error) {
				return roleFailure(error instanceof Error ? error.message : String(error), {
					summary,
					worktree: launch.permissions.worktree,
					cwd: launch.cwd,
				});
			}
			if (typeof ctx?.executeTool !== "function") {
				return roleFailure("ctx.executeTool is unavailable; cannot launch external_worker", { summary });
			}
			const call: Record<string, unknown> = {
				action: "start",
				kind: launch.kind,
				model: launch.model,
				effort: launch.effort,
				task: launch.prompt,
				cwd: launch.cwd,
			};
			if (launch.sandbox) call.sandbox = launch.sandbox;
			if (launch.wireApi) call.wireApi = launch.wireApi;

			let response: any;
			try {
				response = await ctx.executeTool("external_worker", call);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return roleFailure(`dispatch failed to call external_worker: ${message}`, {
					summary,
					trigger: "launch_failed",
					fallback: launch.fallback,
					nextCandidate: launch.candidateIndex < launch.candidateCount ? launch.candidateIndex + 1 : null,
				});
			}

			const unwrapped = unwrapToolOutcome(response);
			const outcome = unwrapped.result;
			const details = isRecord(outcome?.details) ? (outcome.details as Record<string, unknown>) : {};
			const pane = typeof details.pane === "string" ? details.pane : undefined;
			const tab = typeof details.tab === "string" ? details.tab : undefined;
			if (unwrapped.isError || !pane || details.promptStarted === false) {
				const reason =
					unwrapped.isError
						? outcome?.content?.[0]?.text ?? "external_worker returned an error"
						: !pane
							? "external_worker started no pane"
							: "prompt never started in the worker pane";
				return roleFailure(`dispatch failed for ${summary}: ${reason}`, {
					summary,
					trigger: "launch_failed",
					pane: pane ?? null,
					tab: tab ?? null,
					warnings: Array.isArray(details.warnings) ? details.warnings : [],
					fallback: launch.fallback,
					nextCandidate: launch.candidateIndex < launch.candidateCount ? launch.candidateIndex + 1 : null,
				});
			}

			const record = buildRosterRecord(launch, { pane, tab }, new Date(), dispatcher);
			const rosterPath = appendRosterRecord(repoRoot, record);
			return {
				dispatched: true,
				summary,
				role: launch.role,
				taskId: launch.taskId,
				item: launch.item ?? null,
				candidateIndex: launch.candidateIndex,
				candidateCount: launch.candidateCount,
				kind: launch.kind,
				model: launch.model,
				effort: launch.effort,
				sandbox: launch.sandbox ?? null,
				wireApi: launch.wireApi ?? null,
				pane,
				tab: tab ?? null,
				promptStarted: details.promptStarted ?? null,
				dispatchedBy: dispatcher?.kind ?? null,
				dispatchedById: dispatcher?.id ?? null,
				rosterPath,
				promptPath: launch.promptPath,
				readWith: { action: "read", pane },
			};
		}),
	});

	// ---- Backlog 内 TDD 门禁（THU-119.3 / S3 ----
	// red / green / verify 自己跑命令、自己写目标 task 的 Notes、自己按三条口径拒绝。
	// 证据只落 Notes 单行条目 + `.handoff/<task>-tdd-*.log` 指针：不建 `.tdd` 目录，
	// 不写父任务，不勾 AC。判定逻辑全在 lib/tdd.ts（纯函数 + 注入依赖），这里只做
	// 参数校验与错误封装。
	const tddGate = createTddGate(defaultTddDeps);

	const tddParameters = (needsCommand: boolean) => ({
		type: "object",
		properties: {
			task: { type: "string", description: "Target Backlog task id, e.g. THU-119.3 (evidence is written to its Implementation Notes)." },
			...(needsCommand
				? {
						cmd: {
							type: "string",
							description:
								"The exact test command for this selection set; red and green must use the same command to share a sel.",
						},
					}
				: {}),
			role: { type: "string", description: "Optional role tag recorded in the entry (worker | reviewer | …)." },
			timeoutMs: { type: "number", description: "Command timeout in ms (default 600000)." },
		},
		required: needsCommand ? ["task", "cmd"] : ["task"],
		additionalProperties: false,
	});

	/** verify 不需要命令：它审的是已经写下来的证据链。 */
	const tddTool = (action: TddAction, needsCommand: boolean) =>
		roleTool((params: any, ctx: any) => {
			if (typeof params.task !== "string" || params.task.trim().length === 0) {
				throw new TypeError("task must be a non-empty string");
			}
			if (params.timeoutMs !== undefined && (typeof params.timeoutMs !== "number" || !Number.isFinite(params.timeoutMs))) {
				throw new RangeError("timeoutMs must be finite");
			}
			const request: GateRequest = {
				task: params.task.trim(),
				...(needsCommand ? { cmd: params.cmd } : {}),
				cwd: findRepoRoot(ctx?.cwd ?? process.cwd()),
				...(params.role ? { role: String(params.role) } : {}),
				...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
			};
			let outcome: GateOutcome;
			try {
				outcome = action === "tdd-red" ? tddGate.red(request) : action === "tdd-green" ? tddGate.green(request) : tddGate.verify(request);
			} catch (error) {
				if (error instanceof TddGateError) return roleFailure(error.message, { kind: error.kind, ...error.details });
				throw error;
			}
			if (!outcome.ok) {
				// 拒绝也是结构化结果：调用方要能按 kind 分支，而不是靠正则读文本。
				return roleFailure(outcome.failure?.message ?? `${action} was rejected`, {
					kind: outcome.failure?.kind ?? null,
					sel: outcome.sel,
					exit: outcome.exit,
					logPath: outcome.logPath ?? null,
					...outcome.failure?.details,
				});
			}
			return outcome;
		});

	pi.registerTool({
		name: "tdd_red",
		label: "TDD red",
		description:
			"Run the test command and, only if it FAILS, append one evidence line to the task's Implementation Notes (cmd, exit, selection-set sel, failure signature, log pointer). A passing command is rejected as red_passed and writes nothing.",
		parameters: tddParameters(true),
		execute: tddTool("tdd-red", true),
	});

	pi.registerTool({
		name: "tdd_green",
		label: "TDD green",
		description:
			"Record green for this selection set: rejected unless an earlier tdd_red with the same sel exists; then the command must pass. Writes one evidence line with the selection set, HEAD and a worktree snapshot.",
		parameters: tddParameters(true),
		execute: tddTool("tdd-green", true),
	});

	pi.registerTool({
		name: "tdd_verify",
		label: "TDD verify",
		description:
			"Audit the recorded red→green chain without running anything: rejects green before its red, a green sel that never appeared in a red, and production edits made after green. Names which of the three fired.",
		parameters: tddParameters(false),
		execute: tddTool("tdd-verify", false),
	});

	// 状态只存于本闭包：每个加载本扩展的进程（主会话 / 子代理）各自独立，
	// 默认 off。不做持久化、不看环境变量。
	let enabled = false;
	let body: ResolvedBody | null = null;

	const notify = (
		ctx: { ui: { notify: (message: string, type?: "info" | "warning" | "error") => void } },
		message: string,
		type?: "info" | "warning" | "error",
	) => {
		try {
			ctx.ui.notify(message, type);
		} catch {
			// 通知失败不影响开关状态
		}
	};

	pi.registerCommand("secretary", {
		description: "WF-002：开启/关闭 Secretary / Router 身份注入（on|off|status）",
		getArgumentCompletions: (prefix: string) => {
			const options = ["on", "off", "status"];
			const items = options
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args: string, ctx) => {
			const arg = (args ?? "").trim();

			if (arg === "" || arg === "on") {
				// 每次开启都重新读取正文；失败（缺失/为空/不可读）则报错并降级 off，
				// 不沿用旧缓存。
				const fresh = readBody(ctx.cwd);
				if (!fresh) {
					enabled = false;
					body = null;
					notify(
						ctx,
						`/secretary: 无法读取身份正文（已查找 ${PROJECT_BODY_OVERRIDE} 与包内 ${BODY_RELATIVE_PATH}；均缺失或为空），已降级为 off。请检查文件后重试。`,
						"error",
					);
					return;
				}
				body = fresh;
				const alreadyOn = enabled;
				enabled = true;
				notify(
					ctx,
					`Secretary 身份已开启（${alreadyOn ? "原本已开启，正文已按当前文件刷新" : "本次开启"}；正文：${fresh.path}）。` +
						`下一条普通消息将携带 Secretary / Router 身份；按正文要求，该身份下的第一件事是执行一次只读 workflow status。` +
						`注意：${HONESTY_NOTE}。`,
					"info",
				);
				return;
			}

			if (arg === "off") {
				enabled = false;
				body = null;
				notify(
					ctx,
					`Secretary 身份已关闭：下一次模型请求不再携带本扩展的 section。${HONESTY_NOTE}。`,
					"info",
				);
				return;
			}

			if (arg === "status") {
				const state = enabled
					? `已开启（正文：${body?.path ?? "未知"}）`
					: "已关闭";
				notify(
					ctx,
					`Secretary 身份注入：${state}。用法：/secretary [on|off|status]。${HONESTY_NOTE}。`,
					"info",
				);
				return;
			}

			// 非法参数：报用法错误，不改状态。
			notify(
				ctx,
				`/secretary: 未知参数 "${arg}"。用法：/secretary [on|off|status]（无参 = on）。状态未改变。`,
				"error",
			);
		},
	});

	// 会话开始/重建（startup/reload/new/resume/fork 五种 reason）一律复位 off。
	// /tree 导航只触发 session_before_tree/session_tree，不触发本事件，状态保留。
	pi.on("session_start", async (_event, ctx) => {
		lastContext = ctx;
		rebuildRuntime();
		runtimeEnabled = false;
		enabled = false;
		body = null;
	});

	pi.on("session_tree", async (_event, ctx) => {
		lastContext = ctx;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		lastContext = ctx;
		runtimeEnabled = false;
		runtime.destroy();
		deadlines = createDeadlineTracker({ clock, enqueue: () => false });
	});

	pi.on("agent_start", async (_event, ctx) => {
		lastContext = ctx;
		runtimeEnabled = true;
		runtime.setBusy(true);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		lastContext = ctx;
		runtime.agentSettled();
		deadlines.poll();
	});

	pi.on("message_end", async (event: any, ctx) => {
		lastContext = ctx;
		const message = event.message;
		if (!isRecord(message) || message.role !== "custom") return;
		const cataloged = classifyHerdrEvent(message);
		if (cataloged.layer !== "unknown") runtime.publish(cataloged.layer, cataloged);
	});

	pi.on("before_agent_start", async (event) => {
		const sections = event.systemPromptOptions?.sections;
		if (!sections) return;

		if (enabled && body) {
			// legacy 兼容：CLI 已显式注入同一身份（唯一标识出现在现有
			// system prompt 中）时不重复注入。
			if (event.systemPrompt?.includes(IDENTITY_MARKER)) return;
			sections[SECTION_KEY] = body.content;
			return;
		}

		// off：防御性剥除自有 key（正常路径下本扩展从未写入，但异常/竞态时
		// 确保下一次请求干净）。只动自有 key。
		if (SECTION_KEY in sections) {
			delete sections[SECTION_KEY];
		}
	});
}
