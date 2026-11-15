/**
 * THU-119.4 单元测试：单 reviewer 的 review package / 双 verdict / review_verify 门禁。
 *
 * 覆盖：task id 与 SDD 路径安全校验、package 渲染（diff 只给指针）、报告解析
 * （✅/❌/⚠️ 与等价结构化值）、verdict 判定、prepare/record/verify 的正负路径、
 * Notes 条目往返，以及注册表里 reviewer 的 report-only 写权限契约。
 *
 * 运行：bun test test/secretary-review.test.ts
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLE_REGISTRY, RoleRegistryError, type RolePermissions, validateRegistry } from "../roles/registry";
import {
	type RangeDiff,
	ReviewGateError,
	type ReviewDeps,
	type ReviewIssue,
	type ReviewTaskContext,
	assertSafeTaskId,
	assertSddPath,
	countIssues,
	createReviewGate,
	decideReview,
	formatReviewEntry,
	isReviewerWritablePath,
	parseReviewEntries,
	parseReviewReport,
	parseVerdictValue,
	renderReviewPackage,
	reviewPaths,
	sameSha,
} from "../lib/review";

const ROOT = "/repo";
const BASE_FULL = "1".repeat(40);
const HEAD_FULL = "2".repeat(40);
const BASE_SHORT = BASE_FULL.slice(0, 12);
const HEAD_SHORT = HEAD_FULL.slice(0, 12);

const DEFAULT_TASK: ReviewTaskContext = {
	id: "THU-119.4",
	title: "[S4] Review package、双 verdict 与 AC 门禁",
	status: "In Progress",
	description: "补齐单 reviewer 的审查闭环。",
	spec: "范围仅限 S4 review 能力；禁止 reviewer 修改 source、Backlog markdown 或 AC。",
	plan: "1. review package；2. reviewer 双 verdict；3. review_verify 门禁。",
	acceptanceCriteria: [
		{ index: 1, text: "reviewer prompt 定义双 verdict", checked: false },
		{ index: 2, text: "package 含任务上下文与 diff 指针", checked: true },
	],
	notes: null,
};

const DEFAULT_DIFF: RangeDiff = {
	files: [
		{ path: "lib/review.ts", additions: 120, deletions: 0 },
		{ path: "test/secretary-review.test.ts", additions: 240, deletions: 0 },
	],
	patch: [
		"diff --git a/lib/review.ts b/lib/review.ts",
		"index 1111111..2222222 100644",
		"--- a/lib/review.ts",
		"+++ b/lib/review.ts",
		"@@ -1,2 +1,2 @@",
		"-const old = true;",
		"+const fresh = true;",
	].join("\n"),
};

const COMMITS: Record<string, string> = {
	[BASE_SHORT]: BASE_FULL,
	[BASE_FULL]: BASE_FULL,
	[HEAD_SHORT]: HEAD_FULL,
	[HEAD_FULL]: HEAD_FULL,
};

const TDD_NOTES = [
	"- 2026-11-15T11:00:00.000Z tdd-red | task=THU-119.4 role=worker cmd=bun test test/a.test.ts exit=1 sel=aaaaaaaaaaaa | fail=1 failed | log=.handoff/THU-119.4-tdd-red.log",
	"- 2026-11-15T12:00:00.000Z tdd-green | task=THU-119.4 role=worker cmd=bun test test/a.test.ts exit=0 sel=aaaaaaaaaaaa head=head0000 | log=.handoff/THU-119.4-tdd-green.log",
].join("\n");

function makeDeps(options: {
	task?: ReviewTaskContext | null;
	commits?: Record<string, string>;
	ancestor?: boolean;
	diff?: RangeDiff;
	files?: Record<string, string>;
	notes?: string | null;
	constraints?: string[];
	taskViewThrows?: Error;
} = {}) {
	const files = new Map<string, string>(Object.entries(options.files ?? {}));
	const writes: Array<{ path: string; content: string }> = [];
	const appended: Array<{ path: string; content: string }> = [];
	const notes: string[] = [];
	const deps: ReviewDeps = {
		now: () => new Date("2026-11-15T12:00:00.000Z"),
		taskView: () => {
			if (options.taskViewThrows) throw options.taskViewThrows;
			return options.task === undefined ? DEFAULT_TASK : options.task;
		},
		resolveCommit: (_root, sha) => (options.commits ?? COMMITS)[sha] ?? null,
		isAncestor: () => options.ancestor ?? true,
		diffRange: () => options.diff ?? DEFAULT_DIFF,
		readNotes: () => options.notes ?? null,
		appendNotes: (_root, _task, line) => notes.push(line),
		readFile: (path) => files.get(path) ?? null,
		writeFile: (path, content) => {
			writes.push({ path, content });
			files.set(path, content);
		},
		exists: (path) => files.has(path),
		appendFile: (path, content) => {
			appended.push({ path, content });
			files.set(path, `${files.get(path) ?? ""}${content}`);
		},
		defaultConstraints: () => options.constraints ?? ["不要引入新依赖；不要修改父任务。"],
	};
	return { deps, files, writes, appended, notes };
}

const prepareRequest = (overrides: Record<string, unknown> = {}) => ({
	task: "THU-119.4",
	baseSha: BASE_SHORT,
	headSha: HEAD_SHORT,
	cwd: ROOT,
	...overrides,
});

const verifyRequest = (overrides: Record<string, unknown> = {}) => ({
	task: "THU-119.4",
	baseSha: BASE_SHORT,
	headSha: HEAD_SHORT,
	cwd: ROOT,
	...overrides,
});

const REPORT = [
	"# Review — THU-119.4",
	"",
	`task: THU-119.4`,
	`base: ${BASE_SHORT}`,
	`head: ${HEAD_SHORT}`,
	"",
	"## Verdict",
	"spec: ✅ compliant",
	"quality: ❌ issues",
	"",
	"## Issues",
	"### Critical",
	"- `lib/review.ts:42` — 越界路径未校验 | trigger: task id 含 `..` | suggestion: 先 assertSafeTaskId",
	"### Important",
	"- `lib/review.ts:88` — 报告缺 verdict 时静默通过 | trigger: 无 spec 行 | suggestion: 拒绝 report_invalid",
	"### Minor",
	"- `test/a.test.ts:9` — 测试名与断言不符",
	"",
	"## Strengths",
	"- Notes 条目单行可 grep。",
	"",
	"## Checked high-risk points",
	"- 路径逃逸：断言 task id 无分隔符。",
].join("\n");

function reportWith(
	overrides: { spec?: string; quality?: string; critical?: string[]; important?: string[]; minor?: string[]; checked?: boolean } = {},
): string {
	return [
		"# Review — THU-119.4",
		`task: THU-119.4`,
		`base: ${BASE_SHORT}`,
		`head: ${HEAD_SHORT}`,
		"",
		"## Verdict",
		`spec: ${overrides.spec ?? "✅ compliant"}`,
		`quality: ${overrides.quality ?? "✅ compliant"}`,
		"",
		"## Issues",
		"### Critical",
		...(overrides.critical ?? []).map((line) => `- ${line}`),
		"### Important",
		...(overrides.important ?? []).map((line) => `- ${line}`),
		"### Minor",
		...(overrides.minor ?? []).map((line) => `- ${line}`),
		"",
		"## Checked high-risk points",
		...(overrides.checked === false ? [] : ["- 路径逃逸：已验证。"]),
	].join("\n");
}

/** 先 prepare 再 record，返回可 verify 的假依赖。 */
function withPackageAndReport(report: string, options: Parameters<typeof makeDeps>[0] = {}) {
	const state = makeDeps(options);
	const gate = createReviewGate(state.deps);
	const prepared = gate.prepare(prepareRequest());
	if (!prepared.ok) throw new Error(`prepare failed: ${prepared.failure?.message}`);
	const recorded = gate.record({ task: "THU-119.4", cwd: ROOT, report });
	if (!recorded.ok) throw new Error(`record failed: ${recorded.failure?.message}`);
	return { ...state, gate };
}

