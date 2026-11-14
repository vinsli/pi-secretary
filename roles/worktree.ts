/**
 * 写权限的机器闸门（THU-119.1 / S1）。
 *
 * `permissions.write: true` 的角色（目前只有 worker）只允许在**隔离 git worktree**
 * 里改文件。这条规则在 tdd-workflow 里是纪律，在这里落成机器检查：主工作树上
 * 派写角色直接拒绝，而不是靠 prompt 自觉。
 *
 * 判据只看文件系统，不起子进程：git 的 linked worktree / submodule 里 `.git` 是
 * 文件（内容 `gitdir: ...`），主工作树里 `.git` 是目录。仓库根由调用方给
 * （已经过 `.git` 向上搜索），这里只判断该根的 `.git` 形态。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export interface WorktreeCheck {
	ok: boolean;
	/** 不 ok 时给出原因与可直接执行的补救命令。 */
	reason?: string;
	hint?: string;
}

export function checkIsolatedWorktree(repoRoot: string): WorktreeCheck {
	const dotGit = join(repoRoot, ".git");
	if (!existsSync(dotGit)) {
		return { ok: false, reason: `not a git repository: ${repoRoot}` };
	}
	let isLinked = false;
	try {
		isLinked = statSync(dotGit).isFile();
	} catch {
		isLinked = false;
	}
	if (!isLinked) {
		return {
			ok: false,
			reason: `${repoRoot} is the main worktree, not an isolated one`,
			hint: `git worktree add ../${"<repo>"}-<item> -b <branch> && dispatch again with that directory as cwd`,
		};
	}
	// 文件内容的 gitdir 指向必须存在，否则是坏掉的 worktree（.git 残留）。
	try {
		const pointer = readFileSync(dotGit, "utf8").trim();
		const target = pointer.replace(/^gitdir:\s*/, "");
		// git 可以写绝对路径（`git worktree add /abs/path`），也可以写相对路径。
		const resolved = target ? (isAbsolute(target) ? target : join(repoRoot, target)) : "";
		if (!resolved || !existsSync(resolved)) {
			return { ok: false, reason: `${dotGit} points at a missing gitdir`, hint: "re-create the worktree" };
		}
	} catch {
		return { ok: false, reason: `unreadable ${dotGit}` };
	}
	return { ok: true };
}

/** 只让写角色过这道门；只读角色与主会话共享工作树，无需隔离。 */
export function assertWritableTarget(repoRoot: string, write: boolean): void {
	if (!write) return;
	const check = checkIsolatedWorktree(repoRoot);
	if (check.ok) return;
	const hint = check.hint ? ` — ${check.hint}` : "";
	throw new Error(`write role needs an isolated git worktree: ${check.reason}${hint}`);
}
