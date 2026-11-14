/**
 * Backlog 内 TDD 门禁（THU-119.3 / S3）。
 *
 * 把 superpowers 的铁律「NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST」从提示词
 * 挪到机器闸门上：red / green / verify 三个动作自己跑命令、自己写目标 task 的
 * Implementation Notes、自己拒绝顺序错误的调用方。
 *
 * 三条判定口径（与 THU-119.3 Spec 一致）：
 *   1. 无同选择集更早 red 的 green → 拒绝（`selection_mismatch`）
 *   2. green 出现在同选择集 red 之前 → 拒绝（`green_before_red`），更晚的 red 不能追认
 *   3. green 之后生产代码有未记录改动 → 拒绝（`production_changed_after_green`），
 *      证据用 git 路径差集（相对 green 时刻的工作树快照），不看 mtime
 *
 * 证据只落两处：目标 task 的 Notes（单行条目，可 grep）+ `.handoff/` 下的日志指针。
 * 不建 `.tdd` 目录，不写父任务，不勾 AC——门禁只证明「顺序 + 选择集」，不证明
 * 「红得对」（断言质量由 review 切片负责）。
 *
 * 所有外部副作用都走 `TddDeps`：默认实现真起进程、真读写 backlog；测试注入假实现。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** Notes 条目里的动作标记，同时是唯一的三种动作名。 */
export type TddAction = "tdd-red" | "tdd-green" | "tdd-verify";

/** 拒绝原因。前三个是 Spec 点名要「指名是哪一种」的三条；其余是前置条件不满足。 */
export type TddRejectKind =
	| "green_before_red"
	| "selection_mismatch"
	| "production_changed_after_green"
	| "no_green"
	| "green_failed"
	| "red_passed";

export class TddGateError extends Error {
	readonly kind: TddRejectKind;
	readonly details: Record<string, unknown>;
	constructor(kind: TddRejectKind, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "TddGateError";
		this.kind = kind;
		this.details = details;
	}
}

export interface TddEntry {
	/** 条目时间戳（ISO 8601，UTC，毫秒精度）。 */
	ts: string;
	action: TddAction;
	task: string;
	role?: string;
	cmd: string;
	exit: number;
	/** 选择集指纹（sha256 前 12 位）。 */
	sel: string;
	/** 仅 red：实际观测到的失败签名。 */
	fail?: string;
	/** 日志相对路径（相对仓库根）。 */
	log?: string;
	/** 仅 green/verify：记录时刻的 HEAD（排错与降级基线）。 */
	head?: string;
	/** 仅 green/verify：记录时刻的工作树快照（`git stash create` 的对象名，干净树省略）。 */
	snap?: string;
	/** Notes 原文行（排错时给调用方看）。 */
	line: string;
}

// ---------------------------------------------------------------- 选择集指纹

/**
 * 命令规范化：只做不影响语义的收敛——去首尾空白、把连续空白折成单空格。
 * 引用符、参数顺序、过滤器大小写都不动：换顺序就是换命令，指纹本就该变。
 */
export function normalizeCommand(cmd: string): string {
	return cmd.replace(/\s+/g, " ").trim();
}

/** 选择集指纹：规范化命令的 sha256 前 12 位。同一条命令 ⇒ 同一个 sel。 */
export function selectionFingerprint(cmd: string, digest: (input: string) => string): string {
	return digest(normalizeCommand(cmd)).slice(0, 12);
}

// ---------------------------------------------------------------- 条目格式

