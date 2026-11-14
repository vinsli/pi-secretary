/**
 * 角色注册表（THU-119.1 / S0）。
 *
 * 这里是「按角色派工」的唯一契约来源：角色是**封闭枚举**，每个角色给出
 *   - prompt 指针（正文放在本目录 prompts/ 下，单一真相）
 *   - 有序候选（role → agent 映射：kind/model/effort/sandbox）
 *   - fallback 触发枚举
 *   - 权限（只读/可写、工作树、允许的命令）
 *
 * 执行仍由 `herdr-external-agents`（external_worker 工具）负责；本注册表只
 * 负责「该派给谁、用什么参数、给什么 prompt」，不做 pane 操作、不轮询。
 *
 * 关于只读（用户 2026-11-14 定调）：
 *   codely 默认就是 yolo，且 `--sandbox` 需要容器、`--collaboration-mode ask`
 *   连 shell 都没有，所以派给 codely 时**不传任何 approval 参数**，只读完全
 *   由角色正文明说（prompts/*.md 的「只读」段）。
 *   codex 侧有真正的机器闸门，只读角色固定 `-s read-only`（由 permissions.write
 *   推导，不写死在候选里）。
 *
 * 纪律：
 *   - 候选值可被 `.pi/secretary-roles.json` 覆盖（见 config.ts）。
 *   - 任何非法值（未知角色/未知 kind/未知 effort/空候选/未知 fallback 触发）
 *     必须抛错并指名出错项，禁止静默回退到默认值。
 */

export type WorkerKind = "codely" | "codex";
export type Effort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type Sandbox = "read-only" | "workspace-write" | "danger-full-access";
/**
 * codely 的后端模型各自只认一种 wire API，猜错就是 400：
 * `neo/eco/claude-opus-5-5` 在 codely 的 model-config 里被标成 `responses`，
 * 但网关只接受 messages（实测 `400 Responses compatibility for non-responses
 * providers is beta-only`）；带 `--wire-api messages` 即正常。
 */
export type WireApi = "chat" | "responses" | "messages";
export type FallbackTrigger = "launch_failed" | "no_output_60s" | "turn_error";

export const FALLBACK_TRIGGERS: readonly FallbackTrigger[] = [
	"launch_failed",
	"no_output_60s",
	"turn_error",
];

export const EFFORTS: readonly Effort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
export const SANDBOXES: readonly Sandbox[] = ["read-only", "workspace-write", "danger-full-access"];
export const WIRE_APIS: readonly WireApi[] = ["chat", "responses", "messages"];
export const KINDS: readonly WorkerKind[] = ["codely", "codex"];

export interface RoleCandidate {
	kind: WorkerKind;
	model: string;
	effort: Effort;
	/** 仅 codex 生效；缺省时按 permissions.write 推导（只读角色 read-only）。 */
	sandbox?: Sandbox;
	/** 仅 codely 生效；模型自己只认一种 wire API 时必须显式给。 */
	wireApi?: WireApi;
}

export interface RolePermissions {
	/** 是否可以修改仓库文件。只读角色一律 false——codely 靠角色正文约束，codex 靠 -s read-only。 */
	write: boolean;
	/** shared = 与主会话同一工作树（只读角色）；isolated = 必须隔离工作树（可写角色）。 */
	worktree: "shared" | "isolated";
	/** 允许执行的命令前缀；只用于拼 prompt 约束，不构成沙箱。 */
	allowedCommands: string[];
}

export interface RoleDefinition {
	id: RoleId;
	title: string;
	/** 一句话定位，供 role_list 与报告使用。 */
	purpose: string;
	/** 相对本目录的 prompt 正文路径。 */
	promptFile: string;
	/** 派工 prompt 里声明的产出要求。 */
	deliverables: string[];
	candidates: RoleCandidate[];
	fallback: FallbackTrigger[];
	permissions: RolePermissions;
}

export const ROLE_IDS = ["researcher", "reviewer", "oracle", "planner", "worker"] as const;
export type RoleId = (typeof ROLE_IDS)[number];

const READ_ONLY_COMMANDS = [
	"rg",
	"grep",
	"git",
	"ls",
	"cat",
	"sed",
	"head",
	"tail",
	"wc",
	"find",
	"bun test",
	"node --test",
];

const WRITE_COMMANDS = [
	...READ_ONLY_COMMANDS,
	"bun",
	"node",
	"npm",
	"npx",
	"git add",
	"git commit",
	"backlog",
];