// ------------------------------------------------------------------ task id / 路径

describe("task id and SDD path safety", () => {
	test("accepts normal Backlog ids", () => {
		for (const task of ["THU-119.4", "thu-1", "A_1.2-3"]) expect(assertSafeTaskId(task)).toBe(task);
	});

	test("rejects traversal, separators and blank ids", () => {
		for (const task of ["", " ", "../x", "a/b", "a\\b", ".", "..", "a..b", "/abs", "a b", "a\nb"]) {
			expect(() => assertSafeTaskId(task)).toThrow(ReviewGateError);
		}
	});

	test("every review artifact lives under .backlog-workflow/sdd/<task>/", () => {
		const paths = reviewPaths(ROOT, "THU-119.4");
		expect(paths.dir).toBe(join(ROOT, ".backlog-workflow", "sdd", "THU-119.4"));
		for (const path of [paths.packageFile, paths.reportFile, paths.diffFile, paths.logFile]) {
			expect(path.startsWith(`${paths.dir}/`)).toBe(true);
		}
	});

	test("assertSddPath rejects other tasks and traversal", () => {
		const paths = reviewPaths(ROOT, "THU-119.4");
		expect(assertSddPath(ROOT, "THU-119.4", paths.reportFile)).toBe(paths.reportFile);
		expect(() => assertSddPath(ROOT, "THU-119.4", `${paths.dir}/../../src/x.ts`)).toThrow(/outside/);
		expect(() => assertSddPath(ROOT, "THU-119.4", reviewPaths(ROOT, "THU-1").reportFile)).toThrow(/outside/);
	});

	test("reviewer may write only report.md inside its own task dir", () => {
		const paths = reviewPaths(ROOT, "THU-119.4");
		expect(isReviewerWritablePath(ROOT, "THU-119.4", paths.reportFile)).toBe(true);
		expect(isReviewerWritablePath(ROOT, "THU-119.4", paths.packageFile)).toBe(false);
		expect(isReviewerWritablePath(ROOT, "THU-119.4", join(ROOT, "lib/review.ts"))).toBe(false);
		expect(isReviewerWritablePath(ROOT, "THU-119.4", reviewPaths(ROOT, "THU-1").reportFile)).toBe(false);
	});
});

