/**
 * 单 reviewer 的 review 闭环（THU-119.4 / S4）。
 *
 * 三段结构，和 TDD 门禁（`lib/tdd.ts`）保持同一形状：
 *
 *   prepare  给定 task + BASE_SHA + HEAD_SHA，把「任务上下文 / Spec / AC / 全局约束 /
 *            diff 文件指针 / TDD 证据指针」渲染成 `.backlog-workflow/sdd/<task>/review-package.md`，
 *            完整 patch 落到同目录 `diff.txt`。主 session 只拿指针，不吞整个 diff。
 *   record   reviewer 交回的报告由主 session 落盘到 `<task>/report.md`——路径由 task id
 *            推导，**不接受调用方给路径**，所以没有「写别处」的入口。
 *   verify   解析报告的双 verdict，按 task/BASE/HEAD/package/report 一致性 + Spec 合规 +
 *            Critical/Important 阻断做门禁；通过时只往目标 task 的 Notes 追加一行，
 *            Minor 只记录不阻断。不勾 AC、不写父任务。
 *
 * reviewer 的越界风险由三层降低：角色 prompt 明写、注册表 `writeScope: "sdd-report"`
 * 权限契约、以及这里的路径门禁（`assertSddPath` / `isReviewerWritablePath`）。
 * codely 侧没有 sandbox 可以强制，所以这些是「降低风险」而不是「保证隔离」。
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertBacklogVersion, type TddEntry, parseTddEntries } from "./tdd";

// ---------------------------------------------------------------- 类型

/** 双 verdict 的取值：✅ compliant / ❌ issues / ⚠️ cannot_verify。 */
export type ReviewVerdict = "compliant" | "issues" | "cannot_verify";
export type ReviewSeverity = "critical" | "important" | "minor";

/** 拒绝原因。前三个是前置安全校验，中间是产物不一致，最后三个是门禁判定。 */
export type ReviewRejectKind =
	| "invalid_task_id"
	| "invalid_sha"
	| "path_escape"
	| "task_not_found"
	| "range_not_ancestor"
	| "empty_range"
	| "package_missing"
	| "report_missing"
	| "report_invalid"
	| "range_mismatch"
	| "spec_not_compliant"
	| "spec_unverified"
	| "quality_unverified"
	| "blocking_issues";

export class ReviewGateError extends Error {
	readonly kind: ReviewRejectKind;
	readonly details: Record<string, unknown>;
	constructor(kind: ReviewRejectKind, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "ReviewGateError";
		this.kind = kind;
		this.details = details;
	}
}

export interface ReviewIssue {
	severity: ReviewSeverity;
	/** `file:line`；报告没给位置时是空串（门禁照常按 severity 判）。 */
	location: string;
	title: string;
	trigger?: string;
	suggestion?: string;
	planMandated?: boolean;
}

export interface ReviewReport {
	task?: string;
	baseSha?: string;
	headSha?: string;
	spec: ReviewVerdict;
	quality: ReviewVerdict;
	issues: ReviewIssue[];
	strengths: string[];
	/** 「已检查且放心的高风险点」。 */
	checked: string[];
	/** 证据不足、明确标成 cannot verify 的事实。 */
	cannotVerify?: string[];
	raw: string;
}

export interface IssueCounts {
	critical: number;
	important: number;
	minor: number;
	total: number;
}

export interface ReviewTaskContext {
	id: string;
	title: string;
	status: string;
	description?: string;
	spec?: string;
	plan?: string;
	acceptanceCriteria: Array<{ index?: number; text: string; checked: boolean }>;
	notes?: string | null;
}

export interface DiffFileStat {
	path: string;
	additions: number;
	deletions: number;
}

export interface RangeDiff {
	files: DiffFileStat[];
	/** 完整 patch；只写进 diff 文件，绝不进 package 正文。 */
	patch: string;
}

export interface ReviewPaths {
	dir: string;
	packageFile: string;
	reportFile: string;
	diffFile: string;
	logFile: string;
}

// ---------------------------------------------------------------- 路径与 id 安全

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA_PATTERN = /^[0-9a-fA-F]{7,40}$/;

/**
 * task id 是路径的一段，必须先挡住穿越。只允许字母数字开头的 `[A-Za-z0-9._-]`，
 * 并显式禁止 `.` / `..` 段（正则本身允许点，但 `..` 是目录分隔语义）。
 */
export function assertSafeTaskId(task: string): string {
	const trimmed = (task ?? "").trim();
	if (trimmed.length === 0) throw new ReviewGateError("invalid_task_id", "task id must be a non-empty string");
	if (trimmed === "." || trimmed === ".." || trimmed.includes("..")) {
		throw new ReviewGateError("invalid_task_id", `task id "${trimmed}" must not contain dot segments`, { task: trimmed });
	}
	if (!TASK_ID_PATTERN.test(trimmed) || trimmed.includes(sep) || trimmed.includes("/")) {
		throw new ReviewGateError(
			"invalid_task_id",
			`task id "${trimmed}" is not a safe path segment (allowed: [A-Za-z0-9._-], no separators)`,
			{ task: trimmed },
		);
	}
	return trimmed;
}

/** SDD 相对目录（写进 Notes / package 的相对路径用 `/`，与 git 路径口径一致）。 */
export function sddRelativeDir(task: string): string {
	return `.backlog-workflow/sdd/${assertSafeTaskId(task)}`;
}