/**
 * role → agent 映射（2026-11-14 按用户口径定稿）：
 * 一等 candidate 一律 codely claude-opus-5-5（worker 用 codely-core），
 * fallback 一律 codex gpt-6-astra high（worker fallback 为 gpt-6.1-sol）。
 */
export const ROLE_REGISTRY: Record<RoleId, RoleDefinition> = {
	researcher: {
		id: "researcher",
		title: "只读侦察",
		purpose: "查清代码事实并给出 file:line 证据，不改文件、不提改造方案。",
		promptFile: "prompts/researcher.md",
		deliverables: ["结论（一两句话）", "证据：file:line 逐条", "不确定项与需要的下一步信息"],
		candidates: [
			{ kind: "codely", model: "neo/eco/claude-opus-5-5", effort: "high", wireApi: "messages" },
			{ kind: "codex", model: "gpt-6-astra", effort: "high" },
		],
		fallback: ["launch_failed", "no_output_60s"],
		permissions: {
			write: false,
			worktree: "shared",
			allowedCommands: READ_ONLY_COMMANDS,
		},
	},
	reviewer: {
		id: "reviewer",
		title: "只读评审",
		purpose: "找 bug、行为不一致、约定违背与缺验证，按 P0/P1/P2 报 file:line。",
		promptFile: "prompts/reviewer.md",
		deliverables: ["按严重度排序的问题清单", "每条的 file:line 与触发条件", "已检查且放心的高风险点"],
		candidates: [
			{ kind: "codely", model: "neo/eco/claude-opus-5-5", effort: "xhigh", wireApi: "messages" },
			{ kind: "codex", model: "gpt-6-astra", effort: "high" },
		],
		fallback: ["launch_failed", "no_output_60s"],
		permissions: {
			write: false,
			worktree: "shared",
			allowedCommands: READ_ONLY_COMMANDS,
		},
	},
	oracle: {
		id: "oracle",
		title: "技术裁决",
		purpose: "给结论、讲权衡、标不确定，处理疑难问题的第二意见。",
		promptFile: "prompts/oracle.md",
		deliverables: ["一句话结论", "理由与证据", "权衡与被否选项", "不确定项"],
		candidates: [
			{ kind: "codely", model: "neo/eco/claude-opus-5-5", effort: "high", wireApi: "messages" },
			{ kind: "codex", model: "gpt-6-astra", effort: "high" },
		],
		fallback: ["launch_failed", "no_output_60s"],
		permissions: {
			write: false,
			worktree: "shared",
			allowedCommands: READ_ONLY_COMMANDS,
		},
	},
	planner: {
		id: "planner",
		title: "实施规划",
		purpose: "产出可执行步骤（现状核实/步骤/依赖风险/验收/不做的事），不写实现。",
		promptFile: "prompts/planner.md",
		deliverables: ["现状核实（file:line）", "有序步骤", "依赖与风险", "每步验收命令", "范围外清单"],
		candidates: [
			{ kind: "codely", model: "neo/eco/claude-opus-5-5", effort: "high", wireApi: "messages" },
			{ kind: "codex", model: "gpt-6-astra", effort: "high" },
		],
		fallback: ["launch_failed", "no_output_60s"],
		permissions: {
			write: false,
			worktree: "shared",
			allowedCommands: READ_ONLY_COMMANDS,
		},
	},
	worker: {
		id: "worker",
		title: "实现",
		purpose: "在给定范围内改文件、跑验证，不越界；仅限隔离工作树。",
		promptFile: "prompts/worker.md",
		deliverables: ["改了哪些文件（路径）", "为什么这么改", "跑了什么验证与结果", "未完成部分与原因"],
		candidates: [
			{ kind: "codely", model: "codely-core", effort: "high" },
			{ kind: "codex", model: "gpt-6.1-sol", effort: "high" },
		],
		fallback: ["launch_failed", "no_output_60s", "turn_error"],
		permissions: {
			write: true,
			worktree: "isolated",
			allowedCommands: WRITE_COMMANDS,
		},
	},
};

export class RoleRegistryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RoleRegistryError";
	}
}

export const isRoleId = (value: unknown): value is RoleId =>
	typeof value === "string" && (ROLE_IDS as readonly string[]).includes(value);

export function assertRoleId(value: unknown): RoleId {
	if (!isRoleId(value)) {
		throw new RoleRegistryError(`unknown role "${String(value)}" (known: ${ROLE_IDS.join("|")})`);
	}
	return value;
}

export function assertKind(value: unknown): WorkerKind {
	if (typeof value !== "string" || !(KINDS as readonly string[]).includes(value)) {
		throw new RoleRegistryError(`unsupported kind "${String(value)}" (${KINDS.join("|")})`);
	}
	return value as WorkerKind;
}