// ------------------------------------------------------------------ package

describe("review package", () => {
	const render = () =>
		renderReviewPackage({
			task: DEFAULT_TASK,
			baseSha: BASE_FULL,
			headSha: HEAD_FULL,
			generatedAt: "2026-11-15T12:00:00.000Z",
			workspace: ROOT,
			constraints: ["不要引入新依赖。", "不要修改父任务。"],
			files: DEFAULT_DIFF.files,
			tdd: [
				{
					ts: "2026-11-15T11:00:00.000Z",
					action: "tdd-red",
					task: "THU-119.4",
					cmd: "bun test test/a.test.ts",
					exit: 1,
					sel: "aaaaaaaaaaaa",
					fail: "1 failed",
					log: ".handoff/THU-119.4-tdd-red.log",
					line: "- red",
				},
			],
			paths: {
				packagePath: ".backlog-workflow/sdd/THU-119.4/review-package.md",
				reportPath: ".backlog-workflow/sdd/THU-119.4/report.md",
				diffPath: ".backlog-workflow/sdd/THU-119.4/diff.txt",
			},
		});

	test("carries task context, Spec, AC, constraints and the diff pointer", () => {
		const text = render();
		expect(text).toContain("task: THU-119.4");
		expect(text).toContain(`base: ${BASE_FULL}`);
		expect(text).toContain(`head: ${HEAD_FULL}`);
		expect(text).toContain(DEFAULT_TASK.title);
		expect(text).toContain("范围仅限 S4 review 能力");
		expect(text).toContain("reviewer prompt 定义双 verdict");
		expect(text).toContain("AC2");
		expect(text).toContain("不要引入新依赖。");
		expect(text).toContain("lib/review.ts");
		expect(text).toContain(".backlog-workflow/sdd/THU-119.4/diff.txt");
		expect(text).toContain(".backlog-workflow/sdd/THU-119.4/report.md");
		expect(text).toContain(".handoff/THU-119.4-tdd-red.log");
	});

	test("never inlines the diff body", () => {
		const text = render();
		expect(DEFAULT_DIFF.patch).not.toContain("nope");
		expect(text).not.toContain("@@ -1,2 +1,2 @@");
		expect(text).not.toContain("const fresh = true;");
	});

	test("says so explicitly when no TDD evidence exists", () => {
		const text = renderReviewPackage({
			task: DEFAULT_TASK,
			baseSha: BASE_FULL,
			headSha: HEAD_FULL,
			generatedAt: "2026-11-15T12:00:00.000Z",
			workspace: ROOT,
			constraints: [],
			files: DEFAULT_DIFF.files,
			tdd: [],
			paths: {
				packagePath: ".backlog-workflow/sdd/THU-119.4/review-package.md",
				reportPath: ".backlog-workflow/sdd/THU-119.4/report.md",
				diffPath: ".backlog-workflow/sdd/THU-119.4/diff.txt",
			},
		});
		expect(text).toContain("no tdd-red/tdd-green recorded");
	});
});

