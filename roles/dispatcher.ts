/**
 * 派工调用方轴（THU-119.1 解耦）。
 *
 * 「角色」回答**派给谁、用什么参数**；「调用方」回答**是谁派的**。两者正交：
 * secretary 和 teamlead 都是加载同一份扩展的 pi 进程，代码无法从进程里认出自己
 * 是谁，所以这里只做三件事：
 *   - 封闭枚举 kind（user | secretary | teamlead），未知值报错，不做模糊匹配；
 *   - id 可由调用方显式给（跨会话/跨 workspace 派工时用），缺省由工具层用当前
 *     session id 兜底；
 *   - 归一化成 `{ kind, id? }` 写进台账，让 `.handoff/worker-roster.jsonl` 能区分
 *     「secretary 派的」和「teamlead 派的」。
 *
 * 纪律：
 *   - 显式声明才记录，**不猜**。没给 dispatcher 的派工台账里就没有 dispatchedBy，
 *     这份「未自称」本身也是可用的信号（用来量迁移进度）。
 *   - 这是**可追溯的自称**，不是安全边界：真正的派工权分级（谁能派哪些角色）要等
 *     agent-team 包落地（doc-2 §3 的权限表），在那之前不伪造机器校验。
 */

export const DISPATCHER_KINDS = ["user", "secretary", "teamlead"] as const;
export type DispatcherKind = (typeof DISPATCHER_KINDS)[number];

export interface DispatcherIdentity {
	kind: DispatcherKind;
	/** 派工的 pi 会话标识；缺省时由工具层用当前 session id 补。 */
	id?: string;
}

export class DispatcherError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DispatcherError";
	}
}

export const isDispatcherKind = (value: unknown): value is DispatcherKind =>
	typeof value === "string" && (DISPATCHER_KINDS as readonly string[]).includes(value);

export function assertDispatcherKind(value: unknown): DispatcherKind {
	if (!isDispatcherKind(value)) {
		throw new DispatcherError(
			`unknown dispatcher kind "${String(value)}" (known: ${DISPATCHER_KINDS.join("|")})`,
		);
	}
	return value;
}

const trimId = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * 归一化调用方标识。接受：
 *   - undefined / null → undefined（不声明调用方，台账不写 dispatchedBy）
 *   - "teamlead" → { kind: "teamlead", id?: fallbackId }
 *   - { kind: "teamlead", id: "…" } → 原样（id 去空白；缺省补 fallbackId）
 * 未知 kind、未知键、非对象非字符串一律抛 DispatcherError，绝不静默回退。
 */
export function normalizeDispatcher(
	value: unknown,
	fallbackId?: string,
): DispatcherIdentity | undefined {
	if (value === undefined || value === null) return undefined;
	const fallback = trimId(fallbackId);
	if (typeof value === "string") {
		const kind = assertDispatcherKind(value.trim());
		return fallback ? { kind, id: fallback } : { kind };
	}
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new DispatcherError('dispatcher must be a string kind or an object { kind, id? }');
	}
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (key !== "kind" && key !== "id") {
			throw new DispatcherError(`dispatcher has unknown key "${key}" (allowed: kind|id)`);
		}
	}
	const kind = assertDispatcherKind(record.kind);
	const id = trimId(record.id) || fallback;
	return id ? { kind, id } : { kind };
}
