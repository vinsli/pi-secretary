/**
 * THU-119.1 单元测试：secretary 扩展内的角色注册表 / 解析 / 派工工具。
 *
 * 覆盖：
 *   - registry 自检（五角色、非法值报错、只读角色约束、prompt 可读、无废弃 flags）；
 *   - `.pi/secretary-roles.json` 覆盖（合法生效、未知角色/未知键/空候选报错）；
 *   - resolveRole 确定性、prompt 组成、候选越界、sandbox 推导；
 *   - role_list / role_resolve / dispatch_role 三个工具的注册与行为；dispatcher 轴与角色正交
 *     （dispatch 用 fake ctx.executeTool，不启动真实 pane）；
 *   - dispatch 失败不写 `.handoff/worker-roster.jsonl`，成功写一行。
 *
 * 运行：bun test test/secretary-roles.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	FALLBACK_TRIGGERS,
	ROLE_IDS,
	ROLE_REGISTRY,
	RoleRegistryError,
	getRole,
	validateRegistry,
} from "../roles/registry";
import { loadRoleOverrides, parseRoleOverrides } from "../roles/config";
import { candidatesFor, describeLaunch, resolveRole } from "../roles/resolve";
import { ROSTER_RELATIVE_PATH, appendRosterRecord, buildRosterRecord } from "../roles/roster";
import { assertWritableTarget, checkIsolatedWorktree } from "../roles/worktree";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPT_ROOT = join(HERE, "../roles");
const EXTENSION_PATH = join(HERE, "../index.ts");

const tmpDirs: string[] = [];
function makeTmpRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "thu119-roles-"));
	tmpDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("role registry", () => {
	test("builtin registry passes validation and lists five closed roles", () => {
		expect(() => validateRegistry()).not.toThrow();
		expect(Object.keys(ROLE_REGISTRY).sort()).toEqual([...ROLE_IDS].sort());
		expect(ROLE_IDS).toEqual(["researcher", "reviewer", "oracle", "planner", "worker"]);
	});

	test("every role declares known fallback triggers only", () => {
		for (const id of ROLE_IDS) {
			const role = getRole(id);
			expect(role.fallback.length).toBeGreaterThan(0);
			for (const trigger of role.fallback) {
				expect(FALLBACK_TRIGGERS).toContain(trigger);
			}
		}
	});

	test("unknown role / kind / effort / sandbox / fallback trigger are rejected with the offending value", () => {
		expect(() => getRole("cto")).toThrow(/unknown role "cto"/);
		expect(() =>
			parseRoleOverrides({ roles: { reviewer: { candidates: [{ kind: "gpt", model: "x", effort: "high" }] } } }),
		).toThrow(/unsupported kind "gpt"/);
		expect(() =>
			parseRoleOverrides({ roles: { reviewer: { candidates: [{ kind: "codex", model: "x", effort: "turbo" }] } } }),
		).toThrow(/unsupported effort "turbo"/);
		expect(() =>
			parseRoleOverrides({
				roles: { reviewer: { candidates: [{ kind: "codex", model: "x", effort: "high", sandbox: "none" }] } },
			}),
		).toThrow(/unsupported sandbox "none"/);
		expect(() => parseRoleOverrides({ roles: { reviewer: { candidates: [] } } })).toThrow(/non-empty array/);
	});

	test("read-only roles stay on a shared worktree; only worker may write", () => {
		for (const id of ROLE_IDS) {
			const role = getRole(id);
			if (id === "worker") {
				expect(role.permissions.write).toBe(true);
				expect(role.permissions.worktree).toBe("isolated");
			} else {
				expect(role.permissions.write).toBe(false);
				expect(role.permissions.worktree).toBe("shared");
			}
		}
	});

	test("prompt files exist, are non-empty and no longer mention deprecated collaboration flags", () => {
		for (const id of ROLE_IDS) {
			const path = join(PROMPT_ROOT, getRole(id).promptFile);
			expect(existsSync(path)).toBe(true);
			const body = readFileSync(path, "utf8");
			expect(body.trim().length).toBeGreaterThan(0);
			expect(body).toContain(`# 角色：${id}`);
			expect(body).not.toContain("collaboration-mode");
			expect(body).not.toContain("approval-mode ask");
		}
	});
});

describe("role overrides config", () => {
	const valid = {
		roles: {
			researcher: { candidates: [{ kind: "codex", model: "gpt-6.1-sol", effort: "low" }] },
		},
	};

	test("valid override replaces candidates for that role only", () => {
		const overrides = parseRoleOverrides(valid);
		expect(candidatesFor("researcher", overrides)).toEqual([
			{ kind: "codex", model: "gpt-6.1-sol", effort: "low" },
		]);
		expect(candidatesFor("reviewer", overrides)).toEqual(getRole("reviewer").candidates);
	});

	test("unknown top-level/role/candidate keys are rejected", () => {
		expect(() => parseRoleOverrides({ roles: {}, extra: true })).toThrow(/unknown key "extra"/);
		expect(() => parseRoleOverrides({ roles: { researcher: { prompts: [] } } })).toThrow(
			/unknown key "prompts"/,
		);
		expect(() =>
			parseRoleOverrides({
				roles: { researcher: { candidates: [{ kind: "codex", model: "x", effort: "high", approval: "yolo" }] } },
			}),
		).toThrow(/unknown key "approval"/);
		expect(() => parseRoleOverrides({ roles: { cto: { candidates: valid.roles.researcher.candidates } } })).toThrow(
			/unknown role "cto"/,
		);
	});

	test("overrides cannot widen a read-only role into a writable sandbox", () => {
		const widened = parseRoleOverrides({
			roles: { reviewer: { candidates: [{ kind: "codex", model: "gpt-6-astra", effort: "high", sandbox: "workspace-write" }] } },
		});
		expect(() => resolveRole({ role: "reviewer", taskId: "T" }, { promptRoot: PROMPT_ROOT, cwd: "/tmp", overrides: widened })).toThrow(
			/read-only role must use sandbox=read-only/,
		);
		const narrowed = parseRoleOverrides({
			roles: { worker: { candidates: [{ kind: "codex", model: "gpt-6.1-sol", effort: "high", sandbox: "read-only" }] } },
		});
		expect(() => resolveRole({ role: "worker", taskId: "T" }, { promptRoot: PROMPT_ROOT, cwd: "/tmp", overrides: narrowed })).toThrow(
			/write role cannot use sandbox=read-only/,
		);
	});

	test("loadRoleOverrides finds .pi/secretary-roles.json upward and surfaces parse errors", () => {
		const repo = makeTmpRepo();
		const configDir = join(repo, ".pi");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "secretary-roles.json"), JSON.stringify(valid), "utf8");
		const nested = join(repo, "a/b");
		mkdirSync(nested, { recursive: true });

		const loaded = loadRoleOverrides(nested);
		expect(loaded.path).toBe(join(configDir, "secretary-roles.json"));
		expect(loaded.overrides.researcher?.candidates[0].model).toBe("gpt-6.1-sol");

		writeFileSync(join(configDir, "secretary-roles.json"), "{not json", "utf8");
		expect(() => loadRoleOverrides(nested)).toThrow(/failed to parse/);

		const empty = makeTmpRepo();
		expect(loadRoleOverrides(empty)).toEqual({ overrides: {} });
	});
});

describe("resolveRole", () => {
	const context = { promptRoot: PROMPT_ROOT, cwd: "/tmp/repo" };

	test("same input yields identical output (no clock, no env)", () => {
		const request = { role: "reviewer", taskId: "THU-119.1", item: "S0" };
		const first = resolveRole(request, context);
		const second = resolveRole(request, context);
		expect(second).toEqual(first);
	});

	test("role body is composed with a deterministic task brief", () => {
		const launch = resolveRole({ role: "researcher", taskId: "THU-119.1", item: "S0" }, context);
		expect(isAbsolute(launch.promptPath)).toBe(true);
		expect(launch.promptPath.startsWith(PROMPT_ROOT)).toBe(true);
		expect(launch.prompt.startsWith("# 角色：researcher")).toBe(true);
		expect(launch.prompt).toContain("## 本次任务");
		expect(launch.prompt).toContain("THU-119.1");
		expect(launch.prompt).toContain("子项：S0");
		expect(launch.prompt).toContain("不要修改、创建或删除任何文件");
		expect(launch.prompt).toContain("直接在本 pane 输出结论");
	});

	test("worker brief demands an isolated worktree; read-only briefs forbid writes", () => {
		const worker = resolveRole({ role: "worker", taskId: "THU-119.1" }, context);
		expect(worker.prompt).toContain("隔离 git worktree");
		expect(worker.prompt).toContain(".handoff/");
		expect(worker.permissions.write).toBe(true);

		const planner = resolveRole({ role: "planner", taskId: "THU-119.1" }, context);
		expect(planner.prompt).toContain("**只读**");
		expect(planner.approval).toBeUndefined();
	});

	test("candidate selection drives kind/model/effort/sandbox (codely primary, codex fallback)", () => {
		const researcher = resolveRole({ role: "researcher", taskId: "T" }, context);
		expect(researcher.kind).toBe("codely");
		expect(researcher.model).toBe("neo/eco/claude-opus-5-5");
		expect(researcher.effort).toBe("high");
		// codely has no sandbox gate: read-only lives in the role prompt only.
		expect(researcher.sandbox).toBeUndefined();

		const researcherFallback = resolveRole({ role: "researcher", taskId: "T", candidateIndex: 2 }, context);
		expect(researcherFallback.kind).toBe("codex");
		expect(researcherFallback.model).toBe("gpt-6-astra");
		expect(researcherFallback.sandbox).toBe("read-only");

		const workerPrimary = resolveRole({ role: "worker", taskId: "T" }, context);
		expect(workerPrimary.kind).toBe("codely");
		expect(workerPrimary.model).toBe("codely-core");
		expect(workerPrimary.sandbox).toBeUndefined();

		const workerFallback = resolveRole({ role: "worker", taskId: "T", candidateIndex: 2 }, context);
		expect(workerFallback.kind).toBe("codex");
		expect(workerFallback.model).toBe("gpt-6.1-sol");
		expect(workerFallback.sandbox).toBe("workspace-write");

		expect(describeLaunch(workerFallback)).toContain("worker → codex/gpt-6.1-sol");
		expect(describeLaunch(researcher)).toContain("researcher → codely/neo/eco/claude-opus-5-5 effort=high");
	});

	test("no role resolves an approval flag: codely stays on its own yolo default", () => {
		for (const id of ROLE_IDS) {
			for (let index = 1; index <= getRole(id).candidates.length; index += 1) {
				const launch = resolveRole({ role: id, taskId: "T", candidateIndex: index }, context);
				expect(launch).not.toHaveProperty("approval");
				expect(describeLaunch(launch)).not.toContain("approval=");
			}
		}
	});

	test("brief is appended verbatim as the concrete task; blank briefs are rejected", () => {
		const brief = "只读探针：找出 reviewer 的一等候选，给 file:line。\n不要修改任何文件。";
		const launch = resolveRole({ role: "reviewer", taskId: "THU-119.2", brief }, context);
		expect(launch.prompt).toContain("## 具体任务");
		expect(launch.prompt).toContain("找出 reviewer 的一等候选");
		// The brief sits after the role's own rules, so role constraints keep priority.
		expect(launch.prompt.indexOf("## 具体任务")).toBeGreaterThan(launch.prompt.indexOf("## 纪律"));
		expect(resolveRole({ role: "reviewer", taskId: "T" }, context).prompt).not.toContain("## 具体任务");
		expect(() => resolveRole({ role: "reviewer", taskId: "T", brief: "   " }, context)).toThrow(
			/brief must be non-empty/,
		);
	});

	test("out-of-range candidate index and empty taskId are hard errors", () => {
		expect(() => resolveRole({ role: "researcher", taskId: "T", candidateIndex: 3 }, context)).toThrow(
			/has 2 candidate\(s\), requested #3/,
		);
		expect(() => resolveRole({ role: "researcher", taskId: "T", candidateIndex: 0 }, context)).toThrow(
			/positive integer/,
		);
		expect(() => resolveRole({ role: "researcher", taskId: "  " }, context)).toThrow(/taskId must be a non-empty/);
		expect(() => resolveRole({ role: "researcher", taskId: "T", item: "S 0" }, context)).toThrow(
			/unsupported characters/,
		);
	});

	test("overrides change the resolved agent without touching permissions", () => {
		const overrides = parseRoleOverrides({
			roles: { reviewer: { candidates: [{ kind: "codex", model: "gpt-6-astra", effort: "max" }] } },
		});
		const launch = resolveRole({ role: "reviewer", taskId: "T" }, { ...context, overrides });
		expect(launch.model).toBe("gpt-6-astra");
		expect(launch.effort).toBe("max");
		expect(launch.candidateCount).toBe(1);
		expect(launch.permissions.write).toBe(false);
	});
});

describe("write-role worktree gate", () => {
	/** A linked worktree: `.git` is a file pointing at an existing gitdir. */
	function makeLinkedWorktree(): string {
		const repo = makeTmpRepo();
		const gitdir = join(repo, ".git-worktrees/w1");
		mkdirSync(gitdir, { recursive: true });
		writeFileSync(join(repo, ".git"), `gitdir: ${gitdir}\n`, "utf8");
		return repo;
	}

	test("read-only roles pass on the main worktree, write roles do not", () => {
		const repo = makeTmpRepo();
		mkdirSync(join(repo, ".git"));
		expect(checkIsolatedWorktree(repo).ok).toBe(false);
		expect(() => assertWritableTarget(repo, false)).not.toThrow();
		expect(() => assertWritableTarget(repo, true)).toThrow(/needs an isolated git worktree/);
	});

	test("a linked worktree satisfies the gate; a broken one does not", () => {
		const linked = makeLinkedWorktree();
		expect(checkIsolatedWorktree(linked).ok).toBe(true);
		expect(() => assertWritableTarget(linked, true)).not.toThrow();

		const broken = makeTmpRepo();
		writeFileSync(join(broken, ".git"), "gitdir: ./missing\n", "utf8");
		expect(() => assertWritableTarget(broken, true)).toThrow(/missing gitdir/);

		const notRepo = makeTmpRepo();
		expect(() => assertWritableTarget(notRepo, true)).toThrow(/not a git repository/);
	});
});

