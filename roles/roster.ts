/**
 * 派工台账（THU-119.1 / S1）：每次成功派工追加一行 JSONL。
 *
 * 只在 `external_worker` 成功返回 pane 之后写入——失败派工不写台账，避免把
 * 没起来的 pane 记成在跑。台账是「主 agent 派了谁、在哪个 pane、用什么参数」
 * 的唯一结构化记录，`.handoff/` 目录本身不进 git。
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DispatcherIdentity } from "./dispatcher";
import type { ResolvedLaunch } from "./resolve";

export const ROSTER_RELATIVE_PATH = ".handoff/worker-roster.jsonl";

export interface RosterRecord {
	ts: string;
	role: string;
	taskId: string;
	item?: string;
	pane: string;
	tab?: string;
	/**
	 * 调用方自称（user | secretary | teamlead）。角色与调用方正交：同一角色可以被
	 * secretary 派，也可以被 teamlead 派。没自称就没有这两个字段——不猜。
	 */
	dispatchedBy?: string;
	/** 派工的 pi 会话标识（缺省由工具层用当前 session id 补）。 */
	dispatchedById?: string;
	kind: string;
	model: string;
	effort: string;
	sandbox?: string;
	wireApi?: string;
	candidateIndex: number;
	candidateCount: number;
}

export function buildRosterRecord(
	launch: ResolvedLaunch,
	pane: { pane: string; tab?: string },
	now: Date,
	dispatcher?: DispatcherIdentity,
): RosterRecord {
	return {
		ts: now.toISOString(),
		role: launch.role,
		taskId: launch.taskId,
		...(launch.item ? { item: launch.item } : {}),
		pane: pane.pane,
		...(pane.tab ? { tab: pane.tab } : {}),
		...(dispatcher ? { dispatchedBy: dispatcher.kind } : {}),
		...(dispatcher?.id ? { dispatchedById: dispatcher.id } : {}),
		kind: launch.kind,
		model: launch.model,
		effort: launch.effort,
		...(launch.sandbox ? { sandbox: launch.sandbox } : {}),
		...(launch.wireApi ? { wireApi: launch.wireApi } : {}),
		candidateIndex: launch.candidateIndex,
		candidateCount: launch.candidateCount,
	};
}

/** 向上找 `.git`（文件或目录都算，兼容 worktree）。找不到就用 cwd。 */
export function findRepoRoot(cwd: string): string {
	let dir = cwd;
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = join(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	return cwd;
}

/** 追加一行台账，返回绝对路径。 */
export function appendRosterRecord(root: string, record: RosterRecord): string {
	const path = join(root, ROSTER_RELATIVE_PATH);
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
	return path;
}
