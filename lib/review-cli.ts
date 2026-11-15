#!/usr/bin/env bun
/**
 * `pi-secretary-review` — CLI shell for the S4 review gate.
 *
 * This file intentionally contains no review policy. It parses a small command
 * line contract, reads an optional report file for `record`, and delegates all
 * validation and writes to `lib/review.ts`.
 */

import { readFileSync } from "node:fs";
import { createReviewGate, defaultReviewDeps, type ReviewPrepareOutcome, type ReviewRecordOutcome, type ReviewVerifyOutcome } from "./review";
import { findRepoRoot } from "../roles/roster";

const USAGE = `pi-secretary-review — Backlog S4 reviewer gate

  pi-secretary-review prepare --task <id> --base-sha <sha> --head-sha <sha> [--cwd <dir>]
  pi-secretary-review record  --task <id> --report-file <file> [--cwd <dir>]
  pi-secretary-review verify  --task <id> --base-sha <sha> --head-sha <sha> [--cwd <dir>]

prepare creates .backlog-workflow/sdd/<task>/review-package.md and diff.txt.
record stores the supplied report only as that task's SDD report.md.
verify checks task/BASE/HEAD/package/report, rejects Spec noncompliance/cannot_verify
and Critical/Important issues, and records Minor issues without changing AC or a parent task.

Exit codes: 0 passed · 1 review gate rejected · 2 usage/environment error.`;

type Flags = Record<string, string>;

function parseArgs(argv: string[]): { action?: string; flags: Flags; help: boolean } {
	const [action, ...rest] = argv;
	const flags: Flags = {};
	for (let i = 0; i < rest.length; i++) {
		const token = rest[i];
		if (token === "--help" || token === "-h") return { action, flags, help: true };
		if (!token?.startsWith("--")) throw new Error(`unexpected argument "${token ?? ""}" (flags must start with --)`);
		const key = token.slice(2);
		const value = rest[++i];
		if (!value || value.startsWith("--")) throw new Error(`--${key} needs a value`);
		flags[key] = value;
	}
	return { action, flags, help: action === undefined || action === "--help" || action === "-h" };
}

function flag(flags: Flags, ...names: string[]): string | undefined {
	for (const name of names) if (flags[name] !== undefined) return flags[name];
	return undefined;
}

export function main(argv: string[]): number {
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
	const action = parsed.action === "package" || parsed.action === "review_prepare"
		? "prepare"
		: parsed.action === "review_record"
			? "record"
			: parsed.action === "review_verify"
				? "verify"
				: parsed.action;
	if (action !== "prepare" && action !== "record" && action !== "verify") {
		process.stderr.write(`unknown action "${parsed.action ?? ""}"\n\n${USAGE}\n`);
		return 2;
	}
	const allowed = new Set(["task", "base", "head", "base-sha", "head-sha", "BASE_SHA", "HEAD_SHA", "report", "report-file", "cwd"]);
	for (const key of Object.keys(parsed.flags)) {
		if (!allowed.has(key)) {
			process.stderr.write(`unknown flag --${key}\n`);
			return 2;
		}
	}
	const task = flag(parsed.flags, "task")?.trim();
	if (!task) {
		process.stderr.write("--task is required\n");
		return 2;
	}
	const cwd = findRepoRoot(flag(parsed.flags, "cwd") ?? process.cwd());
	const gate = createReviewGate(defaultReviewDeps);
	let outcome: ReviewPrepareOutcome | ReviewRecordOutcome | ReviewVerifyOutcome;
	try {
		if (action === "record") {
			const reportFile = flag(parsed.flags, "report-file");
			const report = flag(parsed.flags, "report") ?? (reportFile ? readFileSync(reportFile, "utf8") : undefined);
			if (report === undefined) throw new Error("--report-file or --report is required for record");
			outcome = gate.record({ task, cwd, report });
		} else {
			const baseSha = flag(parsed.flags, "base-sha", "base", "BASE_SHA");
			const headSha = flag(parsed.flags, "head-sha", "head", "HEAD_SHA");
			if (!baseSha || !headSha) throw new Error(`--base-sha and --head-sha are required for ${action}`);
			outcome = action === "prepare"
				? gate.prepare({ task, baseSha, headSha, cwd })
				: gate.verify({ task, baseSha, headSha, cwd });
		}
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 2;
	}
	process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
	return outcome.ok ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
