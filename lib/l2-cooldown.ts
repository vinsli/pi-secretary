import type { Clock } from "./types";

export interface CooldownGate {
  allow(key?: string): boolean;
  remaining(key?: string): number;
  reset(key?: string): void;
}

function validateCooldown(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new RangeError("cooldownMs must be a finite non-negative integer");
  }
  return value;
}

export function createCooldownGate(options: { clock: Clock; cooldownMs?: number }): CooldownGate {
  const cooldownMs = validateCooldown(options.cooldownMs === undefined ? 60_000 : options.cooldownMs);
  const last = new Map<string, number>();
  const keyOf = (key?: string) => key ?? "default";
  return {
    allow(key) {
      const k = keyOf(key); const now = options.clock.now(); const previous = last.get(k);
      if (previous !== undefined && now - previous < cooldownMs) return false;
      last.set(k, now); return true;
    },
    remaining(key) {
      const previous = last.get(keyOf(key));
      return previous === undefined ? 0 : Math.max(0, cooldownMs - (options.clock.now() - previous));
    },
    reset(key) { if (key === undefined) last.clear(); else last.delete(key); },
  };
}

export function cooldownAllowed(lastAt: number | undefined, now: number, cooldownMs = 60_000): boolean {
  return lastAt === undefined || now - lastAt >= cooldownMs;
}

export const CooldownGate = createCooldownGate;
