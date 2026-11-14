/**
 * THU-119.3 单元测试：Backlog 内 TDD 门禁（lib/tdd.ts）。
 *
 * 覆盖三条判定口径、条目往返、选择集指纹、生产代码判定，以及三个动作在假依赖下的
 * 全部通过/拒绝路径。真机验证（AC6）另有 handoff 记录，不在单测范围内。
 *
 * 运行：bun test test/secretary-tdd.test.ts
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	type ChangedSet,
	type CommandOutcome,
	type GateOutcome,
	type GateRequest,
	type TddDeps,
	type TddEntry,
	assertBacklogVersion,
	createTddGate,
	decideGreen,
	decideVerify,
	earlierRed,
	failSignature,
	formatEntry,
	isProductionPath,
	isTestPath,
	normalizeCommand,
	parseTddEntries,
	selectionFingerprint,
} from "../lib/tdd";

const digest = (input: string) => createHash("sha256").update(input, "utf8").digest("hex");
const SEL_A = selectionFingerprint("bun test test/a.test.ts", digest);
const SEL_B = selectionFingerprint("bun test test/b.test.ts", digest);

function entry(overrides: Partial<Omit<TddEntry, "line">> & { action: TddEntry["action"] }): TddEntry {
	const base: Omit<TddEntry, "line"> = {
		ts: "2026-11-15T00:00:00.000Z",
		action: overrides.action,
		task: "THU-119.3",
		cmd: "bun test test/a.test.ts",
		exit: overrides.action === "tdd-red" ? 1 : 0,
		sel: SEL_A,
		...overrides,
	};
	return { ...base, line: formatEntry(base) };
}

/** 可控的假依赖：命令结果、Notes 内容、git 都按用例给定。 */
function makeDeps(options: {
	outcomes?: CommandOutcome[];
	notes?: string | null;
	changed?: string[];
	head?: string;
	snap?: string | undefined;
	backlogError?: Error;
	changedError?: Error;
}) {
	const state = {
		notes: options.notes ?? null,
		appended: [] as string[],
		logs: [] as Array<{ path: string; block: string }>,
		ran: [] as string[],
		backlogChecks: 0,
		outcomes: [...(options.outcomes ?? [])],
	};
	const deps: TddDeps = {
		now: () => new Date("2026-11-15T12:00:00.000Z"),
		digest,
		runCommand: (cmd) => {
			state.ran.push(cmd);
			return state.outcomes.shift() ?? { exit: 0, stdout: "ok", stderr: "" };
		},
		readNotes: () => state.notes,
		appendNotes: (_root, _task, line) => {
			state.appended.push(line);
			state.notes = state.notes ? `${state.notes}\n${line}` : line;
		},
		head: () => options.head ?? "head0000",
		snapshot: () => options.snap,
		changedSince: (): ChangedSet => {
			if (options.changedError) throw options.changedError;
			return { paths: options.changed ?? [], untracked: [] };
		},
		appendLog: (_root, path, block) => state.logs.push({ path, block }),
		assertBacklog: () => {
			state.backlogChecks++;
			if (options.backlogError) throw options.backlogError;
		},
	};
	return { deps, state };
}

const request = (overrides: Partial<GateRequest> = {}): GateRequest => ({
	task: "THU-119.3",
	cmd: "bun test test/a.test.ts",
	cwd: "/repo",
	role: "worker",
	...overrides,
});

// ------------------------------------------------------------------ 选择集

describe("selection set fingerprint", () => {
	test("the same command always yields the same 12-char sel", () => {
		expect(SEL_A).toHaveLength(12);
		expect(selectionFingerprint("bun test test/a.test.ts", digest)).toBe(SEL_A);
	});

	test("only non-semantic whitespace collapses; different commands differ", () => {
		expect(normalizeCommand("  bun   test  test/a.test.ts \n")).toBe("bun test test/a.test.ts");
		expect(selectionFingerprint("bun   test test/a.test.ts", digest)).toBe(SEL_A);
		expect(SEL_B).not.toBe(SEL_A);
		// 参数顺序是语义，不规范化。
		expect(selectionFingerprint("bun test --filter x", digest)).not.toBe(
			selectionFingerprint("bun test x --filter", digest),
		);
	});
});

// ------------------------------------------------------------------ 条目