/** 目标仓库里本任务的全部 SDD 产物路径（绝对路径）。 */
export function reviewPaths(root: string, task: string): ReviewPaths {
	const dir = resolve(root, sddRelativeDir(task));
	return {
		dir,
		packageFile: join(dir, "review-package.md"),
		reportFile: join(dir, "report.md"),
		diffFile: join(dir, "diff.txt"),
		logFile: join(dir, "verify.log"),
	};
}

/** 路径必须落在本任务的 SDD 目录内；否则抛 `path_escape`（不做静默回退）。 */
export function assertSddPath(root: string, task: string, candidate: string): string {
	const dir = reviewPaths(root, task).dir;
	const resolved = resolve(candidate);
	const rel = relative(dir, resolved);
	if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) {
		throw new ReviewGateError("path_escape", `path ${resolved} is outside the SDD dir ${dir}`, {
			candidate: resolved,
			dir,
		});
	}
	return resolved;
}

/**
 * reviewer 唯一可写的文件：`<sdd>/<task>/report.md`。
 * 这是权限契约的可执行版本，供提示词、工具门禁与测试共用。
 */
export function isReviewerWritablePath(root: string, task: string, candidate: string): boolean {
	const reportFile = reviewPaths(root, task).reportFile;
	return resolve(candidate) === reportFile;
}

// ---------------------------------------------------------------- 报告解析

/** 字符串形式的 verdict（✅/❌/⚠️ 或其等价词）。无法识别时返回 undefined。 */
export function parseVerdictValue(raw: string): ReviewVerdict | undefined {
	const text = (raw ?? "").trim();
	if (text.length === 0) return undefined;
	if (text.includes("✅")) return "compliant";
	if (text.includes("❌")) return "issues";
	if (text.includes("⚠")) return "cannot_verify";
	const token = text
		.toLowerCase()
		.replace(/[\s-]+/g, "_")
		.replace(/[^a-z_]/g, "");
	if (token.length === 0) return undefined;
	if (token.startsWith("cannot_verify") || token.startsWith("unverified") || token.startsWith("unable_to_verify")) {
		return "cannot_verify";
	}
	if (token === "unknown") return "cannot_verify";
	if (token.startsWith("not_compliant") || token.startsWith("non_compliant")) return "issues";
	if (token.startsWith("issue") || token.startsWith("fail") || token.startsWith("changes_requested") || token.startsWith("needs_changes")) {
		return "issues";
	}
	if (token === "compliant" || token === "spec_compliant" || token === "pass" || token === "ok" || token === "passing") {
		return "compliant";
	}
	return undefined;
}

const VERDICT_CONTRACT = "expected ✅ compliant | ❌ issues | ⚠️ cannot verify (or compliant|issues|cannot_verify)";

function fieldValue(raw: string, field: "task" | "base" | "head" | "spec" | "quality"): string | undefined {
	const match = new RegExp(`^\\s*${field}\\s*[:：]\\s*(\\S.*?)\\s*$`, "im").exec(raw);
	return match ? match[1].trim() : undefined;
}

export interface ReviewPackageMeta {
	task?: string;
	base?: string;
	head?: string;
}

/** 读 package / report 顶部的机器可读元数据（第一处出现生效）。 */
export function parseReviewMetadata(raw: string): ReviewPackageMeta {
	const meta: ReviewPackageMeta = {};
	const task = fieldValue(raw, "task");
	const base = fieldValue(raw, "base");
	const head = fieldValue(raw, "head");
	if (task) meta.task = task.split(/\s+/)[0];
	if (base) meta.base = base.split(/\s+/)[0];
	if (head) meta.head = head.split(/\s+/)[0];
	return meta;
}

