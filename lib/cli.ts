#!/usr/bin/env bun
/**
 * `pi-secretary-tdd` —— TDD 门禁的 CLI 入口（THU-119.3 / S3）。
 *
 * 为什么要有 CLI：外部 worker（codely / codex）不是 Pi 进程，看不到 Pi 扩展工具
 * （`tdd_red` / `tdd_green` / `tdd_verify`）。它们只有 shell。所以同一套判定必须有
 * 一个可执行的入口，否则「worker 走 TDD」在外部 agent 上根本落不了地。
 *
 *   pi-secretary-tdd red    --task THU-119.3 --cmd "dotnet test … --filter X"
 *   pi-secretary-tdd green  --task THU-119.3 --cmd "dotnet test … --filter X"
 *   pi-secretary-tdd verify --task THU-119.3
 *
 * 输出：stdout 一段 JSON（成功是 GateOutcome，拒绝是 {ok:false, failure:{kind,…}}）。
 * 退出码：0 通过；1 被门禁拒绝；2 参数/环境错误。判定逻辑一行都不在这里，
 * 全在 lib/tdd.ts——CLI 只是 deps 的一层薄壳。
 */

import { type GateOutcome, type GateRequest, type TddAction, createTddGate, defaultTddDeps } from "./tdd";
import { findRepoRoot } from "../roles/roster";

const USAGE = `pi-secretary-tdd — Backlog 内的 TDD 门禁

  pi-secretary-tdd red    --task <id> --cmd <命令> [--role <role>] [--timeout <ms>] [--cwd <dir>]
  pi-secretary-tdd green  --task <id> --cmd <命令> [--role <role>] [--timeout <ms>] [--cwd <dir>]
  pi-secretary-tdd verify --task <id>                         [--role <role>] [--cwd <dir>]

red    跑命令；只有失败才写 Notes（命令通过会被拒绝为 red_passed）。
green  先判「存在同选择集更早 red」，再跑命令；通过才写 Notes。
verify 不跑命令，只审已写下的 red→green 链：green 早于 red / 选择集不一致 /
       green 之后生产代码有未记录改动，三者指名其一。

退出码：0 通过 · 1 门禁拒绝 · 2 参数或环境错误。`;

type Parsed = Record<string, string>;

function parseArgs(argv: string[]): { action: string; flags: Parsed; help: boolean } {
	const [action, ...rest] = argv;
	const flags: Parsed = {};
	for (let index = 0; index < rest.length; index++) {
		const token = rest[index];
		if (!token.startsWith("--")) throw new Error(`unexpected argument "${token}" (flags must start with --)`);
		const key = token.slice(2);
		const value = rest[index + 1];
		if (value === undefined || value.startsWith("--")) throw new Error(`--${key} needs a value`);
		flags[key] = value;
		index++;
	}
	return { action, flags, help: action === undefined || action === "--help" || action === "-h" };
}

function main(argv: string[]): number {
	let parsed: ReturnType<typeof parseArgs>;
	try {
		parsed = parseArgs(argv);
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
		return 2;
	}
	if (parsed.help) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}

	const { action, flags } = parsed;
	const allowed = new Set(["task", "cmd", "role", "timeout", "cwd"]);
	for (const key of Object.keys(flags)) {
		if (!allowed.has(key)) {
			process.stderr.write(`unknown flag --${key} (allowed: task, cmd, role, timeout, cwd)\n`);
			return 2;
		}
	}
	if (action !== "red" && action !== "green" && action !== "verify") {
		process.stderr.write(`unknown action "${action}"\n\n${USAGE}\n`);
		return 2;
	}
	const task = flags.task?.trim();
	if (!task) {
		process.stderr.write("--task is required\n");
		return 2;
	}
	const needsCommand = action !== "verify";
	if (needsCommand && !flags.cmd?.trim()) {
		process.stderr.write(`--cmd is required for ${action}\n`);
		return 2;
	}
	const timeoutMs = flags.timeout === undefined ? undefined : Number.parseInt(flags.timeout, 10);
	if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
		process.stderr.write("--timeout must be a positive integer (ms)\n");
		return 2;
	}

	const request: GateRequest = {
		task,
		...(needsCommand ? { cmd: flags.cmd } : {}),
		cwd: findRepoRoot(flags.cwd ?? process.cwd()),
		...(flags.role ? { role: flags.role } : {}),
		...(timeoutMs ? { timeoutMs } : {}),
	};

	const gate = createTddGate(defaultTddDeps);
	const actionName: TddAction = action === "red" ? "tdd-red" : action === "green" ? "tdd-green" : "tdd-verify";
	let outcome: GateOutcome;
	try {
		outcome = action === "red" ? gate.red(request) : action === "green" ? gate.green(request) : gate.verify(request);
	} catch (error) {
		// 环境/参数类失败（backlog 不可用、版本不对、--cmd 缺失的硬错误）走 2，与
		// 「门禁判定拒绝」区分开——调用方要能分辨「我用错了」和「我被挡了」。
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 2;
	}

	process.stdout.write(`${JSON.stringify({ action: actionName, ...outcome }, null, 2)}\n`);
	return outcome.ok ? 0 : 1;
}

process.exit(main(process.argv.slice(2)));