describe("notes entry format", () => {
	test("a red entry is a single line carrying cmd/exit/sel/fail/log", () => {
		const line = formatEntry({
			ts: "2026-11-15T12:00:00.000Z",
			action: "tdd-red",
			task: "THU-119.3",
			role: "worker",
			cmd: `bun test test/a.test.ts && echo done`,
			exit: 1,
			sel: SEL_A,
			fail: "3 tests failed",
			log: ".handoff/THU-119.3-tdd-red.log",
		});
		expect(line).not.toContain("\n");
		const parsed = parseTddEntries(line);
		expect(parsed).toHaveLength(1);
		expect(parsed[0]).toMatchObject({
			action: "tdd-red",
			task: "THU-119.3",
			role: "worker",
			cmd: "bun test test/a.test.ts && echo done",
			exit: 1,
			sel: SEL_A,
			fail: "3 tests failed",
			log: ".handoff/THU-119.3-tdd-red.log",
		});
	});

	test("green/verify entries round-trip head and snap", () => {
		const line = formatEntry({
			ts: "2026-11-15T12:00:00.000Z",
			action: "tdd-green",
			task: "THU-119.3",
			cmd: "bun test test/a.test.ts",
			exit: 0,
			sel: SEL_A,
			log: ".handoff/THU-119.3-tdd-green.log",
			head: "abc1234",
			snap: "def5678",
		});
		expect(parseTddEntries(line)[0]).toMatchObject({ head: "abc1234", snap: "def5678" });
	});

	test("unrelated prose and malformed gate lines are ignored, never repaired", () => {
		const notes = [
			"手工笔记：先跑 a 再跑 b",
			"- 2026-11-15T12:00:00.000Z tdd-red | task=THU-1 cmd=bun test exit=1 sel=NOTHEX",
			"* 2026-11-15T12:00:00.000Z tdd-green | task=THU-119.3 cmd=bun test test/a.test.ts exit=0 sel=" + SEL_A,
			"",
		].join("\n");
		const parsed = parseTddEntries(notes);
		expect(parsed).toHaveLength(1);
		expect(parsed[0].action).toBe("tdd-green");
	});

	test("a cmd containing a shell pipe still parses", () => {
		const line = formatEntry({
			ts: "2026-11-15T12:00:00.000Z",
			action: "tdd-red",
			task: "THU-119.3",
			cmd: "bun test test/a.test.ts | tail -5",
			exit: 1,
			sel: SEL_A,
			fail: "failed",
			log: ".handoff/x.log",
		});
		expect(parseTddEntries(line)[0]).toMatchObject({
			cmd: "bun test test/a.test.ts | tail -5",
			fail: "failed",
			log: ".handoff/x.log",
		});
	});
});

// ------------------------------------------------------------------ green 判定

describe("green decision (rule 2: selection set must match an earlier red)", () => {
	test("passes when a red with the same sel exists earlier", () => {
		const entries = [entry({ action: "tdd-red" })];
		const decision = decideGreen(entries, SEL_A, "bun test test/a.test.ts");
		expect(decision.ok).toBe(true);
	});

	test("the rejection names the recorded red sels so the caller can see the mismatch", () => {
		// 结构事实：decideGreen 的 entries 是「append 这条 green 之前」读到的台账，所以
		// 「更晚的 red」根本不可能出现在里面——它不构成追认（verify 侧则由 green_before_red
		// 兜住补写的先绿后红）。这里只验证拒绝消息把已有的 red 摊开给调用方。
		const entries = [entry({ action: "tdd-red", sel: SEL_B, cmd: "bun test test/b.test.ts" })];
		const decision = decideGreen(entries, SEL_A, "bun test test/a.test.ts");
		expect(decision.ok).toBe(false);
		if (decision.ok) throw new Error("unreachable");
		expect(decision.error.kind).toBe("selection_mismatch");
		expect(decision.error.message).toContain(`sel=${SEL_A}`);
		expect(decision.error.message).toContain(`${SEL_B}@2026-11-15T00:00:00.000Z`);
		expect(decision.error.message).toContain("a later red cannot retroactively justify");
		expect(decision.error.details.reds).toBe(`${SEL_B}@2026-11-15T00:00:00.000Z`);
	});

	test("a red from a different selection set does not justify this green", () => {
		const entries = [entry({ action: "tdd-red", sel: SEL_B, cmd: "bun test test/b.test.ts" })];
		const decision = decideGreen(entries, SEL_A, "bun test test/a.test.ts");
		expect(decision.ok).toBe(false);
		if (decision.ok) throw new Error("unreachable");
		expect(decision.error.message).toContain(SEL_B);
	});

	test("earlierRed only looks strictly before the given index", () => {
		const entries = [entry({ action: "tdd-green" }), entry({ action: "tdd-red" })];
		expect(earlierRed(entries, SEL_A, 0)).toBeUndefined();
		expect(earlierRed(entries, SEL_A, 2)).toBeDefined();
	});
});

