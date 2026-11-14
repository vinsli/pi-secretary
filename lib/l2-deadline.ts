import type { Clock } from "./types";

type Entry = { deadline: number; payload: unknown };
export interface DeadlineTracker {
  add(id: string, deadline: number, payload?: unknown): void;
  set(id: string, deadline: number, payload?: unknown): void;
  resolve(id: string): boolean;
  poll(): string[];
  pending(): number;
}

export function createDeadlineTracker(options: { clock: Clock; enqueue: (payload: unknown) => unknown }): DeadlineTracker {
  const entries = new Map<string, Entry>();
  const add = (id: string, deadline: number, payload?: unknown) => {
    if (!Number.isFinite(deadline)) throw new RangeError("deadline must be finite");
    entries.set(id, { deadline, payload });
  };
  return {
    add, set: add,
    resolve(id) { return entries.delete(id); },
    poll() {
      const now = options.clock.now(); const expired: string[] = [];
      for (const [id, entry] of entries) {
        if (entry.deadline > now) continue;
        const payload = entry.payload;
        const message = payload && typeof payload === "object" && payload !== null
          ? { ...(payload as Record<string, unknown>), id }
          : { id, payload };
        let accepted = true;
        try { accepted = options.enqueue(message) !== false; } catch { accepted = false; }
        if (accepted) {
          if (entries.get(id) === entry) entries.delete(id);
          expired.push(id);
        }
      }
      return expired;
    },
    pending: () => entries.size,
  };
}

export function deadlineExpired(deadline: number, now: number): boolean { return now >= deadline; }
export const DeadlineTracker = createDeadlineTracker;