describe("roster record", () => {
	test("record carries the actual agent and appendRosterRecord writes one JSONL line", () => {
		const repo = makeTmpRepo();
		const launch = resolveRole({ role: "reviewer", taskId: "THU-119.1", item: "S0" }, { promptRoot: PROMPT_ROOT, cwd: repo });
		const record = buildRosterRecord(launch, { pane: "w-1", tab: "subagents" }, new Date("2026-01-02T03:04:05.000Z"));
		const path = appendRosterRecord(repo, record);
		expect(path).toBe(join(repo, ROSTER_RELATIVE_PATH));
		const lines = readFileSync(path, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]);
		expect(parsed).toMatchObject({
			ts: "2026-01-02T03:04:05.000Z",
			role: "reviewer",
			taskId: "THU-119.1",
			item: "S0",
			pane: "w-1",
			tab: "subagents",
			kind: "codely",
			model: "neo/eco/claude-opus-5-5",
			effort: "xhigh",
		});
		expect(parsed.sandbox).toBeUndefined();
		expect(parsed.approval).toBeUndefined();
	});
});

describe("secretary role tools", () => {
	type ToolDef = { name: string; parameters: any; execute: (...args: any[]) => Promise<any> };
	let tools: Map<string, ToolDef>;
	let calls: Array<{ name: string; params: any }>;
	let ctx: any;

	beforeEach(async () => {
		tools = new Map();
		calls = [];
		const pi: any = {
			registerTool: (def: ToolDef) => tools.set(def.name, def),
			registerCommand: () => {},
			on: () => () => {},
			sendMessage: () => {},
			sendUserMessage: () => {},
		};
		const mod = await import(EXTENSION_PATH);
		(mod.default ?? mod)(pi);
	});

	function makeCtx(repo: string, executeTool: (name: string, params: any) => any) {
		return {
			cwd: repo,
			ui: { notify: () => {} },
			executeTool: async (name: string, params: any) => {
				calls.push({ name, params });
				return executeTool(name, params);
			},
		};
	}

	test("registers exactly the three neutral role tools and nothing else", () => {
		// 中性名是唯一入口（模型直接看到）。角色与调用方解耦：同一组工具属于任何加载
		// 本扩展的 pi（Secretary / Team Lead / 用户主会话），由 dispatcher 参数自��身份。
		// 旧名 secretary_* 已删除，不再保留别名。
		const roleTools = [...tools.keys()].filter((name) =>
			["role_list", "role_resolve", "dispatch_role"].includes(name),
		);
		expect(roleTools.sort()).toEqual(["dispatch_role", "role_list", "role_resolve"]);
		for (const legacy of ["secretary_role_list", "secretary_role_resolve", "secretary_dispatch"]) {
			expect(tools.has(legacy)).toBe(false);
		}
		for (const name of ["role_list", "role_resolve", "dispatch_role"]) {
			expect(tools.get(name)!.exposure).toBeUndefined();
		}
	});

	test("dispatcher is orthogonal to the role: it only tags the roster", async () => {
		const cases: Array<[any, string | null, string | undefined]> = [
			[{ kind: "teamlead", id: "sess-tl" }, "teamlead", "sess-tl"],
			["secretary", "secretary", undefined],
			[undefined, null, undefined],
		];
		for (const [dispatcher, kind, id] of cases) {
			const repo = makeTmpRepo();
			const res = await tools.get("dispatch_role")!.execute(
				"id",
				{ role: "reviewer", taskId: "THU-119.1", ...(dispatcher === undefined ? {} : { dispatcher }) },
				undefined,
				undefined,
				makeCtx(repo, () => ({
					toolCall: { type: "toolCall", id: "id/1", name: "external_worker", arguments: {} },
					result: { content: [{ type: "text", text: "pane: w-8" }], details: { pane: "w-8", promptStarted: true } },
					isError: false,
				})),
			);
			expect(res.details.dispatchedBy).toBe(kind);
			const line = JSON.parse(readFileSync(join(repo, ROSTER_RELATIVE_PATH), "utf8").trim());
			// 角色解析不受 dispatcher 影响：台账里的 agent 参数必须一样。
			expect(line).toMatchObject({ role: "reviewer", kind: "codely", model: "neo/eco/claude-opus-5-5", effort: "xhigh" });
			if (kind === null) {
				expect(line.dispatchedBy).toBeUndefined();
				expect(line.dispatchedById).toBeUndefined();
			} else {
				expect(line.dispatchedBy).toBe(kind);
			}
		}
	});

	test("dispatcher defaults its id to the calling session and rejects unknown kinds", async () => {
		const repo = makeTmpRepo();
		const ctx = makeCtx(repo, () => ({
			toolCall: { type: "toolCall", id: "id/1", name: "external_worker", arguments: {} },
			result: { content: [{ type: "text", text: "pane: w-9" }], details: { pane: "w-9", promptStarted: true } },
			isError: false,
		}));
		ctx.sessionManager = { getSessionId: () => "session-abc" };
		const ok = await tools.get("dispatch_role")!.execute(
			"id",
			{ role: "planner", taskId: "THU-119.1", dispatcher: "teamlead" },
			undefined,
			undefined,
			ctx,
		);
		expect(ok.details).toMatchObject({ dispatchedBy: "teamlead", dispatchedById: "session-abc" });

		const before = calls.length;
		const bad = await tools.get("dispatch_role")!.execute(
			"id",
			{ role: "planner", taskId: "THU-119.1", dispatcher: "cto" },
			undefined,
			undefined,
			ctx,
		);
		expect(bad.isError).toBe(true);
		expect(bad.details.error).toContain('unknown dispatcher kind "cto"');
		expect(calls).toHaveLength(before);

		const extraKey = await tools.get("dispatch_role")!.execute(
			"id",
			{ role: "planner", taskId: "THU-119.1", dispatcher: { kind: "teamlead", reason: "x" } },
			undefined,
			undefined,
			ctx,
		);
		expect(extraKey.isError).toBe(true);
		expect(extraKey.details.error).toContain('unknown key "reason"');
	});

	test("role_list reports five roles with readable prompts and effective candidates", async () => {
		const repo = makeTmpRepo();
		const tool = tools.get("role_list")!;
		const res = await tool.execute("id", {}, undefined, undefined, makeCtx(repo, () => ({ isError: true })));
		expect(res.isError).toBeUndefined();
		expect(res.details.roles).toHaveLength(5);
		for (const role of res.details.roles) {
			expect(role.promptReadable).toBe(true);
			expect(role.candidates.length).toBeGreaterThan(0);
		}
		const reviewer = res.details.roles.find((role: any) => role.id === "reviewer");
		expect(reviewer.candidates[0]).toMatchObject({ kind: "codely", model: "neo/eco/claude-opus-5-5", effort: "xhigh" });
		expect(reviewer.candidates[1]).toMatchObject({ kind: "codex", model: "gpt-6-astra" });
	});

	test("role_resolve is pure (no executeTool) and returns the composed prompt", async () => {
		const repo = makeTmpRepo();
		const tool = tools.get("role_resolve")!;
		const res = await tool.execute(
			"id",
			{ role: "oracle", taskId: "THU-119.1", item: "S0" },
			undefined,
			undefined,
			makeCtx(repo, () => {
				throw new Error("resolve must not launch anything");
			}),
		);
		expect(calls).toHaveLength(0);
		expect(res.details.kind).toBe("codely");
		expect(res.details.model).toBe("neo/eco/claude-opus-5-5");
		expect(res.details.prompt).toContain("THU-119.1");
		expect(res.details.summary).toContain("oracle → codely/neo/eco/claude-opus-5-5");
	});

	test("role_resolve surfaces unknown role as isError", async () => {
		const repo = makeTmpRepo();
		const res = await tools.get("role_resolve")!.execute(
			"id",
			{ role: "cto", taskId: "THU-119.1" },
			undefined,
			undefined,
			makeCtx(repo, () => ({})),
		);
		expect(res.isError).toBe(true);
		expect(res.details.error).toContain('unknown role "cto"');
	});

	test("dispatch forwards role/mode to external_worker and writes the roster on success", async () => {
		const repo = makeTmpRepo();
		const res = await tools.get("dispatch_role")!.execute(
			"id",
			{ role: "researcher", taskId: "THU-119.1", item: "S0", brief: "探针：报告 registry.ts 的 reviewer 候选。" },
			undefined,
			undefined,
			// The real `ctx.executeTool()` resolves to an AgentToolCallOutcome, not to the
			// tool's own return value: dispatch must unwrap `result` before reading details.
			makeCtx(repo, () => ({
				toolCall: { type: "toolCall", id: "id/1", name: "external_worker", arguments: {} },
				result: {
					content: [{ type: "text", text: "pane: w-9" }],
					details: { pane: "w-9", tab: "subagents", promptStarted: true, kind: "codely" },
				},
				isError: false,
			})),
		);

		expect(res.isError).toBeUndefined();
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("external_worker");
		expect(calls[0].params).toMatchObject({
			action: "start",
			kind: "codely",
			model: "neo/eco/claude-opus-5-5",
			effort: "high",
			cwd: repo,
		});
		expect(calls[0].params.task).toContain("THU-119.1");
		expect(calls[0].params.task).toContain("探针：报告 registry.ts 的 reviewer 候选。");
		// Neither approval nor sandbox is forwarded for codely: it runs on its own yolo
		// default and read-only is enforced by the role prompt.
		expect(calls[0].params.approval).toBeUndefined();
		expect(calls[0].params.sandbox).toBeUndefined();

		expect(res.details).toMatchObject({ dispatched: true, pane: "w-9", kind: "codely", model: "neo/eco/claude-opus-5-5" });
		const roster = readFileSync(join(repo, ROSTER_RELATIVE_PATH), "utf8").trim().split("\n");
		expect(roster).toHaveLength(1);
		expect(JSON.parse(roster[0])).toMatchObject({ role: "researcher", pane: "w-9", taskId: "THU-119.1" });
	});

	test("candidateIndex is a diagnostic escape hatch: dispatch can force the fallback", async () => {
		const repo = makeTmpRepo();
		const res = await tools.get("dispatch_role")!.execute(
			"id",
			{ role: "researcher", taskId: "THU-119.2", candidateIndex: 2 },
			undefined,
			undefined,
			makeCtx(repo, () => ({
				toolCall: { type: "toolCall", id: "id/1", name: "external_worker", arguments: {} },
				result: { content: [{ type: "text", text: "pane: w-2" }], details: { pane: "w-2", promptStarted: true } },
				isError: false,
			})),
		);
		expect(res.isError).toBeUndefined();
		expect(calls[0].params).toMatchObject({ kind: "codex", model: "gpt-6-astra", sandbox: "read-only" });
		expect(res.details).toMatchObject({ candidateIndex: 2, candidateCount: 2, kind: "codex" });
	});

	test("dispatch does not write the roster when external_worker fails", async () => {
		const repo = makeTmpRepo();
		const res = await tools.get("dispatch_role")!.execute(
			"id",
			{ role: "reviewer", taskId: "THU-119.1" },
			undefined,
			undefined,
			makeCtx(repo, () => ({
				toolCall: { type: "toolCall", id: "id/1", name: "external_worker", arguments: {} },
				result: { content: [{ type: "text", text: "pane run failed" }], details: {} },
				isError: true,
			})),
		);
		expect(res.isError).toBe(true);
		expect(res.details.trigger).toBe("launch_failed");
		expect(res.details.error).toContain("pane run failed");
		expect(res.details.nextCandidate).toBe(2);
		expect(existsSync(join(repo, ROSTER_RELATIVE_PATH))).toBe(false);
	});

	test("dispatch treats promptStarted:false as a failed launch and keeps the pane for inspection", async () => {
		const repo = makeTmpRepo();
		const res = await tools.get("dispatch_role")!.execute(
			"id",
			{ role: "planner", taskId: "THU-119.1" },
			undefined,
			undefined,
			makeCtx(repo, () => ({
				content: [{ type: "text", text: "pane: w-3" }],
				details: { pane: "w-3", tab: "subagents", promptStarted: false, warnings: ["prompt did not start"] },
			})),
		);
		expect(res.isError).toBe(true);
		expect(res.details.pane).toBe("w-3");
		expect(res.details.warnings).toEqual(["prompt did not start"]);
		expect(existsSync(join(repo, ROSTER_RELATIVE_PATH))).toBe(false);
	});

	test("dispatch refuses a write role on the main worktree before launching anything", async () => {
		const repo = makeTmpRepo();
		mkdirSync(join(repo, ".git"));
		const res = await tools.get("dispatch_role")!.execute(
			"id",
			{ role: "worker", taskId: "THU-119.1" },
			undefined,
			undefined,
			makeCtx(repo, () => ({})),
		);
		expect(res.isError).toBe(true);
		expect(res.details.error).toContain("needs an isolated git worktree");
		expect(calls).toHaveLength(0);
		expect(existsSync(join(repo, ROSTER_RELATIVE_PATH))).toBe(false);
	});

	test("invalid dispatch params fail before any launch", async () => {
		const repo = makeTmpRepo();
		const res = await tools.get("dispatch_role")!.execute(
			"id",
			{ role: "worker", taskId: "" },
			undefined,
			undefined,
			makeCtx(repo, () => ({})),
		);
		expect(res.isError).toBe(true);
		expect(calls).toHaveLength(0);
	});
});