// ------------------------------------------------------------------ verify 判定

describe("verify decision (three named rejection kinds)", () => {
	test("no green at all", () => {
		const decision = decideVerify([entry({ action: "tdd-red" })], () => []);
		expect(decision.ok).toBe(false);
		if (decision.ok) throw new Error("unreachable");
		expect(decision.kind).toBe("no_green");
	});

	test("green earlier than its red names green_before_red", () => {
		const entries = [
			entry({ action: "tdd-green", ts: "2026-11-15T10:00:00.000Z" }),
			entry({ action: "tdd-red", ts: "2026-11-15T11:00:00.000Z" }),
		];
		const decision = decideVerify(entries, () => []);
		expect(decision.ok).toBe(false);
		if (decision.ok) throw new Error("unreachable");
		expect(decision.kind).toBe("green_before_red");
		expect(decision.message).toContain("2026-11-15T10:00:00.000Z");
		expect(decision.message).toContain("2026-11-15T11:00:00.000Z");
	});

	test("green whose sel never appeared in a red names selection_mismatch", () => {
		const entries = [entry({ action: "tdd-red", sel: SEL_B }), entry({ action: "tdd-green", sel: SEL_A })];
		const decision = decideVerify(entries, () => []);
		expect(decision.ok).toBe(false);
		if (decision.ok) throw new Error("unreachable");
		expect(decision.kind).toBe("selection_mismatch");
		expect(decision.message).toContain(SEL_A);
		expect(decision.message).toContain(SEL_B);
	});

	test("production edits after green name production_changed_after_green", () => {
		const entries = [
			entry({ action: "tdd-red" }),
			entry({ action: "tdd-green", snap: "snap0001" }),
		];
		const decision = decideVerify(entries, () => ["src/Engine/Fix.cs", "tests/a.test.ts"]);
		expect(decision.ok).toBe(false);
		if (decision.ok) throw new Error("unreachable");
		expect(decision.kind).toBe("production_changed_after_green");
		expect(decision.message).toContain("src/Engine/Fix.cs");
		// 测试文件与台账不算生产代码改动。
		expect(decision.message).not.toContain("tests/a.test.ts");
	});

	test("passes with productionCheck=checked when only tests and backlog moved", () => {
		const entries = [entry({ action: "tdd-red" }), entry({ action: "tdd-green", snap: "snap0001" })];
		const decision = decideVerify(entries, () => ["tests/a.test.ts", "backlog/tasks/thu-1.md", ".handoff/x.log"]);
		expect(decision.ok).toBe(true);
		if (!decision.ok) throw new Error("expected ok");
		expect(decision.productionCheck).toBe("checked");
	});

	test("degrades to skipped (never fakes a check) when the ref is unusable", () => {
		const noRef = [entry({ action: "tdd-red" }), entry({ action: "tdd-green" })];
		const first = decideVerify(noRef, () => []);
		expect(first.ok).toBe(true);
		if (!first.ok) throw new Error("expected ok");
		expect(first.productionCheck).toBe("skipped");
		expect(first.note).toContain("neither snap nor head");

		const badRef = [entry({ action: "tdd-red" }), entry({ action: "tdd-green", head: "gone" })];
		const second = decideVerify(badRef, () => {
			throw new Error("bad object name");
		});
		expect(second.ok).toBe(true);
		if (!second.ok) throw new Error("expected ok");
		expect(second.productionCheck).toBe("skipped");
		expect(second.note).toContain("bad object name");
	});

	test("the last green wins", () => {
		const entries = [
			entry({ action: "tdd-red" }),
			entry({ action: "tdd-green", snap: "snap-old" }),
			entry({ action: "tdd-green", snap: "snap-new", ts: "2026-11-15T14:00:00.000Z" }),
		];
		const seen: string[] = [];
		const decision = decideVerify(entries, (ref) => {
			seen.push(ref);
			return [];
		});
		expect(decision.ok).toBe(true);
		expect(seen).toEqual(["snap-new"]);
	});
});

// ------------------------------------------------------------------ 路径分类