export function assertEffort(value: unknown): Effort {
	if (typeof value !== "string" || !(EFFORTS as readonly string[]).includes(value)) {
		throw new RoleRegistryError(`unsupported effort "${String(value)}" (${EFFORTS.join("|")})`);
	}
	return value as Effort;
}

export function assertSandbox(value: unknown): Sandbox {
	if (typeof value !== "string" || !(SANDBOXES as readonly string[]).includes(value)) {
		throw new RoleRegistryError(`unsupported sandbox "${String(value)}" (${SANDBOXES.join("|")})`);
	}
	return value as Sandbox;
}

export function assertWireApi(value: unknown): WireApi {
	if (typeof value !== "string" || !(WIRE_APIS as readonly string[]).includes(value)) {
		throw new RoleRegistryError(`unsupported wire api "${String(value)}" (${WIRE_APIS.join("|")})`);
	}
	return value as WireApi;
}

export function assertFallbackTrigger(value: unknown): FallbackTrigger {	if (typeof value !== "string" || !(FALLBACK_TRIGGERS as readonly string[]).includes(value)) {
		throw new RoleRegistryError(
			`unsupported fallback trigger "${String(value)}" (${FALLBACK_TRIGGERS.join("|")})`,
		);
	}
	return value as FallbackTrigger;
}

const MODEL_PATTERN = /^[A-Za-z0-9._:/+-]+$/;

export function assertModel(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new RoleRegistryError("model must be a non-empty string");
	}
	if (!MODEL_PATTERN.test(value)) {
		throw new RoleRegistryError(`unsupported model "${value}"`);
	}
	return value;
}

/** 校验候选：空列表、未知 kind/effort/sandbox、空 model 都抛错。 */
export function validateCandidates(role: string, candidates: readonly RoleCandidate[]): void {
	if (!Array.isArray(candidates) || candidates.length === 0) {
		throw new RoleRegistryError(`role "${role}" has no candidates`);
	}
	for (const [index, candidate] of candidates.entries()) {
		const where = `role "${role}" candidate #${index + 1}`;
		if (typeof candidate !== "object" || candidate === null) {
			throw new RoleRegistryError(`${where} must be an object`);
		}
		assertKind(candidate.kind);
		assertModel(candidate.model);
		assertEffort(candidate.effort);
		if (candidate.sandbox !== undefined) assertSandbox(candidate.sandbox);
		if (candidate.wireApi !== undefined) assertWireApi(candidate.wireApi);
	}
}

/**
 * 整表校验：任何角色缺 prompt 指针、候选非法、fallback 为空或触发未知都报错。
 * 单测与 role_list 都用它，保证注册表自身不会带病上线。
 */
export function validateRegistry(registry: Record<RoleId, RoleDefinition> = ROLE_REGISTRY): void {
	for (const id of ROLE_IDS) {
		const definition = registry[id];
		if (!definition) throw new RoleRegistryError(`role "${id}" is missing from the registry`);
		if (definition.id !== id) {
			throw new RoleRegistryError(`role "${id}" declares mismatched id "${definition.id}"`);
		}
		if (typeof definition.promptFile !== "string" || definition.promptFile.length === 0) {
			throw new RoleRegistryError(`role "${id}" has no promptFile`);
		}
		validateCandidates(id, definition.candidates);
		if (!Array.isArray(definition.fallback) || definition.fallback.length === 0) {
			throw new RoleRegistryError(`role "${id}" has no fallback triggers`);
		}
		for (const trigger of definition.fallback) assertFallbackTrigger(trigger);
		const permissions = definition.permissions;
		if (typeof permissions?.write !== "boolean") {
			throw new RoleRegistryError(`role "${id}" permissions.write must be boolean`);
		}
		if (permissions.worktree !== "shared" && permissions.worktree !== "isolated") {
			throw new RoleRegistryError(`role "${id}" permissions.worktree must be shared|isolated`);
		}
		if (!Array.isArray(permissions.allowedCommands) || permissions.allowedCommands.length === 0) {
			throw new RoleRegistryError(`role "${id}" permissions.allowedCommands must be non-empty`);
		}
		if (!permissions.write && permissions.worktree !== "shared") {
			throw new RoleRegistryError(`read-only role "${id}" must use a shared worktree`);
		}
	}
}

validateRegistry();

export function getRole(id: string): RoleDefinition {
	return ROLE_REGISTRY[assertRoleId(id)];
}