const ENTRY_HEAD = /^[-*]?\s*(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s+(tdd-red|tdd-green|tdd-verify)\s*\|(.*)$/;

/** 单行化：Notes 条目必须是单行，否则后面无法 grep。 */
function oneLine(value: string): string {
	return value.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * 渲染一条 Notes 条目：
 * `- <ISO ts> <action> | task=<id> role=<role> cmd=<命令> exit=<码> sel=<前12> head=<sha> snap=<sha> | fail=<摘要> | log=<路径>`
 *
 * `head=` / `snap=` 是 Spec 的超集：第三口径要「相对 green 时刻的工作树状态」做路径
 * 差集，而 Notes 是耐久真相（`.handoff/` 不进 git）。缺失时 verify 降级为 skipped
 * 并在结果里说明，绝不假装检查过。
 */
export function formatEntry(entry: Omit<TddEntry, "line">): string {
	const fields = [
		`task=${oneLine(entry.task)}`,
		entry.role ? `role=${oneLine(entry.role)}` : undefined,
		`cmd=${oneLine(entry.cmd)}`,
		`exit=${entry.exit}`,
		`sel=${entry.sel}`,
		entry.head ? `head=${entry.head}` : undefined,
		entry.snap ? `snap=${entry.snap}` : undefined,
	]
		.filter((value) => value !== undefined)
		.join(" ");
	const tail: string[] = [];
	if (entry.fail) tail.push(`fail=${oneLine(entry.fail)}`);
	if (entry.log) tail.push(`log=${oneLine(entry.log)}`);
	const body = tail.length > 0 ? `${fields} | ${tail.join(" | ")}` : fields;
	return `- ${entry.ts} ${entry.action} | ${body}`;
}

/**
 * 解析 Notes 里的门禁条目。解析失败的行直接跳过（Notes 里还有大量人工笔记），
 * 但**不做模糊修复**：宁可漏判为「没有 red」，也不把格式坏掉的行当成证据。
 *
 * cmd 里允许出现 ` | `（shell 管道）：字段段按「从 `exit=<码> sel=<hex>` 往前收」的
 * 方式切分，尾部 `| fail=… | log=…` 用锚定正则单独取，不按分隔符硬 split。
 */
export function parseTddEntries(notes: string | null | undefined): TddEntry[] {
	if (!notes) return [];
	const entries: TddEntry[] = [];
	for (const raw of notes.split(/\r?\n/)) {
		const head = ENTRY_HEAD.exec(raw.trim());
		if (!head) continue;
		const [, ts, action, rest] = head;
		// `rest` 以 `|` 之后的那个空格开头，先剥掉再匹配字段段。
		const fields = /^\s*task=(\S+) (?:role=(\S+) )?cmd=(.*?) exit=(-?\d+) sel=([0-9a-f]{12})(?: head=(\S+))?(?: snap=(\S+))?/.exec(
			rest,
		);
		if (!fields) continue;
		const [, task, role, cmd, exitText, sel, headSha, snapSha] = fields;
		const entry: TddEntry = {
			ts,
			action: action as TddAction,
			task,
			...(role ? { role } : {}),
			cmd: cmd.trim(),
			exit: Number.parseInt(exitText, 10),
			sel,
			line: raw.trim(),
		};
		if (headSha) entry.head = headSha;
		if (snapSha) entry.snap = snapSha;
		const fail = / \| fail=(.*?)(?: \| log=|$)/.exec(rest);
		if (fail) entry.fail = fail[1].trim();
		const log = / \| log=(\S+)\s*$/.exec(rest);
		if (log) entry.log = log[1];
		entries.push(entry);
	}
	return entries;
}

// ---------------------------------------------------------------- 判定（纯函数）

/** 某 sel 在 [0, beforeIndex) 范围内最近的一条 red。 */
export function earlierRed(entries: readonly TddEntry[], sel: string, beforeIndex: number): TddEntry | undefined {
	for (let index = Math.min(beforeIndex, entries.length) - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.action === "tdd-red" && entry.sel === sel) return entry;
	}
	return undefined;
}

function redSummary(entries: readonly TddEntry[]): string {
	const reds = entries.filter((entry) => entry.action === "tdd-red");
	if (reds.length === 0) return "none";
	return reds.map((entry) => `${entry.sel}@${entry.ts}`).join(", ");
}

/** 判定一条新 green 能否成立：必须存在同 sel 的更早 red。 */
export function decideGreen(
	entries: readonly TddEntry[],
	sel: string,
	cmd: string,
): { ok: true; red: TddEntry } | { ok: false; error: TddGateError } {
	const red = earlierRed(entries, sel, entries.length);
	if (red) return { ok: true, red };
	return {
		ok: false,
		error: new TddGateError(
			"selection_mismatch",
			`no earlier tdd-red with sel=${sel} for \`${normalizeCommand(cmd)}\`; recorded red sels: ${redSummary(entries)}; ` +
				`run tdd_red with the same command first (a later red cannot retroactively justify this green)`,
			{ sel, cmd: normalizeCommand(cmd), reds: redSummary(entries) },
		),
	};
}

export type VerifyDecision =
	| { ok: true; red: TddEntry; green: TddEntry; productionCheck: "checked" | "skipped"; note?: string }
	| { ok: false; kind: TddRejectKind; message: string; details: Record<string, unknown> };

/**
 * verify 的判定：找最后一条 green，按三条口径依次检查。
 *
 * `changedSince(ref)` 由调用方给（真实现读 git；测试给假列表），返回相对仓库根
 * 的改动路径（已提交 + 工作树）。优先用 green 记的 `snap`（工作树快照），其次
 * `head`；两者都没有或引用失效时降级 `productionCheck: "skipped"` 并说明原因。
 */
export function decideVerify(
	entries: readonly TddEntry[],
	changedSince: (ref: string) => string[],
): VerifyDecision {
	let greenIndex = -1;
	for (let index = 0; index < entries.length; index++) if (entries[index].action === "tdd-green") greenIndex = index;
	if (greenIndex < 0) {
		return {
			ok: false,
			kind: "no_green",
			message: "no tdd-green recorded for this task; run tdd_green after the command passes",
			details: { entries: entries.length },
		};
	}
	const green = entries[greenIndex];
	const red = earlierRed(entries, green.sel, greenIndex);
	if (!red) {
		// 区分「green 早于它的 red」与「压根没有同 sel 的 red」：归因不同，处置也不同
		// （前者要改流程顺序，后者是跑错了命令）。
		let laterRedIndex = -1;
		for (let index = greenIndex + 1; index < entries.length; index++) {
			const entry = entries[index];
			if (entry.action === "tdd-red" && entry.sel === green.sel) {
				laterRedIndex = index;
				break;
			}
		}
		if (laterRedIndex >= 0) {
			return {
				ok: false,
				kind: "green_before_red",
				message:
					`green is earlier than its red: tdd-green sel=${green.sel} at ${green.ts} precedes the matching ` +
					`tdd-red at ${entries[laterRedIndex].ts}; a later red cannot retroactively justify an earlier green`,
				details: { sel: green.sel, green: green.line, red: entries[laterRedIndex].line },
			};
		}
		return {
			ok: false,
			kind: "selection_mismatch",
			message:
				`green selection set has no matching red: green sel=${green.sel} (\`${green.cmd}\`) does not appear in ` +
				`any earlier tdd-red (recorded red sels: ${redSummary(entries)})`,
			details: { sel: green.sel, green: green.line },
		};
	}
	const ref = green.snap ?? green.head;
	if (!ref) {
		return {
			ok: true,
			red,
			green,
			productionCheck: "skipped",
			note: "green recorded neither snap nor head, so post-green production edits could not be diffed",
		};
	}
	let changed: string[];
	try {
		changed = changedSince(ref);
	} catch (error) {
		return {
			ok: true,
			red,
			green,
			productionCheck: "skipped",
			note: `git ref ${ref} from the green entry is unusable (${error instanceof Error ? error.message : String(error)}), so post-green production edits could not be diffed`,
		};
	}
	const production = changed.filter(isProductionPath).sort();
	if (production.length > 0) {
		return {
			ok: false,
			kind: "production_changed_after_green",
			message:
				`production code changed after green: ${production.length} path(s) differ from ${ref} with no recorded red ` +
				`covering them — ${production.slice(0, 8).join(", ")}${production.length > 8 ? ", …" : ""}`,
			details: { ref, changed: production, green: green.line },
		};
	}
	return { ok: true, red, green, productionCheck: "checked" };
}

/**
 * 「生产代码」= 不是测试、也不属于台账/证据/脚手架的文件。
 * 台账（`backlog/`）必须在排除名单里：门禁自己写 Notes 就会改它，否则 verify
 * 会自我拒绝。证据（`.handoff/`）与脚手架同理。
 */
export function isProductionPath(filePath: string): boolean {
	if (isExcludedPath(filePath)) return false;
	return !isTestPath(filePath);
}

const EXCLUDED_PREFIXES = ["backlog/", ".handoff/", ".backlog-workflow/", ".superpowers/", "node_modules/"];

function isExcludedPath(filePath: string): boolean {
	return EXCLUDED_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

const TEST_PATH_PATTERNS: RegExp[] = [
	/(^|\/)(test|tests|__tests__|spec|specs)\//i,
	/(^|\/)[\w.-]+\.Tests?\//,
	/\.(test|spec)\.[a-z]+$/i,
	/_(test|spec)\.[a-z]+$/i,
	/Tests?\.[a-z]+$/,
];

export function isTestPath(filePath: string): boolean {
	return TEST_PATH_PATTERNS.some((pattern) => pattern.test(filePath));
}

// ---------------------------------------------------------------- 门禁本体

export interface CommandOutcome {
	exit: number;
	stdout: string;
	stderr: string;
}

export interface ChangedSet {
	/** 相对仓库根的改动路径（`git diff --name-only` 的口径）。 */
	paths: string[];
	/** 未跟踪的新文件（不参与第三口径判定，只回报给调用方看）。 */
	untracked: string[];
}

export interface TddDeps {
	now(): Date;
	digest(input: string): string;
	runCommand(cmd: string, cwd: string, timeoutMs: number): CommandOutcome;
	readNotes(root: string, task: string): string | null;
	appendNotes(root: string, task: string, line: string): void;
	head(root: string): string;
	/** 工作树快照（`git stash create`）；干净树返回 undefined。 */
	snapshot(root: string): string | undefined;
	changedSince(root: string, ref: string): ChangedSet;
	appendLog(root: string, relativePath: string, block: string): void;
	assertBacklog(root: string): void;
}

export const DEFAULT_TIMEOUT_MS = 600_000;

export interface GateRequest {
	task: string;
	/** verify 不需要命令：它审的是已写下的证据链，sel 取自 green。 */
	cmd?: string;
	cwd: string;
	role?: string;
	timeoutMs?: number;
}

export interface GateOutcome {
	ok: boolean;
	action: TddAction;
	task: string;
	sel: string;
	exit: number;
	entry?: string;
	logPath?: string;
	/** verify 特有：命中的 red/green 条目与生产代码检查状态。 */
	verified?: { red: TddEntry; green: TddEntry; productionCheck: "checked" | "skipped"; note?: string };
	/** verify 允许通过但有一项没查成时，把原因带出来（不假装查过）。 */
	notices?: string[];
	failure?: { kind: TddRejectKind; message: string; details: Record<string, unknown> };
}

function logRelativePath(task: string, action: TddAction): string {
	const suffix = action === "tdd-red" ? "red" : action === "tdd-green" ? "green" : "verify";
	return `.handoff/${task}-tdd-${suffix}.log`;
}

/**
 * 失败签名：抓「能说明为什么红」的那一行，不是「跑的是哪个二进制」。
 *
 * 顺序按信息密度排：断言差异对（`Expected: 7` + `Received: 5`）→ 框架计数行
 * （`Failed! - Failed: 3`）→ 单条断言/异常行 → 行首失败标记（`(fail) xxx`）→
 * 计数行（`1 fail`）。版本横幅（`bun test v1.4.4`）之类「永远会打印」的行在兜底
 * 路径里被跳过——否则每条 red 的 fail= 都会是同一句废话。
 */
export function failSignature(outcome: CommandOutcome): string {
	const text = `${outcome.stdout}\n${outcome.stderr}`;
	const patterns: RegExp[] = [
		/Expected:[^\n]*\n\s*Received:[^\n]*/,
		/Failed!\s*-\s*Failed:\s*\d+[^\n]*/,
		/^\s*(?:Assert\.\w+|error|Error|Exception|FATAL)[: ][^\n]*$/m,
		/^\s*(?:FAIL|ERROR|✗|×|\(fail\))[^\n]*$/m,
		/^\s*\d+\s+(?:failed|failing|fail)(?:,\s*\d+\s+passed)?[^\n]*$/m,
	];
	for (const pattern of patterns) {
		const match = pattern.exec(text);
		if (match) return oneLine(match[0]).slice(0, 160);
	}
	const banner = /^(?:bun test|dotnet test|Running|Test run for|VSTest|npm (?:ERR|notice))/i;
	const firstUseful = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0 && !banner.test(line));
	return (firstUseful ?? `exit ${outcome.exit}`).slice(0, 160);
}

function logBlock(cmd: string, outcome: CommandOutcome, timeoutMs: number): string {
	return [`$ ${cmd}`, `## exit ${outcome.exit} (timeout ${timeoutMs} ms)`, outcome.stdout.slice(-6000), outcome.stderr.slice(-3000)].join(
		"\n",
	);
}

/**
 * 门禁本体。三个动作共享同一个「读 Notes → 判定 → 跑命令 → 写 Notes」骨架，
 * 差别只在判定时机：green 先判后跑，red 只判退出码，verify 完全不跑命令
 * （跑命令会引入新的时间点，反而让「green 之后有没有改代码」失去意义）。
 */
export function createTddGate(deps: TddDeps) {
	const needCmd = (request: GateRequest, action: TddAction): string => {
		const cmd = request.cmd?.trim();
		if (!cmd) throw new TddGateError("selection_mismatch", `${action} needs --cmd (the exact test command for this selection set)`, { action });
		return cmd;
	};

	const red = (request: GateRequest): GateOutcome => {
		deps.assertBacklog(request.cwd);
		const cmd = needCmd(request, "tdd-red");
		const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const sel = selectionFingerprint(cmd, deps.digest);
		const logPath = logRelativePath(request.task, "tdd-red");
		const outcome = deps.runCommand(cmd, request.cwd, timeoutMs);
		deps.appendLog(request.cwd, logPath, `\n### ${deps.now().toISOString()} tdd-red\n${logBlock(cmd, outcome, timeoutMs)}\n`);
		if (outcome.exit === 0) {
			return {
				ok: false,
				action: "tdd-red",
				task: request.task,
				sel,
				exit: 0,
				logPath,
				failure: {
					kind: "red_passed",
					message:
						`the command passed (exit 0), so it cannot be recorded as red: \`${normalizeCommand(cmd)}\`; ` +
						`write a failing test first, then record it as tdd-red (log: ${logPath})`,
					details: { sel, cmd: normalizeCommand(cmd), log: logPath },
				},
			};
		}
		const line = formatEntry({
			ts: deps.now().toISOString(),
			action: "tdd-red",
			task: request.task,
			...(request.role ? { role: request.role } : {}),
			cmd: normalizeCommand(cmd),
			exit: outcome.exit,
			sel,
			fail: failSignature(outcome),
			log: logPath,
		});
		deps.appendNotes(request.cwd, request.task, line);
		return { ok: true, action: "tdd-red", task: request.task, sel, exit: outcome.exit, entry: line, logPath };
	};

	const green = (request: GateRequest): GateOutcome => {
		deps.assertBacklog(request.cwd);
		const cmd = needCmd(request, "tdd-green");
		const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const sel = selectionFingerprint(cmd, deps.digest);
		const logPath = logRelativePath(request.task, "tdd-green");
		const decision = decideGreen(parseTddEntries(deps.readNotes(request.cwd, request.task)), sel, cmd);
		if (!decision.ok) {
			deps.appendLog(
				request.cwd,
				logPath,
				`\n### ${deps.now().toISOString()} tdd-green REJECTED (${decision.error.kind})\n${decision.error.message}\n`,
			);
			return {
				ok: false,
				action: "tdd-green",
				task: request.task,
				sel,
				exit: decision.error.kind === "selection_mismatch" ? 1 : -1,
				logPath,
				failure: { kind: decision.error.kind, message: decision.error.message, details: decision.error.details },
			};
		}
		const outcome = deps.runCommand(cmd, request.cwd, timeoutMs);
		deps.appendLog(request.cwd, logPath, `\n### ${deps.now().toISOString()} tdd-green\n${logBlock(cmd, outcome, timeoutMs)}\n`);
		if (outcome.exit !== 0) {
			return {
				ok: false,
				action: "tdd-green",
				task: request.task,
				sel,
				exit: outcome.exit,
				logPath,
				failure: {
					kind: "green_failed",
					message:
						`the command still fails (exit ${outcome.exit}): ${failSignature(outcome)}; green requires a passing run ` +
						`(log: ${logPath})`,
					details: { sel, exit: outcome.exit, log: logPath },
				},
			};
		}
		// 第三口径需要一个可比对的基线：优先工作树快照（含未提交改动），否则退到 HEAD。
		// 两者都没有时 verify 会明说 skipped，而不是假装查过。
		const line = formatEntry({
			ts: deps.now().toISOString(),
			action: "tdd-green",
			task: request.task,
			...(request.role ? { role: request.role } : {}),
			cmd: normalizeCommand(cmd),
			exit: 0,
			sel,
			log: logPath,
			head: deps.head(request.cwd),
			snap: deps.snapshot(request.cwd),
		});
		deps.appendNotes(request.cwd, request.task, line);
		return { ok: true, action: "tdd-green", task: request.task, sel, exit: 0, entry: line, logPath };
	};

	const verify = (request: GateRequest): GateOutcome => {
		deps.assertBacklog(request.cwd);
		const logPath = logRelativePath(request.task, "tdd-verify");
		const decision = decideVerify(
			parseTddEntries(deps.readNotes(request.cwd, request.task)),
			(ref) => deps.changedSince(request.cwd, ref).paths,
		);
		const notices: string[] = [];
		if (!decision.ok) {
			deps.appendLog(
				request.cwd,
				logPath,
				`\n### ${deps.now().toISOString()} tdd-verify REJECTED (${decision.kind})\n${decision.message}\n`,
			);
			return {
				ok: false,
				action: "tdd-verify",
				task: request.task,
				sel: "",
				exit: 1,
				logPath,
				failure: { kind: decision.kind, message: decision.message, details: decision.details },
			};
		}
		if (decision.note) notices.push(decision.note);
		const line = formatEntry({
			ts: deps.now().toISOString(),
			action: "tdd-verify",
			task: request.task,
			...(request.role ? { role: request.role } : {}),
			cmd: decision.green.cmd,
			exit: 0,
			sel: decision.green.sel,
			head: decision.green.head,
			snap: decision.green.snap,
			log: logPath,
		});
		deps.appendNotes(request.cwd, request.task, line);
		deps.appendLog(
			request.cwd,
			logPath,
			`\n### ${deps.now().toISOString()} tdd-verify OK\nred=${decision.red.ts} green=${decision.green.ts} productionCheck=${decision.productionCheck}\n`,
		);
		return {
			ok: true,
			action: "tdd-verify",
			task: request.task,
			sel: decision.green.sel,
			exit: 0,
			entry: line,
			logPath,
			verified: {
				red: decision.red,
				green: decision.green,
				productionCheck: decision.productionCheck,
				...(decision.note ? { note: decision.note } : {}),
			},
			...(notices.length > 0 ? { notices } : {}),
		};
	};

	return { red, green, verify };
}

export type TddGate = ReturnType<typeof createTddGate>;

// ---------------------------------------------------------------- 真实现（进程 / backlog / git）

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

/**
 * Backlog CLI 门禁：版本必须含 `-thu.`（本仓库的分支版本），否则读写语义不可信。
 * 这是 tdd-workflow / backlog-workflow 已有的硬约束，这里落成机器检查。
 */
export function assertBacklogVersion(root: string): void {
	const probe = spawnSync("backlog", ["--version"], { cwd: root, encoding: "utf8" });
	if (probe.error || probe.status !== 0) {
		throw new Error(`backlog CLI is unavailable in ${root}: ${stderrOf(probe)}`);
	}
	const version = (probe.stdout ?? "").trim();
	if (!version.includes("-thu.")) {
		throw new Error(`backlog --version must contain "-thu." in ${root}; got "${version}"`);
	}
}

function backlogNotes(root: string, task: string): string | null {
	const probe = spawnSync("backlog", ["task", "view", task, "--json"], { cwd: root, encoding: "utf8" });
	if (probe.error || probe.status !== 0) {
		throw new Error(`backlog task view ${task} failed in ${root}: ${stderrOf(probe)}`);
	}
	const notes = parseJson(probe.stdout ?? "")?.task?.implementationNotes;
	return typeof notes === "string" ? notes : null;
}

function backlogAppendNotes(root: string, task: string, line: string): void {
	const probe = spawnSync("backlog", ["task", "edit", task, "--append-notes", line], { cwd: root, encoding: "utf8" });
	if (probe.error || probe.status !== 0) {
		throw new Error(`backlog task edit ${task} --append-notes failed in ${root}: ${stderrOf(probe)}`);
	}
}

function gitOutput(root: string, args: string[]): string {
	const probe = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
	if (probe.error || probe.status !== 0) {
		throw new Error(`git ${args.join(" ")} failed in ${root}: ${stderrOf(probe)}`);
	}
	return probe.stdout ?? "";
}

/** 默认依赖：真起进程、真读写 backlog、真读 git。 */
export const defaultTddDeps: TddDeps = {
	now: () => new Date(),
	digest: (input) => createHash("sha256").update(input, "utf8").digest("hex"),
	runCommand: (cmd, cwd, timeoutMs) => {
		const probe = spawnSync("bash", ["-lc", cmd], { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
		const stdout = probe.stdout ?? "";
		const stderr = probe.stderr ?? "";
		if (probe.error) {
			const timedOut = (probe.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
			return {
				exit: timedOut ? 124 : 127,
				stdout,
				stderr: `${stderr}\n${timedOut ? `command timed out after ${timeoutMs} ms` : probe.error.message}`.trim(),
			};
		}
		return { exit: probe.status ?? 1, stdout, stderr };
	},
	readNotes: backlogNotes,
	appendNotes: backlogAppendNotes,
	head: (root) => gitOutput(root, ["rev-parse", "HEAD"]).trim(),
	/**
	 * `git stash create` 造一个代表当前工作树（已跟踪文件的已暂存 + 未暂存改动）的
	 * commit 对象，但不动 index、不动工作树、不产生 stash 列表条目。干净树输出为空。
	 * 这是「green 那一刻工作树长什么样」的可 diff 基线。
	 */
	snapshot: (root) => {
		const sha = gitOutput(root, ["stash", "create"]).trim();
		return sha.length > 0 ? sha : undefined;
	},
	/**
	 * 相对某个 ref 的改动集合。
	 *
	 * `paths` 只取 `git diff --name-only <ref>`——即「相对基线真正变了什么」。绝不把
	 * `git status` 里的脏文件并进来：green 的快照基线本身就是那一刻的工作树（含未提交
	 * 修复），把脏文件再算一遍会让「刚 green 完就 verify」永远自拒（真机踩过）。
	 *
	 * 未跟踪文件另走 `untracked`：快照（`git stash create`）不含未跟踪文件，无法判定
	 * 它们在 green 时刻是否已存在，所以不参与第三口径判定，只回报给调用方看。
	 * ref 失效时抛错，由 verify 降级为 skipped。
	 */
	changedSince: (root, ref) => {
		const paths = new Set<string>();
		for (const line of gitOutput(root, ["diff", "--name-only", ref]).split(/\r?\n/)) {
			const trimmed = line.trim();
			if (trimmed) paths.add(trimmed);
		}
		const untracked: string[] = [];
		for (const raw of gitOutput(root, ["status", "--porcelain"]).split(/\r?\n/)) {
			if (!raw.startsWith("??")) continue;
			const path = raw.slice(3).trim().replace(/^"|"$/g, "");
			if (path) untracked.push(path);
		}
		return { paths: [...paths], untracked };
	},
	appendLog: (root, relativePath, block) => {
		const path = join(root, relativePath);
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, block, "utf8");
	},
	assertBacklog: assertBacklogVersion,
};
