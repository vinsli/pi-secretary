export interface Clock {
  now(): number;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
}

export type ActionSpec =
  | { type: "notify"; message: string; level?: "info" | "warning" | "error" }
  | { type: "emit"; event: unknown }
  | { type: "enqueue_secretary"; payload: unknown };

export type JobSpec =
  | { kind: "interval"; intervalMs?: number; interval?: number; interval_ms?: number; action: ActionSpec; maxFires?: number; max_fires?: number }
  | { kind: "delay"; delayMs?: number; delay?: number; delay_ms?: number; action: ActionSpec }
  | { kind: "at"; at: number; action: ActionSpec };

export type SubscriptionHandler = (event: unknown) => void;

export interface SecretaryRuntimeOptions {
  clock: Clock;
  uiSink?: (value: unknown) => void;
  busSink?: (value: unknown) => void;
  sendSink?: (value: unknown) => void;
  queueCapacity?: number;
  wakeCooldownMs?: number;
  wakeBudget?: number;
}

export interface RuntimeJobStatus {
  id: string;
  kind: JobSpec["kind"];
  fires: number;
  maxFires: number;
}

export interface RuntimeSubscriptionStatus {
  id: string;
  source: string;
}

export interface RuntimeStatus {
  jobs: RuntimeJobStatus[];
  subscriptions: RuntimeSubscriptionStatus[];
  queue: { size: number; dropCount: number; capacity: number };
  wake: { used: number; budget: number; cooldownMs: number };
  generation: number;
  closed: boolean;
}