// ------------------------------------------------------------------ 报告解析

describe("verdict values", () => {
	test("accepts emoji and equivalent structured words", () => {
		expect(parseVerdictValue("✅ compliant")).toBe("compliant");
		expect(parseVerdictValue("✅")).toBe("compliant");
		expect(parseVerdictValue("compliant")).toBe("compliant");
		expect(parseVerdictValue("❌ issues found")).toBe("issues");
		expect(parseVerdictValue("not compliant")).toBe("issues");
		expect(parseVerdictValue("issues")).toBe("issues");
		expect(parseVerdictValue("⚠️ cannot verify from diff")).toBe("cannot_verify");
		expect(parseVerdictValue("cannot_verify")).toBe("cannot_verify");
		expect(parseVerdictValue("unverified")).toBe("cannot_verify");
	});

	test("unknown values are not silently accepted", () => {
		expect(parseVerdictValue("looks fine")).toBeUndefined();
		expect(parseVerdictValue("")).toBeUndefined();
	});
});

describe("review report parsing", () => {
	test("reads metadata, both verdicts and severity-bucketed issues", () => {
		const parsed = parseReviewReport(REPORT);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error("unreachable");
		const report = parsed.report;
		expect(report.task).toBe("THU-119.4");
		expect(report.spec).toBe("compliant");
		expect(report.quality).toBe("issues");
		expect(report.issues).toHaveLength(3);
		expect(report.issues[0]).toMatchObject({ severity: "critical", location: "lib/review.ts:42" });
		expect(report.issues[0].title).toContain("越界路径未校验");
		expect(report.issues[0].trigger).toContain("task id");
		expect(report.issues[0].suggestion).toContain("assertSafeTaskId");
		expect(report.issues[1]).toMatchObject({ severity: "important", location: "lib/review.ts:88" });
		expect(report.issues[2]).toMatchObject({ severity: "minor", location: "test/a.test.ts:9" });
		expect(report.strengths).toHaveLength(1);
		expect(report.checked).toHaveLength(1);
	});

	test("accepts the inline severity form too", () => {
		const raw = [
			"task: THU-119.4",
			`base: ${BASE_SHORT}`,
			`head: ${HEAD_SHORT}`,
			"spec: ❌ issues",
			"quality: ⚠️ cannot verify",
			"- Critical: `src/a.ts:10` — 空指针",
		].join("\n");
		const parsed = parseReviewReport(raw);
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error("unreachable");
		expect(parsed.report.issues[0]).toMatchObject({ severity: "critical", location: "src/a.ts:10" });
	});

	test("a report without both verdicts is invalid, not a pass", () => {
		const parsed = parseReviewReport("task: THU-119.4\nspec: ✅ compliant\n");
		expect(parsed.ok).toBe(false);
		if (parsed.ok) throw new Error("unreachable");
		expect(parsed.reason).toContain("quality");
	});

	test("countIssues buckets by severity", () => {
		const issues: ReviewIssue[] = [
			{ severity: "critical", location: "a.ts:1", title: "a" },
			{ severity: "minor", location: "b.ts:2", title: "b" },
			{ severity: "minor", location: "c.ts:3", title: "c" },
		];
		expect(countIssues(issues)).toEqual({ critical: 1, important: 0, minor: 2, total: 3 });
	});
});

// ------------------------------------------------------------------ 判定