describe("production path classification", () => {
	test("tests, ledger, evidence and scaffold are not production", () => {
		for (const path of [
			"tests/Thunder.Unit.Tests/Foo.cs",
			"src/Thunder.X.Tests/Foo.cs",
			"web/app.test.ts",
			"scripts/run_test.py",
			"backlog/tasks/thu-119.3 - x.md",
			".handoff/THU-119.3-tdd-red.log",
			".backlog-workflow/sdd/THU-119.3/progress.md",
			"node_modules/pkg/index.js",
		]) {
			expect(isProductionPath(path)).toBe(false);
		}
	});

	test("source files stay production", () => {
		for (const path of ["src/Thunder.Compiler/Parser.cs", "lib/tdd.ts", "README.md"]) {
			expect(isProductionPath(path)).toBe(true);
		}
	});

	test("isTestPath matches conventions used in this repo", () => {
		expect(isTestPath("tests/Thunder.Integration.Tests/x.cs")).toBe(true);
		expect(isTestPath("src/Foo.Tests/Bar.cs")).toBe(true);
		expect(isTestPath("src/Foo/Bar.cs")).toBe(false);
	});
});

// ------------------------------------------------------------------ 门禁动作

describe("tdd-red", () => {
	test("records a failing run as one notes line with a log pointer", () => {
		const { deps, state } = makeDeps({ outcomes: [{ exit: 1, stdout: "", stderr: "3 tests failed" }] });
		const outcome = createTddGate(deps).red(request());
		expect(outcome.ok).toBe(true);
		expect(outcome.sel).toBe(SEL_A);
		expect(state.appended).toHaveLength(1);
		const parsed = parseTddEntries(state.appended[0])[0];
		expect(parsed).toMatchObject({ action: "tdd-red", exit: 1, sel: SEL_A, task: "THU-119.3", role: "worker" });
		expect(parsed.fail).toContain("3 tests failed");
		expect(parsed.log).toBe(".handoff/THU-119.3-tdd-red.log");
		// 日志写的是完整输出，Notes 只有指针。
		expect(state.logs[0].path).toBe(".handoff/THU-119.3-tdd-red.log");
		expect(state.logs[0].block).toContain("3 tests failed");
	});

	test("a passing run is rejected as red_passed and writes no notes", () => {
		const { deps, state } = makeDeps({ outcomes: [{ exit: 0, stdout: "all good", stderr: "" }] });
		const outcome = createTddGate(deps).red(request());
		expect(outcome.ok).toBe(false);
		expect(outcome.failure?.kind).toBe("red_passed");
		expect(outcome.failure?.message).toContain("cannot be recorded as red");
		expect(state.appended).toHaveLength(0);
	});

	test("backlog version gate runs before any command", () => {
		const { deps, state } = makeDeps({ backlogError: new Error('backlog --version must contain "-thu."') });
		expect(() => createTddGate(deps).red(request())).toThrow(/must contain "-thu\."/);
		expect(state.ran).toHaveLength(0);
		expect(state.appended).toHaveLength(0);
	});

	test("a missing --cmd is a hard error", () => {
		const { deps } = makeDeps({});
		expect(() => createTddGate(deps).red(request({ cmd: "  " }))).toThrow(/needs --cmd/);
	});
});

describe("tdd-green", () => {
	test("rejects when no earlier red shares the selection set, naming the sel", () => {
		const { deps, state } = makeDeps({});
		const outcome = createTddGate(deps).green(request());
		expect(outcome.ok).toBe(false);
		expect(outcome.exit).toBe(1);
		expect(outcome.failure?.kind).toBe("selection_mismatch");
		expect(outcome.failure?.message).toContain(SEL_A);
		expect(outcome.failure?.message).toContain("none");
		// 未通过判定时绝不跑命令，也不写 Notes。
		expect(state.ran).toHaveLength(0);
		expect(state.appended).toHaveLength(0);
	});

	test("a failing run after a valid red is green_failed, not green", () => {
		const red = formatEntry({
			ts: "2026-11-15T11:00:00.000Z",
			action: "tdd-red",
			task: "THU-119.3",
			cmd: "bun test test/a.test.ts",
			exit: 1,
			sel: SEL_A,
			fail: "1 failed",
			log: ".handoff/THU-119.3-tdd-red.log",
		});
		const { deps, state } = makeDeps({ notes: red, outcomes: [{ exit: 2, stdout: "still broken", stderr: "" }] });
		const outcome = createTddGate(deps).green(request());
		expect(outcome.ok).toBe(false);
		expect(outcome.failure?.kind).toBe("green_failed");
		expect(state.appended).toHaveLength(0);
	});

	test("records green with head+snap after a valid red and a passing run", () => {
		const red = formatEntry({
			ts: "2026-11-15T11:00:00.000Z",
			action: "tdd-red",
			task: "THU-119.3",
			cmd: "bun test test/a.test.ts",
			exit: 1,
			sel: SEL_A,
			fail: "1 failed",
			log: ".handoff/THU-119.3-tdd-red.log",
		});
		const { deps, state } = makeDeps({ notes: red, snap: "snap0001", head: "head0000" });
		const outcome = createTddGate(deps).green(request());
		expect(outcome.ok).toBe(true);
		const parsed = parseTddEntries(state.appended[0])[0];
		expect(parsed).toMatchObject({ action: "tdd-green", exit: 0, sel: SEL_A, head: "head0000", snap: "snap0001" });
	});
});

