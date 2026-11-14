/**
 * 角色 → 启动计划的解析（THU-119.1 / S0）。
 *
 * 纯函数：输入 (role, taskId, item, candidateIndex) + (promptRoot, cwd, overrides)，
 * 输出确定性的 ResolvedLaunch——同样的输入永远得到同样的 kind/model/effort/prompt。
 * 不读时钟、不读环境变量、不碰 pane；pane 操作在 dispatch_role 里交给
 * `external_worker` 执行。
 *
 * 只读语义：codely 侧不传任何 approval（默认 yolo），只读靠角色正文；
 * codex 侧由 permissions.write 推导 `-s read-only` / `-s workspace-write`。
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { RoleOverrides } from "./config";
import {
	type Effort,
	type FallbackTrigger,
	type RoleCandidate,
	type RoleDefinition,
	type RoleId,
	type Sandbox,
	type WireApi,
	type WorkerKind,
	assertRoleId,
	getRole,
	RoleRegistryError,
	validateCandidates,
} from "./registry";

export interface RoleRequest {
	/** 角色 id；未知值直接报错，不做模糊匹配。 */
	role: string;
	/** Backlog 任务 id，例如 THU-119.1。必填——没有任务上下文的派工不可追溯。 */
	taskId: string;
	/** 子项/拍次标签，例如 S0、P2。可选。 */
	item?: string;
	/** 1-based 候选序号；缺省 1（primary）。越界报错。 */
	candidateIndex?: number;
	/**
	 * 实际要做的事（自由文本）。注册表只定义「谁来做、能做什么」，任务内容必须由
	 * 调用方给：没有 brief 的派工只能得到一份角色说明，worker 无从下手。
	 */
	brief?: string;
}

export interface ResolveContext {
	/** roles 目录的绝对路径（prompts/<file> 相对它）。 */
	promptRoot: string;
	/** 工作目录（写进 prompt，作为外部 agent 的仓库根）。 */
	cwd: string;
	overrides?: RoleOverrides;
}

export interface ResolvedLaunch {
	role: RoleId;
	roleTitle: string;
	taskId: string;
	item?: string;
	candidateIndex: number;
	candidateCount: number;
	kind: WorkerKind;
	model: string;
	effort: Effort;
	/** 仅 codex 使用；codely 侧永远是 undefined（默认 yolo，只读靠提示词）。 */
	sandbox?: Sandbox;
	/** 仅 codely 使用：该模型只认的 wire API（猜错就是 400）。 */
	wireApi?: WireApi;
	cwd: string;
	/** prompt 正文（role body + 任务书），可直接作为 external_worker 的 task。 */
	prompt: string;
	/** role body 文件绝对路径。 */
	promptPath: string;
	permissions: RoleDefinition["permissions"];
	fallback: FallbackTrigger[];
	/** 全部候选的只读快照，供报告展示「为什么选它」。 */
	candidates: RoleCandidate[];
}

const SAFE_TOKEN = /^[A-Za-z0-9._:#/-]+$/;

function assertToken(name: string, value: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) throw new RoleRegistryError(`${name} must be a non-empty string`);
	if (!SAFE_TOKEN.test(trimmed)) {
		throw new RoleRegistryError(`${name} "${value}" contains unsupported characters`);
	}
	return trimmed;
}

/**
 * 覆盖只改「用谁」，不改「能做什么」：只读角色的 codex 候选不得放宽到可写沙箱，
 * 写角色也不得收窄成只读��那会静默失败）。这是权限的机器闸门，与 prompt 无关。
 */
function guardOverridePermissions(role: RoleId, candidates: readonly RoleCandidate[]): void {
	const write = getRole(role).permissions.write;
	for (const [index, candidate] of candidates.entries()) {
		const where = `role "${role}" candidate #${index + 1}`;
		if (!write && candidate.kind === "codex" && candidate.sandbox !== undefined && candidate.sandbox !== "read-only") {
			throw new RoleRegistryError(
				`${where}: read-only role must use sandbox=read-only, got "${candidate.sandbox}" (overrides cannot widen permissions)`,
			);
		}
		if (write && candidate.kind === "codex" && candidate.sandbox === "read-only") {
			throw new RoleRegistryError(
				`${where}: write role cannot use sandbox=read-only (it could not modify anything)`,
			);
		}
	}
}

export function candidatesFor(role: RoleId, overrides?: RoleOverrides): RoleCandidate[] {
	const override = overrides?.[role];
	if (!override) return getRole(role).candidates.map((candidate) => ({ ...candidate }));
	validateCandidates(role, override.candidates);
	guardOverridePermissions(role, override.candidates);
	return override.candidates.map((candidate) => ({ ...candidate }));
}

export function readRoleBody(definition: RoleDefinition, promptRoot: string): { path: string; body: string } {
	const path = isAbsolute(definition.promptFile) ? definition.promptFile : join(promptRoot, definition.promptFile);
	if (!existsSync(path)) {
		throw new RoleRegistryError(`role "${definition.id}" prompt not found: ${path}`);
	}
	const raw = readFileSync(path, "utf8");
	// 文件头的 HTML 注释只做溯源，不进 prompt：剥掉后才把角色正文交给外部 agent。
	const body = raw.replace(/^\s*(?:<!--[\s\S]*?-->\s*)+/, "").replace(/\s+$/, "");
	if (body.length === 0) throw new RoleRegistryError(`role "${definition.id}" prompt is empty: ${path}`);
	return { path, body };
}