describe("review decision", () => {
	const expectRange = { task: "THU-119.4", baseSha: BASE_FULL, headSha: HEAD_FULL };

	test("compliant spec with only minor issues passes and records the minors", () => {
		const parsed = parseReviewReport(reportWith({ minor: ["`a.ts:1` — 命名小问题"] }));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) throw new Error("unreachable");
		const decision = decideReview(parsed.report, expectRange);
		expect(decision.ok).toBe(true);
		if (!decision.ok) throw new Error("unreachable");
		expect(decision.counts.minor).toBe(1);
		expect(decision.minor[0].location).toBe("a.ts:1");
	});

	test("spec issues / cannot verify both block, with distinct kinds", () => {
		const base = { quality: "compliant" as const, task: "THU-119.4", baseSha: BASE_FULL, headSha: HEAD_FULL, issues: [], strengths: [], checked: [], raw: "" };
		const issues = decideReview({ ...base, spec: "issues" }, expectRange);
		expect(issues.ok).toBe(false);
		if (issues.ok) throw new Error("unreachable");
		expect(issues.kind).toBe("spec_not_compliant");

		const unverified = decideReview({ ...base, spec: "cannot_verify" }, expectRange);
		expect(unverified.ok).toBe(false);
		if (unverified.ok) throw new Error("unreachable");
		expect(unverified.kind).toBe("spec_unverified");
	});

	test("quality cannot_verify blocks instead of pretending the code was reviewed", () => {
		const decision = decideReview(
			{ spec: "compliant", quality: "cannot_verify", task: "THU-119.4", baseSha: BASE_FULL, headSha: HEAD_FULL, issues: [], strengths: [], checked: [], raw: "" },
			expectRange,
		);
		expect(decision.ok).toBe(false);
		if (decision.ok) throw new Error("unreachable");
		expect(decision.kind).toBe("quality_unverified");
	});

	test("critical and important issues block; minor does not", () => {
		const report = (severity: ReviewIssue["severity"]) => ({
			spec: "compliant" as const,
			quality: "issues" as const,
			task: "THU-119.4",
			baseSha: BASE_FULL,
			headSha: HEAD_FULL,
			issues: [{ severity, location: "a.ts:1", title: "x" }],
			strengths: [],
			checked: [],
			raw: "",
		});
		for (const severity of ["critical", "important"] as const) {
			const decision = decideReview(report(severity), expectRange);
			expect(decision.ok).toBe(false);
			if (decision.ok) throw new Error("unreachable");
			expect(decision.kind).toBe("blocking_issues");
			expect(decision.details.counts).toMatchObject({ [severity]: 1 });
		}
		expect(decideReview(report("minor"), expectRange).ok).toBe(true);
	});

	test("quality=issues with no listed issue is rejected as malformed", () => {
		const decision = decideReview(
			{ spec: "compliant", quality: "issues", task: "THU-119.4", baseSha: BASE_FULL, headSha: HEAD_FULL, issues: [], strengths: [], checked: [], raw: "" },
			expectRange,
		);
		expect(decision.ok).toBe(false);
		if (decision.ok) throw new Error("unreachable");
		expect(decision.kind).toBe("report_invalid");
	});

	test("task / base / head must match the audited range", () => {
		const base = { spec: "compliant" as const, quality: "compliant" as const, task: "THU-119.4", baseSha: BASE_FULL, headSha: HEAD_FULL, issues: [], strengths: [], checked: [], raw: "" };
		for (const [field, value] of [
			["task", "THU-1"],
			["baseSha", "3".repeat(40)],
			["headSha", "4".repeat(40)],
		] as const) {
			const decision = decideReview({ ...base, [field]: value }, expectRange);
			expect(decision.ok).toBe(false);
			if (decision.ok) throw new Error("unreachable");
			expect(decision.kind).toBe("range_mismatch");
		}
	});

	test("short and full shas compare by prefix", () => {
		expect(sameSha(BASE_SHORT, BASE_FULL)).toBe(true);
		expect(sameSha(BASE_FULL, BASE_SHORT)).toBe(true);
		expect(sameSha(BASE_SHORT, HEAD_SHORT)).toBe(false);
		expect(sameSha("abc", "abcdef")).toBe(false);
	});
});

// ------------------------------------------------------------------ prepare