describe("tdd-verify", () => {
	const redLine = formatEntry({
		ts: "2026-11-15T11:00:00.000Z",
		action: "tdd-red",
		task: "THU-119.3",
		cmd: "bun test test/a.test.ts",
		exit: 1,
		sel: SEL_A,
		fail: "1 failed",
		log: ".handoff/THU-119.3-tdd-red.log",
	});
	const greenLine = formatEntry({
		ts: "2026-11-15T12:00:00.000Z",
		action: "tdd-green",
		task: "THU-119.3",
		cmd: "bun test test/a.test.ts",
		exit: 0,
		sel: SEL_A,
		log: ".handoff/THU-119.3-tdd-green.log",
		head: "head0000",
		snap: "snap0001",
	});

	test("passes on a clean chain and never runs the command", () => {
		const { deps, state } = makeDeps({ notes: `${redLine}\n${greenLine}`, changed: ["tests/a.test.ts"] });
		const outcome = createTddGate(deps).verify(request({ cmd: undefined }));
		expect(outcome.ok).toBe(true);
		expect(state.ran).toHaveLength(0);
		expect(outcome.verified?.productionCheck).toBe("checked");
		expect(parseTddEntries(state.appended[0])[0].action).toBe("tdd-verify");
	});

	test("rejects a green recorded before its red", () => {
		const notes = [
			formatEntry({
				ts: "2026-11-15T10:00:00.000Z",
				action: "tdd-green",
				task: "THU-119.3",
				cmd: "bun test test/a.test.ts",
				exit: 0,
				sel: SEL_A,
				head: "head0000",
			}),
			redLine,
		].join("\n");
		const { deps, state } = makeDeps({ notes });
		const outcome = createTddGate(deps).verify(request({ cmd: undefined }));
		expect(outcome.ok).toBe(false);
		expect(outcome.failure?.kind).toBe("green_before_red");
		expect(state.appended).toHaveLength(0);
		expect(state.logs.at(-1)?.block).toContain("green_before_red");
	});

	test("rejects production edits made after green", () => {
		const { deps, state } = makeDeps({ notes: `${redLine}\n${greenLine}`, changed: ["src/Thunder.Compiler/Parser.cs"] });
		const outcome = createTddGate(deps).verify(request({ cmd: undefined }));
		expect(outcome.ok).toBe(false);
		expect(outcome.failure?.kind).toBe("production_changed_after_green");
		expect(outcome.failure?.message).toContain("src/Thunder.Compiler/Parser.cs");
		expect(state.appended).toHaveLength(0);
	});

	test("reports skipped instead of pretending when the baseline is gone", () => {
		const noRef = formatEntry({
			ts: "2026-11-15T12:00:00.000Z",
			action: "tdd-green",
			task: "THU-119.3",
			cmd: "bun test test/a.test.ts",
			exit: 0,
			sel: SEL_A,
			log: ".handoff/THU-119.3-tdd-green.log",
		});
		const { deps } = makeDeps({ notes: `${redLine}\n${noRef}` });
		const outcome: GateOutcome = createTddGate(deps).verify(request({ cmd: undefined }));
		expect(outcome.ok).toBe(true);
		expect(outcome.verified?.productionCheck).toBe("skipped");
		expect(outcome.notices?.[0]).toContain("could not be diffed");
	});
});

// ------------------------------------------------------------------ 默认依赖

describe("default deps surface", () => {
	test("assertBacklogVersion rejects a CLI without the -thu. suffix", () => {
		// 用一个不可能有 backlog 的目录：错误必须是「不可用」而不是静默通过。
		expect(() => assertBacklogVersion("/nonexistent-thu119-check")).toThrow(/backlog CLI is unavailable/);
	});

	test("failSignature prefers framework counters over raw noise", () => {
		// 匹配到的签名会被压成单行（Notes 条目必须单行），因此断言比较的是规范形。
		expect(failSignature({ exit: 1, stdout: "Failed!  - Failed:     3, Passed:   10", stderr: "" })).toBe(
			"Failed! - Failed: 3, Passed: 10",
		);
		expect(failSignature({ exit: 1, stdout: "", stderr: "Assert.Equal() Failure" })).toBe("Assert.Equal() Failure");
		expect(failSignature({ exit: 1, stdout: "", stderr: "" })).toBe("exit 1");
	});
});