function parseIssueLine(severity: ReviewSeverity, body: string): ReviewIssue {
	const locationMatch = /(?:^|[\s`（(])([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d+)(?:-\d+)?/.exec(body);
	const location = locationMatch ? `${locationMatch[1]}:${locationMatch[2]}` : "";
	const [head, ...tail] = body.split("|").map((part) => part.trim());
	let title = head.replace(/`/g, "");
	if (locationMatch) title = title.replace(locationMatch[0], "");
	title = title.replace(/^[-–—:：\s]+/, "").replace(/\s+/g, " ").trim();
	const issue: ReviewIssue = { severity, location, title };
	for (const part of tail) {
		if (/^trigger\s*[:：]/i.test(part)) issue.trigger = part.replace(/^trigger\s*[:：]\s*/i, "").trim();
		else if (/^suggestion\s*[:：]/i.test(part)) issue.suggestion = part.replace(/^suggestion\s*[:：]\s*/i, "").trim();
	}
	if (/plan[- ]mandated/i.test(body)) issue.planMandated = true;
	return issue;
}

function parseSections(raw: string): { issues: ReviewIssue[]; strengths: string[]; checked: string[]; cannotVerify: string[] } {
	const issues: ReviewIssue[] = [];
	const strengths: string[] = [];
	const checked: string[] = [];
	const cannotVerify: string[] = [];
	let section: "none" | "issues" | "strengths" | "checked" | "cannotVerify" = "none";
	let severity: ReviewSeverity | undefined;
	for (const rawLine of raw.split(/\r?\n/)) {
		const line = rawLine.trim();
		const heading = /^#{1,6}\s*(.+)$/.exec(line);
		if (heading) {
			const title = heading[1].trim().toLowerCase();
			if (/^critical\b/.test(title)) severity = "critical";
			else if (/^important\b/.test(title)) severity = "important";
			else if (/^minor\b/.test(title)) severity = "minor";
			else severity = undefined;
			if (/^(critical|important|minor)\b/.test(title) || /^issues?\b/.test(title)) section = "issues";
			else if (/^strengths?\b/.test(title)) section = "strengths";
			else if (/^checked\b/.test(title) || title.includes("high-risk")) section = "checked";
			else if (/^cannot\s+verify\b/.test(title) || title.includes("cannot_verify")) section = "cannotVerify";
			else section = "none";
			continue;
		}
		const bullet = /^[-*]\s+(.*)$/.exec(line);
		// Accept the compact form `- Critical: file:line — ...` even when the
		// report has no `## Issues` heading. This is useful for a harness that
		// emits one-line findings while preserving the same machine-readable shape.
		if (!bullet) {
			if (section === "issues" && severity && line.length > 0 && !line.startsWith("#")) {
				issues.push(parseIssueLine(severity, line));
			}
			continue;
		}
		const content = bullet[1].trim();
		const inlineHeading = /^#{1,6}\s*(critical|important|minor)\b/i.exec(content);
		if (inlineHeading) {
			severity = inlineHeading[1].toLowerCase() as ReviewSeverity;
			section = "issues";
			const remainder = content.slice(inlineHeading[0].length).trim();
			if (remainder) issues.push(parseIssueLine(severity, remainder));
			continue;
		}
		const inline = /^(critical|important|minor)\s*[:：]\s*(.*)$/i.exec(content);
		if (inline) {
			const inlineSeverity = inline[1].toLowerCase() as ReviewSeverity;
			issues.push(parseIssueLine(inlineSeverity, inline[2]));
			continue;
		}
		if (section === "strengths") {
			strengths.push(content);
			continue;
		}
		if (section === "checked") {
			checked.push(content);
			continue;
		}
		if (section === "cannotVerify") {
			cannotVerify.push(content);
			continue;
		}
		if (section !== "issues") continue;
		const issueSeverity = severity;
		if (!issueSeverity) continue;
		issues.push(parseIssueLine(issueSeverity, inline ? inline[2] : content));
	}
	return { issues, strengths, checked, cannotVerify };
}

export type ParsedReport = { ok: true; report: ReviewReport } | { ok: false; reason: string };

/**
 * 解析 reviewer 报告。缺任一 verdict 或元数据都算 invalid——「什么都没说」绝不能
 * 被当成通过（这正是 TDD 门禁留下的盲区）。
 */
export function parseReviewReport(raw: string): ParsedReport {
	const text = raw ?? "";
	const spec = parseVerdictValue(fieldValue(text, "spec") ?? "");
	const quality = parseVerdictValue(fieldValue(text, "quality") ?? "");
	const missing: string[] = [];
	if (!fieldValue(text, "spec")) missing.push("spec");
	else if (!spec) missing.push(`spec (${VERDICT_CONTRACT})`);
	if (!fieldValue(text, "quality")) missing.push("quality");
	else if (!quality) missing.push(`quality (${VERDICT_CONTRACT})`);
	if (spec === undefined || quality === undefined) {
		return { ok: false, reason: `report is missing a readable verdict: ${missing.join(", ")}` };
	}
	const meta = parseReviewMetadata(text);
	const missingMeta = (["task", "base", "head"] as const).filter((field) => !meta[field]);
	if (missingMeta.length > 0) {
		return { ok: false, reason: `report is missing ${missingMeta.join(", ")} metadata (copy the package header verbatim)` };
	}
	const { issues, strengths, checked, cannotVerify } = parseSections(text);
	return {
		ok: true,
		report: {
			task: meta.task,
			baseSha: meta.base,
			headSha: meta.head,
			spec,
			quality,
			issues,
			strengths,
			checked,
			cannotVerify,
			raw: text,
		},
	};
}

export function countIssues(issues: readonly ReviewIssue[]): IssueCounts {
	const counts: IssueCounts = { critical: 0, important: 0, minor: 0, total: issues.length };
	for (const issue of issues) counts[issue.severity]++;
	return counts;
}

/** sha 比较：允许短 sha 前缀，但至少要 7 位，避免 `a` 匹配一切。 */
export function sameSha(left: string, right: string): boolean {
	const a = (left ?? "").trim().toLowerCase();
	const b = (right ?? "").trim().toLowerCase();
	if (a.length === 0 || b.length === 0) return false;
	if (a === b) return true;
	const min = Math.min(a.length, b.length);
	if (min < 7) return false;
	return a.slice(0, min) === b.slice(0, min);
}

// ---------------------------------------------------------------- 判定

export type ReviewDecision =
	| { ok: true; counts: IssueCounts; minor: ReviewIssue[]; notices: string[] }
	| { ok: false; kind: ReviewRejectKind; message: string; details: Record<string, unknown> };

export interface ReviewExpectation {
	task: string;
	baseSha: string;
	headSha: string;
}

/**
 * 门禁判定（纯函数）：
 *   1. task / BASE / HEAD 必须与被审范围一致
 *   2. spec 必须 compliant（issues / cannot_verify 都拒绝）
 *   3. quality 不能是 cannot_verify；quality=issues 必须真的列出问题
 *   4. Critical / Important 阻断；Minor 只记录
 */
export function decideReview(report: ReviewReport, expect: ReviewExpectation): ReviewDecision {
	if ((report.task ?? "") !== expect.task) {
		return {
			ok: false,
			kind: "range_mismatch",
			message: `report is for task "${report.task ?? "?"}", not "${expect.task}"`,
			details: { expected: { task: expect.task, base: expect.baseSha, head: expect.headSha }, report: { task: report.task, base: report.baseSha, head: report.headSha } },
		};
	}
	if (!report.baseSha || !sameSha(report.baseSha, expect.baseSha)) {
		return {
			ok: false,
			kind: "range_mismatch",
			message: `report BASE ${report.baseSha ?? "(missing)"} does not match the audited BASE ${expect.baseSha}`,
			details: { field: "base", expected: expect.baseSha, actual: report.baseSha ?? null },
		};
	}
	if (!report.headSha || !sameSha(report.headSha, expect.headSha)) {
		return {
			ok: false,
			kind: "range_mismatch",
			message: `report HEAD ${report.headSha ?? "(missing)"} does not match the audited HEAD ${expect.headSha}`,
			details: { field: "head", expected: expect.headSha, actual: report.headSha ?? null },
		};
	}
	if (report.spec !== "compliant") {
		const unverified = report.spec === "cannot_verify";
		return {
			ok: false,
			kind: unverified ? "spec_unverified" : "spec_not_compliant",
			message: unverified
				? "spec compliance is cannot_verify: the reviewer could not confirm the diff does what the task asks, so AC must not be checked"
				: "spec compliance failed: the reviewer found the diff does not match the task Spec",
			details: { spec: report.spec },
		};
	}
	if (report.quality === "cannot_verify") {
		return {
			ok: false,
			kind: "quality_unverified",
			message: "code quality is cannot_verify: the reviewer could not verify the code, so this is not a clean review",
			details: { quality: report.quality },
		};
	}
	const counts = countIssues(report.issues);
	if (report.quality === "issues" && counts.total === 0) {
		return {
			ok: false,
			kind: "report_invalid",
			message: "quality verdict is ❌ issues but no issue is listed; a verdict without evidence is not a review",
			details: { quality: report.quality },
		};
	}
	if (counts.critical > 0 || counts.important > 0) {
		const blocking = report.issues
			.filter((issue) => issue.severity !== "minor")
			.slice(0, 5)
			.map((issue) => `${issue.severity} ${issue.location || "(no location)"} ${issue.title}`.trim());
		return {
			ok: false,
			kind: "blocking_issues",
			message:
				`review has ${counts.critical} critical and ${counts.important} important issue(s); fix them and re-review ` +
				`(blocking: ${blocking.join("; ")})`,
			details: { counts, blocking },
		};
	}
	const notices: string[] = [];
	if (counts.minor > 0) notices.push(`${counts.minor} minor issue(s) recorded but not blocking`);
	if (report.checked.length === 0) {
		notices.push("report lists no checked high-risk points; the reviewer may not have probed the risky paths (recorded, not blocking)");
	}
	return { ok: true, counts, minor: report.issues.filter((issue) => issue.severity === "minor"), notices };
}

// ---------------------------------------------------------------- package 渲染

export interface ReviewPackageInput {
	task: ReviewTaskContext;
	baseSha: string;
	headSha: string;
	generatedAt: string;
	workspace: string;
	constraints: readonly string[];
	files: readonly DiffFileStat[];
	tdd: readonly TddEntry[];
	/** 相对仓库根的路径（写进 package 的指针）。 */
	paths: { packagePath: string; reportPath: string; diffPath: string };
}

function oneLine(value: string): string {
	return value.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * 渲染 review package。刻意**不含** patch 正文：package 是入口与指针，主 session
 * 读完它不会顺带把整段 diff 带进上下文。
 */
export function renderReviewPackage(input: ReviewPackageInput): string {
	const { task, files, tdd } = input;
	const additions = files.reduce((sum, file) => sum + file.additions, 0);
	const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
	const checkedCount = task.acceptanceCriteria.filter((ac) => ac.checked).length;
	const lines: string[] = [];

	lines.push(`# Review package — ${task.id}`, "");
	lines.push(`task: ${task.id}`);
	lines.push(`base: ${input.baseSha}`);
	lines.push(`head: ${input.headSha}`);
	lines.push(`BASE_SHA: ${input.baseSha}`);
	lines.push(`HEAD_SHA: ${input.headSha}`);
	lines.push(`generated: ${input.generatedAt}`);
	lines.push(`workspace: ${input.workspace}`);
	lines.push(`package: ${input.paths.packagePath}`);
	lines.push("");
	lines.push("这个文件是 review 入口，不是 diff 全文：完整 patch 在下面的指针里，用你自己的");
	lines.push("read/grep 按需读取。不要把 diff 整段复制进报告，也不要要求主 session 把 diff 贴进上下文。");
	lines.push("");
	lines.push("## 任务上下文", "");
	lines.push(`- 标题：${oneLine(task.title) || "(无标题)"}`);
	lines.push(`- 状态：${task.status || "(未知)"}`);
	if (task.description) lines.push(`- 描述：${oneLine(task.description)}`);
	lines.push("");
	lines.push("### Spec", "", task.spec?.trim() || "(Backlog task 没有 spec 字段)", "");
	lines.push("### Plan", "", task.plan?.trim() || "(Backlog task 没有 implementationPlan 字段)", "");
	lines.push(`### Acceptance criteria（${checkedCount}/${task.acceptanceCriteria.length} 已勾）`, "");
	if (task.acceptanceCriteria.length === 0) lines.push("(没有 AC 条目)");
	for (const [index, ac] of task.acceptanceCriteria.entries()) {
		const label = ac.index ?? index + 1;
		lines.push(`- [${ac.checked ? "x" : " "}] AC${label}：${oneLine(ac.text)}`);
	}
	lines.push("", "## 全局约束", "");
	if (input.constraints.length === 0) lines.push("- (没有额外约束)");
	for (const constraint of input.constraints) {
		const text = oneLine(constraint);
		if (text.length === 0) continue;
		lines.push(/^[-*>]/.test(text) ? text : `- ${text}`);
	}
	lines.push("");
	lines.push(
		`## Diff ${input.baseSha.slice(0, 12)}..${input.headSha.slice(0, 12)}（${files.length} 个文件，+${additions} / −${deletions}）`,
		"",
	);
	lines.push("| 文件 | + | − |", "| --- | --- | --- |");
	for (const file of files) lines.push(`| \`${file.path}\` | ${file.additions} | ${file.deletions} |`);
	lines.push("", `完整 patch 指针：\`${input.paths.diffPath}\`（用 read/grep 按需读取，不要内联）`, "");
	lines.push("## TDD 证据指针（来自目标 task 的 Implementation Notes）", "");
	if (tdd.length === 0) {
		lines.push("- no tdd-red/tdd-green recorded for this task");
	} else {
		for (const entry of tdd) {
			const fail = entry.fail ? ` | fail=${entry.fail}` : "";
			const log = entry.log ? ` | log=\`${entry.log}\`` : "";
			lines.push(`- ${entry.action} sel=${entry.sel} exit=${entry.exit} at ${entry.ts}${fail}${log}`);
		}
	}
	lines.push("", "日志是完整输出，按需读取；它们不在本 package 内。", "");
	lines.push("## 你要做的", "");
	lines.push("1. 读 diff 文件与它指向的源码，不要相信 implementer 的自我报告。");
	lines.push("2. 给两个 verdict：Spec compliance（只做了要求的事？有没有少做/多做/走样？）与 code quality。");
	lines.push("3. 检查那条红测试是否真的验证需求：断言是否针对行为、能否在实现坏掉时失败。");
	lines.push("4. 问题按 Critical / Important / Minor 分级，每条给 `file:line`、触发条件、建议方向。");
	lines.push("");
	lines.push("## 报告格式（机器可读，必须逐字保留这些键）", "");
	lines.push("```");
	lines.push(`task: ${task.id}`);
	lines.push(`base: ${input.baseSha}`);
	lines.push(`head: ${input.headSha}`);
	lines.push("## Verdict");
	lines.push("spec: ✅ compliant | ❌ issues | ⚠️ cannot verify");
	lines.push("quality: ✅ compliant | ❌ issues | ⚠️ cannot verify");
	lines.push("## Issues");
	lines.push("### Critical");
	lines.push("- `file:line` — 一句话 | trigger: 触发条件 | suggestion: 建议方向");
	lines.push("### Important");
	lines.push("### Minor");
	lines.push("## Checked high-risk points");
	lines.push("- 验过什么、为什么放心");
	lines.push("## Cannot verify");
	lines.push("- 无法确认的事实和所需证据（没有则写 `- none`）");
	lines.push("```");
	lines.push("");
	lines.push(`报告写到：\`${input.paths.reportPath}\`（同目录的 report.md，别处不写）。`);
	lines.push("若你的 harness 不允许写文件（例如 read-only sandbox），把完整报告作为最后一段输出，由主 session 落盘。");
	lines.push("");
	lines.push("## 边界", "");
	lines.push("- 只读源码与 Backlog；不得修改 source、Backlog markdown 或 AC。");
	lines.push("- 除 report.md 外不写任何文件；不改父任务、不勾 AC。");
	lines.push("- 证据不足就写 cannot_verify，不要用 ✅ 代替没查过的东西。");
	return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------- 门禁本体

export interface ReviewDeps {
	now(): Date;
	taskView(root: string, task: string): ReviewTaskContext | null;
	resolveCommit(root: string, sha: string): string | null;
	isAncestor(root: string, base: string, head: string): boolean;
	diffRange(root: string, base: string, head: string): RangeDiff;
	readNotes(root: string, task: string): string | null;
	appendNotes(root: string, task: string, line: string): void;
	readFile(path: string): string | null;
	/** 实现需自建父目录。 */
	writeFile(path: string, content: string): void;
	exists(path: string): boolean;
	/** 实现需自建父目录。 */
	appendFile(path: string, content: string): void;
	defaultConstraints(root: string): string[];
}

export interface ReviewPrepareRequest {
	task: string;
	baseSha: string;
	headSha: string;
	cwd: string;
	/** 覆盖全局约束（默认读仓库 AGENTS.md）。 */
	constraints?: string[];
}

export interface ReviewRecordRequest {
	task: string;
	cwd: string;
	report: string;
}

export interface ReviewVerifyRequest {
	task: string;
	baseSha: string;
	headSha: string;
	cwd: string;
}

export interface ReviewFailure {
	kind: ReviewRejectKind;
	message: string;
	details: Record<string, unknown>;
}

export interface ReviewPrepareOutcome {
	ok: boolean;
	task: string;
	baseSha: string;
	headSha: string;
	packagePath?: string;
	reportPath?: string;
	diffPath?: string;
	files?: DiffFileStat[];
	tddEntries?: number;
	failure?: ReviewFailure;
}

export interface ReviewRecordOutcome {
	ok: boolean;
	task: string;
	reportPath?: string;
	reportChars?: number;
	failure?: ReviewFailure;
}

export interface ReviewVerifyOutcome {
	ok: boolean;
	task: string;
	baseSha: string;
	headSha: string;
	spec?: ReviewVerdict;
	quality?: ReviewVerdict;
	issues?: IssueCounts;
	minor?: ReviewIssue[];
	packagePath?: string;
	reportPath?: string;
	logPath?: string;
	entry?: string;
	notices?: string[];
	failure?: ReviewFailure;
}

function normalizeSha(name: "BASE" | "HEAD", value: string): string {
	const trimmed = (value ?? "").trim();
	if (!SHA_PATTERN.test(trimmed)) {
		throw new ReviewGateError("invalid_sha", `${name} must be a 7–40 char hex commit sha, got "${trimmed}"`, { name, value: trimmed });
	}
	return trimmed.toLowerCase();
}

export function createReviewGate(deps: ReviewDeps) {
	const fail = (task: string, baseSha: string, headSha: string, kind: ReviewRejectKind, message: string, details: Record<string, unknown> = {}) => ({
		ok: false as const,
		task,
		baseSha,
		headSha,
		failure: { kind, message, details },
	});

	const resolveRange = (request: { cwd: string; baseSha: string; headSha: string }) => {
		const root = resolve(request.cwd);
		const base = normalizeSha("BASE", request.baseSha);
		const head = normalizeSha("HEAD", request.headSha);
		const baseCommit = deps.resolveCommit(root, base);
		const headCommit = deps.resolveCommit(root, head);
		return { root, base, head, baseCommit, headCommit };
	};

	const prepare = (request: ReviewPrepareRequest): ReviewPrepareOutcome => {
		const task = assertSafeTaskId(request.task);
		const { root, base, head, baseCommit, headCommit } = resolveRange(request);
		if (!baseCommit) return fail(task, base, head, "invalid_sha", `base ${base} is not a commit in ${root}`, { name: "base", value: base });
		if (!headCommit) return fail(task, base, head, "invalid_sha", `head ${head} is not a commit in ${root}`, { name: "head", value: head });
		if (!deps.isAncestor(root, baseCommit, headCommit)) {
			return fail(task, baseCommit, headCommit, "range_not_ancestor", `BASE ${baseCommit.slice(0, 12)} is not an ancestor of HEAD ${headCommit.slice(0, 12)}; review an actual branch range`, {
				base: baseCommit,
				head: headCommit,
			});
		}
		const context = deps.taskView(root, task);
		if (!context) return fail(task, baseCommit, headCommit, "task_not_found", `Backlog task ${task} was not found in ${root}`, { task });
		const diff = deps.diffRange(root, baseCommit, headCommit);
		if (diff.files.length === 0) {
			return fail(task, baseCommit, headCommit, "empty_range", `BASE..HEAD has no changed files (${baseCommit.slice(0, 12)}..${headCommit.slice(0, 12)})`, {
				base: baseCommit,
				head: headCommit,
			});
		}
		const paths = reviewPaths(root, task);
		const constraints = request.constraints ?? deps.defaultConstraints(root);
		const tdd = parseTddEntries(deps.readNotes(root, task) ?? context.notes ?? null);
		const relativePaths = {
			packagePath: `${sddRelativeDir(task)}/review-package.md`,
			reportPath: `${sddRelativeDir(task)}/report.md`,
			diffPath: `${sddRelativeDir(task)}/diff.txt`,
		};
		const content = renderReviewPackage({
			task: context,
			baseSha: baseCommit,
			headSha: headCommit,
			generatedAt: deps.now().toISOString(),
			workspace: root,
			constraints,
			files: diff.files,
			tdd,
			paths: relativePaths,
		});
		assertSddPath(root, task, paths.diffFile);
		assertSddPath(root, task, paths.packageFile);
		deps.writeFile(paths.diffFile, diff.patch);
		deps.writeFile(paths.packageFile, content);
		return {
			ok: true,
			task,
			baseSha: baseCommit,
			headSha: headCommit,
			packagePath: relativePaths.packagePath,
			reportPath: relativePaths.reportPath,
			diffPath: relativePaths.diffPath,
			files: diff.files,
			tddEntries: tdd.length,
		};
	};

	/**
	 * 报告的落盘入口。路径从 task id 推导，调用方给不了路径——所以「只写 SDD 目录
	 * 下的 report.md」是结构保证，不是靠调用方自觉。
	 */
	const record = (request: ReviewRecordRequest): ReviewRecordOutcome => {
		const task = assertSafeTaskId(request.task);
		const root = resolve(request.cwd);
		const paths = reviewPaths(root, task);
		if (!deps.exists(paths.packageFile)) {
			return {
				ok: false,
				task,
				failure: { kind: "package_missing", message: `no review package at ${paths.packageFile}; run prepare before recording a report`, details: { package: paths.packageFile } },
			};
		}
		const report = (request.report ?? "").trim();
		if (report.length === 0) {
			return { ok: false, task, failure: { kind: "report_invalid", message: "report text is empty", details: {} } };
		}
		const target = assertSddPath(root, task, paths.reportFile);
		// Preserve the reviewer's report byte-for-byte. The gate parses it later;
		// adding a newline here makes the record tool an unexpected formatter and
		// complicates report provenance checks.
		deps.writeFile(target, request.report);
		return { ok: true, task, reportPath: `${sddRelativeDir(task)}/report.md`, reportChars: report.length };
	};

	const verify = (request: ReviewVerifyRequest): ReviewVerifyOutcome => {
		const task = assertSafeTaskId(request.task);
		const { root, base, head, baseCommit, headCommit } = resolveRange(request);
		if (!baseCommit) return fail(task, base, head, "invalid_sha", `base ${base} is not a commit in ${root}`, { name: "base", value: base });
		if (!headCommit) return fail(task, base, head, "invalid_sha", `head ${head} is not a commit in ${root}`, { name: "head", value: head });
		if (!deps.isAncestor(root, baseCommit, headCommit)) {
			return fail(task, baseCommit, headCommit, "range_not_ancestor", `BASE ${baseCommit.slice(0, 12)} is not an ancestor of HEAD ${headCommit.slice(0, 12)}`, {
				base: baseCommit,
				head: headCommit,
			});
		}
		const paths = reviewPaths(root, task);
		const packageRaw = deps.exists(paths.packageFile) ? deps.readFile(paths.packageFile) : null;
		if (!packageRaw) {
			return fail(task, baseCommit, headCommit, "package_missing", `no review package at ${paths.packageFile}; run prepare first`, {
				package: paths.packageFile,
			});
		}
		const meta = parseReviewMetadata(packageRaw);
		if (meta.task !== task || !meta.base || !sameSha(meta.base, baseCommit) || !meta.head || !sameSha(meta.head, headCommit)) {
			return fail(
				task,
				baseCommit,
				headCommit,
				"range_mismatch",
				`the package describes task=${meta.task ?? "?"} ${meta.base ?? "?"}..${meta.head ?? "?"}, not ${task} ${baseCommit.slice(0, 12)}..${headCommit.slice(0, 12)}; re-run prepare for this range`,
				{ expected: { task, base: baseCommit, head: headCommit }, package: meta },
			);
		}
		const reportRaw = deps.exists(paths.reportFile) ? deps.readFile(paths.reportFile) : null;
		if (!reportRaw) {
			return fail(task, baseCommit, headCommit, "report_missing", `no report at ${paths.reportFile}; the reviewer must write it (or the main session must record it)`, {
				report: paths.reportFile,
			});
		}
		const parsed = parseReviewReport(reportRaw);
		if (!parsed.ok) {
			const message = `report is not a usable review: ${parsed.reason}`;
			deps.appendFile(paths.logFile, `\n### ${deps.now().toISOString()} review-verify REJECTED (report_invalid)\n${message}\n`);
			return fail(task, baseCommit, headCommit, "report_invalid", message, { report: paths.reportFile });
		}
		const decision = decideReview(parsed.report, { task, baseSha: baseCommit, headSha: headCommit });
		if (!decision.ok) {
			deps.appendFile(paths.logFile, `\n### ${deps.now().toISOString()} review-verify REJECTED (${decision.kind})\n${decision.message}\n`);
			return fail(task, baseCommit, headCommit, decision.kind, decision.message, decision.details);
		}

		const entry = formatReviewEntry({
			ts: deps.now().toISOString(),
			task,
			spec: parsed.report.spec,
			quality: parsed.report.quality,
			base: baseCommit,
			head: headCommit,
			critical: decision.counts.critical,
			important: decision.counts.important,
			minor: decision.counts.minor,
			package: `${sddRelativeDir(task)}/review-package.md`,
			report: `${sddRelativeDir(task)}/report.md`,
		});
		deps.appendNotes(root, task, entry);
		deps.appendFile(
			paths.logFile,
			`\n### ${deps.now().toISOString()} review-verify OK\nspec=${parsed.report.spec} quality=${parsed.report.quality} issues=${decision.counts.critical}/${decision.counts.important}/${decision.counts.minor}\n`,
		);
		return {
			ok: true,
			task,
			baseSha: baseCommit,
			headSha: headCommit,
			spec: parsed.report.spec,
			quality: parsed.report.quality,
			issues: decision.counts,
			minor: decision.minor,
			packagePath: `${sddRelativeDir(task)}/review-package.md`,
			reportPath: `${sddRelativeDir(task)}/report.md`,
			logPath: `${sddRelativeDir(task)}/verify.log`,
			entry,
			...(decision.notices.length > 0 ? { notices: decision.notices } : {}),
		};
	};

	return { prepare, record, verify };
}

export type ReviewGate = ReturnType<typeof createReviewGate>;

// ---------------------------------------------------------------- Notes 条目

const ENTRY_HEAD = /^[-*]?\s*(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(review-verify)\s*\|(.*)$/;

export interface ReviewEntryInput {
	ts: string;
	task: string;
	spec: ReviewVerdict;
	quality: ReviewVerdict;
	base: string;
	head: string;
	critical: number;
	important: number;
	minor: number;
	package: string;
	report: string;
}

export interface ReviewEntry {
	ts: string;
	task: string;
	spec: ReviewVerdict;
	quality: ReviewVerdict;
	base: string;
	head: string;
	critical: number;
	important: number;
	minor: number;
	package: string;
	report: string;
	line: string;
}

/**
 * Notes 单行条目：
 * `- <ISO ts> review-verify | task=<id> spec=<v> quality=<v> base=<sha> head=<sha> issues=critical:N important:N minor:N | package=<rel> report=<rel>`
 */
export function formatReviewEntry(entry: ReviewEntryInput): string {
	const fields = [
		`task=${oneLine(entry.task)}`,
		`spec=${entry.spec}`,
		`quality=${entry.quality}`,
		`base=${entry.base}`,
		`head=${entry.head}`,
		`issues=critical:${entry.critical} important:${entry.important} minor:${entry.minor}`,
	].join(" ");
	return `- ${entry.ts} review-verify | ${fields} | package=${oneLine(entry.package)} report=${oneLine(entry.report)}`;
}

/** 解析 review-verify 条目；格式坏掉的行直接跳过（不模糊修复）。 */
export function parseReviewEntries(notes: string | null | undefined): ReviewEntry[] {
	if (!notes) return [];
	const entries: ReviewEntry[] = [];
	for (const raw of notes.split(/\r?\n/)) {
		const head = ENTRY_HEAD.exec(raw.trim());
		if (!head) continue;
		const [, ts, , rest] = head;
		const fields =
			/^\s*task=(\S+) spec=(compliant|issues|cannot_verify) quality=(compliant|issues|cannot_verify) base=(\S+) head=(\S+) issues=critical:(\d+) important:(\d+) minor:(\d+)/.exec(
				rest,
			);
		if (!fields) continue;
		const tail = / \| package=(\S+) report=(\S+)\s*$/.exec(rest);
		if (!tail) continue;
		entries.push({
			ts,
			task: fields[1],
			spec: fields[2] as ReviewVerdict,
			quality: fields[3] as ReviewVerdict,
			base: fields[4],
			head: fields[5],
			critical: Number.parseInt(fields[6], 10),
			important: Number.parseInt(fields[7], 10),
			minor: Number.parseInt(fields[8], 10),
			package: tail[1],
			report: tail[2],
			line: raw.trim(),
		});
	}
	return entries;
}

// ---------------------------------------------------------------- 真实现

function parseJson(text: string): any {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function stderrOf(probe: { error?: Error; stderr?: string | null }): string {
	return probe.error?.message ?? probe.stderr?.trim() ?? "unknown error";
}

function gitText(root: string, args: string[]): string {
	const probe = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
	if (probe.error || probe.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed in ${root}: ${stderrOf(probe)}`);
	}
	return probe.stdout ?? "";
}

function gitOk(root: string, args: string[]): { status: number | null; stdout: string; stderr: string; error?: Error } {
	const probe = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
	return { status: probe.status, stdout: probe.stdout ?? "", stderr: probe.stderr ?? "", ...(probe.error ? { error: probe.error } : {}) };
}

/** 从 `backlog task view --json` 取 review 需要的任务上下文。 */
export function readTaskContext(root: string, task: string): ReviewTaskContext | null {
	assertBacklogVersion(root);
	const probe = spawnSync("backlog", ["task", "view", task, "--json"], { cwd: root, encoding: "utf8" });
	if (probe.status !== 0) return null;
	const view = parseJson(probe.stdout ?? "")?.task;
	if (!view || typeof view !== "object") return null;
	const criteria = Array.isArray(view.acceptanceCriteria)
		? view.acceptanceCriteria.map((ac: any, index: number) => ({
				index: typeof ac?.index === "number" ? ac.index : index + 1,
				text: typeof ac === "string" ? ac : String(ac?.text ?? ""),
				checked: ac?.checked === true,
			}))
		: [];
	return {
		id: String(view.id ?? task),
		title: String(view.title ?? ""),
		status: String(view.status ?? ""),
		...(typeof view.description === "string" ? { description: view.description } : {}),
		...(typeof view.spec === "string" ? { spec: view.spec } : {}),
		...(typeof view.implementationPlan === "string" ? { plan: view.implementationPlan } : {}),
		acceptanceCriteria: criteria,
		notes: typeof view.implementationNotes === "string" ? view.implementationNotes : null,
	};
}

function writeFileWithDirs(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf8");
}

/** 默认依赖：真读 backlog / git / 文件系统。 */
export const defaultReviewDeps: ReviewDeps = {
	now: () => new Date(),
	taskView: readTaskContext,
	resolveCommit: (root, sha) => {
		const probe = gitOk(root, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
		if (probe.error || probe.status !== 0) return null;
		const resolved = probe.stdout.trim();
		return resolved.length > 0 ? resolved : null;
	},
	isAncestor: (root, base, head) => {
		const probe = gitOk(root, ["merge-base", "--is-ancestor", base, head]);
		if (probe.error) throw new Error(`git merge-base failed in ${root}: ${probe.error.message}`);
		if (probe.status === 0) return true;
		if (probe.status === 1) return false;
		throw new Error(`git merge-base --is-ancestor failed in ${root}: ${probe.stderr.trim() || `exit ${probe.status}`}`);
	},
	diffRange: (root, base, head) => {
		const range = `${base}..${head}`;
		const files: DiffFileStat[] = [];
		for (const line of gitText(root, ["diff", "--numstat", range]).split(/\r?\n/)) {
			const trimmed = line.trim();
			if (trimmed.length === 0) continue;
			const [additions, deletions, ...rest] = trimmed.split("\t");
			if (rest.length === 0) continue;
			files.push({
				path: rest.join("\t"),
				additions: additions === "-" ? 0 : Number.parseInt(additions, 10) || 0,
				deletions: deletions === "-" ? 0 : Number.parseInt(deletions, 10) || 0,
			});
		}
		return { files, patch: gitText(root, ["diff", range]) };
	},
	readNotes: (root, task) => {
		const context = readTaskContext(root, task);
		return context?.notes ?? null;
	},
	appendNotes: (root, task, line) => {
		assertBacklogVersion(root);
		const probe = spawnSync("backlog", ["task", "edit", task, "--append-notes", line], { cwd: root, encoding: "utf8" });
		if (probe.error || probe.status !== 0) {
			throw new Error(`backlog task edit ${task} --append-notes failed in ${root}: ${stderrOf(probe)}`);
		}
	},
	readFile: (path) => (existsSync(path) ? readFileSync(path, "utf8") : null),
	writeFile: writeFileWithDirs,
	exists: (path) => existsSync(path),
	appendFile: (path, content) => {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, content, "utf8");
	},
	/**
	 * 全局约束：仓库 AGENTS.md（若存在）前 80 行。它不是任务 Spec；Spec 来自 Backlog。
	 * 没有 AGENTS.md 时明说，而不是假装没有约束。
	 */
	defaultConstraints: (root) => {
		const agents = join(root, "AGENTS.md");
		if (!existsSync(agents)) return ["未找到 AGENTS.md；以任务 Spec/Plan 与本 package 的约束为准。"];
		return readFileSync(agents, "utf8")
			.split(/\r?\n/)
			.map((line) => line.trimEnd())
			.filter((line) => line.trim().length > 0)
			.slice(0, 80);
	},
};