describe("review prepare", () => {
	test("writes package and diff under the task's SDD dir and returns pointers", () => {
		const { deps, files, writes } = makeDeps({ notes: TDD_NOTES });
		const outcome = createReviewGate(deps).prepare(prepareRequest());
		expect(outcome.ok).toBe(true);
		expect(outcome.baseSha).toBe(BASE_FULL);
		expect(outcome.headSha).toBe(HEAD_FULL);
		expect(outcome.packagePath).toBe(".backlog-workflow/sdd/THU-119.4/review-package.md");
		expect(outcome.reportPath).toBe(".backlog-workflow/sdd/THU-119.4/report.md");
		expect(outcome.diffPath).toBe(".backlog-workflow/sdd/THU-119.4/diff.txt");
		expect(outcome.files?.map((file) => file.path)).toEqual(["lib/review.ts", "test/secretary-review.test.ts"]);

		const paths = reviewPaths(ROOT, "THU-119.4");
		expect(writes.map((write) => write.path).sort()).toEqual([paths.diffFile, paths.packageFile].sort());
		expect(files.get(paths.diffFile)).toContain("@@ -1,2 +1,2 @@");
		const pkg = files.get(paths.packageFile) ?? "";
		expect(pkg).toContain("review-package");
		expect(pkg).toContain(".handoff/THU-119.4-tdd-red.log");
		// 主 session 只拿指针：完整 patch 不进 package，也不进 outcome。
		expect(pkg).not.toContain("@@ -1,2 +1,2 @@");
		expect(JSON.stringify(outcome)).not.toContain("@@ -1,2 +1,2 @@");
	});

	test("rejects a task id that could escape the SDD dir", () => {
		const { deps, writes } = makeDeps({});
		expect(() => createReviewGate(deps).prepare(prepareRequest({ task: "../../etc" }))).toThrow(ReviewGateError);
		expect(writes).toHaveLength(0);
	});

	test("rejects malformed shas before touching git or disk", () => {
		const { deps, writes } = makeDeps({});
		for (const bad of ["", "abc", "zzzzzzz", "1".repeat(41), "../HEAD"]) {
			expect(() => createReviewGate(deps).prepare(prepareRequest({ baseSha: bad }))).toThrow(ReviewGateError);
		}
		expect(writes).toHaveLength(0);
	});

	test("rejects an unknown commit as invalid_sha", () => {
		const { deps, writes } = makeDeps({});
		const outcome = createReviewGate(deps).prepare(prepareRequest({ headSha: "9".repeat(12) }));
		expect(outcome.ok).toBe(false);
		expect(outcome.failure?.kind).toBe("invalid_sha");
		expect(outcome.failure?.message).toContain("head");
		expect(writes).toHaveLength(0);
	});

	test("rejects a BASE that is not an ancestor of HEAD", () => {
		const { deps, writes } = makeDeps({ ancestor: false });
		const outcome = createReviewGate(deps).prepare(prepareRequest());
		expect(outcome.ok).toBe(false);
		expect(outcome.failure?.kind).toBe("range_not_ancestor");
		expect(writes).toHaveLength(0);
	});

	test("rejects an empty diff range", () => {
		const { deps, writes } = makeDeps({ diff: { files: [], patch: "" } });
		const outcome = createReviewGate(deps).prepare(prepareRequest());
		expect(outcome.ok).toBe(false);
		expect(outcome.failure?.kind).toBe("empty_range");
		expect(writes).toHaveLength(0);
	});

	test("rejects a missing task", () => {
		const { deps, writes } = makeDeps({ task: null });
		const outcome = createReviewGate(deps).prepare(prepareRequest());
		expect(outcome.ok).toBe(false);
		expect(outcome.failure?.kind).toBe("task_not_found");
		expect(writes).toHaveLength(0);
	});
});

// ------------------------------------------------------------------ record

describe("review record", () => {
	test("writes only report.md under the task dir", () => {
		const { deps, files } = makeDeps({});
		const gate = createReviewGate(deps);
		expect(gate.prepare(prepareRequest()).ok).toBe(true);
		const outcome = gate.record({ task: "THU-119.4", cwd: ROOT, report: REPORT });
		expect(outcome.ok).toBe(true);
		const paths = reviewPaths(ROOT, "THU-119.4");
		expect(outcome.reportPath).toBe(".backlog-workflow/sdd/THU-119.4/report.md");
		expect(files.get(paths.reportFile)).toBe(REPORT);
	});

	test("refuses to record before a package exists", () => {
		const { deps, writes } = makeDeps({});
		const outcome = createReviewGate(deps).record({ task: "THU-119.4", cwd: ROOT, report: REPORT });
		expect(outcome.ok).toBe(false);
		expect(outcome.failure?.kind).toBe("package_missing");
		expect(writes).toHaveLength(0);
	});

	test("refuses blank reports and bad task ids", () => {
		const { deps } = makeDeps({});
		const gate = createReviewGate(deps);
		gate.prepare(prepareRequest());
		expect(gate.record({ task: "THU-119.4", cwd: ROOT, report: "   \n" }).ok).toBe(false);
		expect(() => gate.record({ task: "../x", cwd: ROOT, report: REPORT })).toThrow(ReviewGateError);
	});
});