function resolveSandbox(candidate: RoleCandidate, definition: RoleDefinition): Sandbox | undefined {
	if (candidate.kind !== "codex") return undefined;
	return candidate.sandbox ?? (definition.permissions.write ? "workspace-write" : "read-only");
}

/** 任务书：把角色放进具体任务上下文（确定性，无时间戳）。 */
export function buildTaskPrompt(
	definition: RoleDefinition,
	request: { taskId: string; item?: string; brief?: string },
	launch: { cwd: string; sandbox?: Sandbox },
): string {
	const permissions = definition.permissions;
	const lines: string[] = ["", "---", "", "## 本次任务"];

	lines.push(`- 角色：${definition.id}（${definition.title}）`);
	lines.push(`- Backlog 任务：${request.taskId}`);
	if (request.item) lines.push(`- 子项：${request.item}`);
	lines.push(`- 仓库：${launch.cwd}`);
	if (permissions.write) {
		lines.push(
			`- 工作树：隔离 git worktree（不要在主工作树上改文件）${launch.sandbox ? `；沙箱 ${launch.sandbox}` : ""}`,
		);
	} else {
		const gate = launch.sandbox
			? `；运行时只有 \`${launch.sandbox}\` 沙箱这一道机器闸门`
			: "；**本进程没有机器级只读闸门（默认 yolo），只读完全靠你遵守本段约束**";
		lines.push(`- 工作树：与主会话共享，**只读**——不要修改、创建或删除任何文件${gate}`);
	}
	lines.push(`- 允许执行的命令：${permissions.allowedCommands.join(", ")}（除此之外不要执行）`);
	lines.push("- 产出要求：");
	for (const [index, deliverable] of definition.deliverables.entries()) {
		lines.push(`  ${index + 1}. ${deliverable}`);
	}
	lines.push(
		permissions.write
			? "- 交付方式：改完后把「改了什么/为什么/验证结果」写进 `.handoff/` 下本任务的 handoff 文件，并在此输出摘要。"
			: "- 交付方式：直接在本 pane 输出结论；不要写文件（你在这个角色下不写文件）。",
	);
	lines.push("- 越界处理：任务描述与仓库现状冲突、或需要权限外的动作时，停下来说明，不要自行放宽范围。");
	if (request.brief) {
		lines.push("", "## 具体任务", "", request.brief.trim());
	}

	return lines.join("\n");
}

export function resolveRole(request: RoleRequest, context: ResolveContext): ResolvedLaunch {
	const roleId = assertRoleId(request.role);
	const definition = getRole(roleId);
	const taskId = assertToken("taskId", request.taskId);
	const item = request.item ? assertToken("item", request.item) : undefined;
	// brief 是自由文本（可以多行、可以带代码片段），只要求「给了就不能是空白」。
	const brief = request.brief === undefined ? undefined : request.brief.trim();
	if (request.brief !== undefined && (!brief || brief.length === 0)) {
		throw new RoleRegistryError("brief must be non-empty when provided");
	}

	const candidates = candidatesFor(roleId, context.overrides);
	const candidateIndex = request.candidateIndex ?? 1;
	if (!Number.isInteger(candidateIndex) || candidateIndex < 1) {
		throw new RoleRegistryError(`candidateIndex must be a positive integer, got ${request.candidateIndex}`);
	}
	if (candidateIndex > candidates.length) {
		throw new RoleRegistryError(
			`role "${roleId}" has ${candidates.length} candidate(s), requested #${candidateIndex}`,
		);
	}

	const candidate = candidates[candidateIndex - 1];
	const { path: promptPath, body } = readRoleBody(definition, context.promptRoot);
	const sandbox = resolveSandbox(candidate, definition);
	const prompt = `${body}\n${buildTaskPrompt(definition, { taskId, item, brief }, { cwd: context.cwd, sandbox })}`;

	return {
		role: roleId,
		roleTitle: definition.title,
		taskId,
		item,
		brief,
		candidateIndex,
		candidateCount: candidates.length,
		kind: candidate.kind,
		model: candidate.model,
		effort: candidate.effort,
		sandbox,
		wireApi: candidate.kind === "codely" ? candidate.wireApi : undefined,
		cwd: context.cwd,
		prompt,
		promptPath,
		permissions: definition.permissions,
		fallback: [...definition.fallback],
		candidates,
	};
}

/** 派工报告用的一行摘要（不含 prompt 正文）。 */
export function describeLaunch(launch: ResolvedLaunch): string {
	const sandbox = launch.sandbox ? ` sandbox=${launch.sandbox}` : "";
	const wire = launch.wireApi ? ` wire=${launch.wireApi}` : "";
	return `${launch.role} → ${launch.kind}/${launch.model} effort=${launch.effort}${wire}${sandbox} (candidate ${launch.candidateIndex}/${launch.candidateCount}, task ${launch.taskId}${launch.item ? ` ${launch.item}` : ""})`;
}
