/**
 * 角色选择覆盖配置（THU-119.1 / S0）。
 *
 * 唯一支持的覆盖文件：仓库根 `.pi/secretary-roles.json`，形状：
 *   { "roles": { "researcher": { "candidates": [{ "kind": "codex", "model": "gpt-6.1-sol", "effort": "high" }] } } }
 *
 * 只允许覆盖候选（role → agent 映射）；prompt / 权限 / fallback 触发属于契约，
 * 不进配置文件。任何未知键、未知角色、空候选都抛错并指名出错位置。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type RoleCandidate,
	ROLE_IDS,
	type RoleId,
	RoleRegistryError,
	assertKind,
	assertModel,
	assertEffort,
	assertSandbox,
	assertWireApi,
	isRoleId,
} from "./registry";

export const ROLE_OVERRIDES_RELATIVE_PATH = ".pi/secretary-roles.json";

export interface RoleOverride {
	candidates: RoleCandidate[];
}

export type RoleOverrides = Partial<Record<RoleId, RoleOverride>>;

export interface LoadedRoleOverrides {
	/** 命中并成功解析的配置文件绝对路径；没有则为 undefined。 */
	path?: string;
	overrides: RoleOverrides;
}

const CANDIDATE_KEYS = new Set(["kind", "model", "effort", "sandbox", "wireApi"]);

function assertPlainObject(value: unknown, where: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new RoleRegistryError(`${where} must be a JSON object`);
	}
	return value as Record<string, unknown>;
}

function assertKnownKeys(value: Record<string, unknown>, allowed: Set<string>, where: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) {
			throw new RoleRegistryError(`${where} has unknown key "${key}" (allowed: ${[...allowed].join("|")})`);
		}
	}
}

export function parseRoleOverrides(raw: unknown, source = ROLE_OVERRIDES_RELATIVE_PATH): RoleOverrides {
	const root = assertPlainObject(raw, source);
	assertKnownKeys(root, new Set(["roles"]), source);
	const roles = assertPlainObject(root.roles ?? {}, `${source}#roles`);
	const overrides: RoleOverrides = {};

	for (const [roleId, roleValue] of Object.entries(roles)) {
		if (!isRoleId(roleId)) {
			throw new RoleRegistryError(
				`${source}#roles has unknown role "${roleId}" (known: ${ROLE_IDS.join("|")})`,
			);
		}
		const role = assertPlainObject(roleValue, `${source}#roles.${roleId}`);
		assertKnownKeys(role, new Set(["candidates"]), `${source}#roles.${roleId}`);
		if (!Array.isArray(role.candidates) || role.candidates.length === 0) {
			throw new RoleRegistryError(`${source}#roles.${roleId}.candidates must be a non-empty array`);
		}
		const candidates = role.candidates.map((candidate, index) => {
			const where = `${source}#roles.${roleId}.candidates[${index}]`;
			const entry = assertPlainObject(candidate, where);
			assertKnownKeys(entry, CANDIDATE_KEYS, where);
			const parsed: RoleCandidate = {
				kind: assertKind(entry.kind),
				model: assertModel(entry.model),
				effort: assertEffort(entry.effort),
			};
			if (entry.sandbox !== undefined) parsed.sandbox = assertSandbox(entry.sandbox);
			if (entry.wireApi !== undefined) parsed.wireApi = assertWireApi(entry.wireApi);
			return parsed;
		});
		overrides[roleId] = { candidates };
	}

	return overrides;
}

/**
 * 从 cwd 向上找 `.pi/secretary-roles.json`（与身份正文同一套向上搜索策略）。
 * 文件不存在返回空覆盖；解析失败不吞错。
 */
export function loadRoleOverrides(cwd: string): LoadedRoleOverrides {
	let dir = cwd;
	for (;;) {
		const candidate = join(dir, ROLE_OVERRIDES_RELATIVE_PATH);
		if (existsSync(candidate)) {
			let raw: unknown;
			try {
				raw = JSON.parse(readFileSync(candidate, "utf8"));
			} catch (error) {
				throw new RoleRegistryError(`failed to parse ${candidate}: ${(error as Error).message}`);
			}
			return { path: candidate, overrides: parseRoleOverrides(raw, candidate) };
		}
		const parent = join(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	return { overrides: {} };
}