// ------------------------------------------------------------------ verify

describe("review verify", () => {
	test("passes a compliant report and appends one Notes line", () => {
		const { gate, notes, files } = withPackageAndReport(reportWith({ minor: ["### Minor\n`a.ts:1` — 命名"] }));
		const outcome = gate.verify(verifyRequest());
		expect(outcome.ok).toBe(true);
		expect(outcome.spec).toBe("compliant");
		expect(outcome.quality).toBe("compliant");
		expect(outcome.issues).toEqual({ critical: 0, important: 0, minor: 1, total: 1 });
		expect(notes).toHaveLength(1);
		const entry = parseReviewEntries(notes[0])[0];
		expect(entry).toMatchObject({ task: "THU-119.4", spec: "compliant", quality: "compliant", minor: 1 });
		expect(entry.package).toBe(".backlog-workflow/sdd/THU-119.4/review-package.md");
		expect(entry.report).toBe(".backlog-workflow/sdd/THU-119.4/report.md");
		// 只写 Notes 与 SDD 目录：没有任何源码/父任务路径被写。
		const paths = reviewPaths(ROOT, "THU-119.4");
		expect([...files.keys()].every((path) => path.startsWith(paths.dir))).toBe(true);
	});

	test("rejects a critical issue and records nothing in Notes", () => {
		const report = REPORT;
		const { gate, notes, appended } = withPackageAndReport(report);
		const outcome = gate.verify(verifyRequest());
		expect(outcome.ok).toBe(false);
		expect(outcome.failure?.kind).toBe("blocking_issues");
		expect(outcome.failure?.message).toContain("lib/review.ts:42");
		expect(notes).toHaveLength(0);
		expect(appended.at(-1)?.content).toContain("blocking_issues");
	});

	test("rejects spec issues and spec cannot_verify", () => {
		for (const [spec, kind] of [
			["❌ issues", "spec_not_compliant"],
			["⚠️ cannot verify", "spec_unverified"],
		] as const) {
			const { gate, notes } = withPackageAndReport(reportWith({ spec }));
			const outcome = gate.verify(verifyRequest());
			expect(outcome.ok).toBe(false);
			expect(outcome.failure?.kind).toBe(kind);
			expect(notes).toHaveLength(0);
		}
	});

	test("rejects a missing report", () => {
		const { deps } = makeDeps({});
		const gate = createReviewGate(deps);
		expect(gate.prepare(prepareRequest()).ok).toBe(true);
		const outcome = gate.verify(verifyRequest());
		expect(outcome.ok).toBe(false);
		expect(outcome.failure?.kind).toBe("report_missing");
	});

	test("rejects a missing package", () => {
		const { deps } = makeDeps({});
		const outcome = createReviewGate(deps).verify(verifyRequest());
		expect(outcome.ok).toBe(false);
		expect(outcome.failure?.kind).toBe("package_missing");
	});

	test("rejects when the request's HEAD does not match the package", () => {
		const otherHead = "3".repeat(40);
		const { deps } = makeDeps({ commits: { ...COMMITS, [otherHead]: otherHead } });
		const gate = createReviewGate(deps);
		// package 为 BASE..HEAD，但请求换成 BASE..另一个 HEAD。
		expect(gate.prepare(prepareRequest()).ok).toBe(true);
		expect(gate.record({ task: "THU-119.4", cwd: ROOT, report: reportWith({}) }).ok).toBe(true);
		const outcome = gate.verify(verifyRequest({ headSha: otherHead }));
		expect(outcome.ok).toBe(false);
		expect(outcome.failure?.kind).toBe("range_mismatch");
	});

	test("rejects an invalid report instead of treating silence as approval", () => {
		const { gate } = withPackageAndReport("task: THU-119.4\nspec: ✅ compliant\n");
		const outcome = gate.verify(verifyRequest());
		expect(outcome.ok).toBe(false);
		expect(outcome.failure?.kind).toBe("report_invalid");
	});

	test("notes when the report lists no checked high-risk points (record-only)", () => {
		const { gate } = withPackageAndReport(reportWith({ checked: false }));
		const outcome = gate.verify(verifyRequest());
		expect(outcome.ok).toBe(true);
		expect(outcome.notices?.join(" ")).toContain("high-risk");
	});
});

// ------------------------------------------------------------------ Notes 条目

describe("review notes entry", () => {
	test("formats one parseable line", () => {
		const line = formatReviewEntry({
			ts: "2026-11-15T12:00:00.000Z",
			task: "THU-119.4",
			spec: "compliant",
			quality: "issues",
			base: BASE_SHORT,
			head: HEAD_SHORT,
			critical: 0,
			important: 1,
			minor: 2,
			package: ".backlog-workflow/sdd/THU-119.4/review-package.md",
			report: ".backlog-workflow/sdd/THU-119.4/report.md",
		});
		expect(line).not.toContain("\n");
		expect(parseReviewEntries(line)[0]).toMatchObject({
			task: "THU-119.4",
			spec: "compliant",
			quality: "issues",
			base: BASE_SHORT,
			head: HEAD_SHORT,
			critical: 0,
			important: 1,
			minor: 2,
		});
	});

	test("ignores prose and malformed lines", () => {
		const notes = ["手工笔记：review 过了", "- 2026-11-15T12:00:00.000Z review-verify | task=THU-1 spec=nope"].join("\n");
		expect(parseReviewEntries(notes)).toHaveLength(0);
	});
});

// ------------------------------------------------------------------ 权限契约

describe("role permission contract", () => {
	test("reviewer is report-only: no source writes, shared worktree", () => {
		const reviewer = ROLE_REGISTRY.reviewer.permissions;
		expect(reviewer.write).toBe(false);
		expect(reviewer.writeScope).toBe("sdd-report");
		expect(reviewer.worktree).toBe("shared");
	});

	test("worker writes source; other read-only roles write nothing", () => {
		expect(ROLE_REGISTRY.worker.permissions).toMatchObject({ write: true, writeScope: "source" });
		for (const role of ["researcher", "oracle", "planner"] as const) {
			expect(ROLE_REGISTRY[role].permissions).toMatchObject({ write: false, writeScope: "none" });
		}
	});

	test("validation rejects inconsistent write scopes", () => {
		const clone = (): typeof ROLE_REGISTRY => {
			const copy = {} as Record<string, unknown>;
			for (const [id, definition] of Object.entries(ROLE_REGISTRY)) {
				copy[id] = { ...definition, permissions: { ...definition.permissions } };
			}
			return copy as typeof ROLE_REGISTRY;
		};

		const writableReviewer = clone();
		(writableReviewer.reviewer.permissions as RolePermissions).write = true;
		expect(() => validateRegistry(writableReviewer)).toThrow(RoleRegistryError);

		const sourceWithoutWrite = clone();
		(sourceWithoutWrite.reviewer.permissions as RolePermissions).writeScope = "source";
		expect(() => validateRegistry(sourceWithoutWrite)).toThrow(/writeScope/);

		const isolatedReport = clone();
		(isolatedReport.reviewer.permissions as RolePermissions).worktree = "isolated";
		expect(() => validateRegistry(isolatedReport)).toThrow(RoleRegistryError);
	});
});

// ------------------------------------------------------------------ prompt 正文

describe("reviewer prompt", () => {
	const prompt = readFileSync(join(import.meta.dir, "..", "roles", "prompts", "reviewer.md"), "utf8");

	test("defines both verdicts, the audit range and the report-only boundary", () => {
		expect(prompt).toContain("Spec compliance");
		expect(prompt).toContain("code quality");
		expect(prompt).toContain("BASE");
		expect(prompt).toContain("HEAD");
		expect(prompt).toContain("report.md");
		expect(prompt).toContain(".backlog-workflow/sdd/");
		expect(prompt).toContain("Critical");
		expect(prompt).toContain("Important");
		expect(prompt).toContain("Minor");
		expect(prompt).toContain("cannot_verify");
		expect(prompt).toContain("红测试");
	});

	test("forbids source, backlog and AC writes", () => {
		expect(prompt).toMatch(/不得修改|不要修改|禁止/);
		expect(prompt).toContain("AC");
		expect(prompt).toContain("Backlog");
	});
});
