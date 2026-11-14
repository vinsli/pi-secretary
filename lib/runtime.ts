import type {
  ActionSpec,
  Clock,
  JobSpec,
  RuntimeStatus,
  SecretaryRuntimeOptions,
  SubscriptionHandler,
} from "./types";

type TimerHandle = unknown;
type NormalizedJobSpec = JobSpec & { maxFires?: number; intervalMs?: number; delayMs?: number };
type Job = { id: string; spec: NormalizedJobSpec; fires: number; maxFires: number; handle?: TimerHandle };
type Subscription = { id: string; source: string; handler: SubscriptionHandler };

const noop = () => {};
const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function requireNonNegativeInteger(value: unknown, name: string, max?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < 0 || (max !== undefined && value > max)) {
    const bound = max === undefined ? "a non-negative integer" : `an integer between 0 and ${max}`;
    throw new RangeError(`${name} must be ${bound}`);
  }
  return value;
}

function readRequiredNumber(raw: Record<string, unknown>, names: string[], label: string): number {
  let selected: number | undefined;
  for (const name of names) {
    if (!hasOwn(raw, name)) continue;
    const value = raw[name];
    if (typeof value !== "number" || !Number.isFinite(value)) throw new RangeError(`${label} must be a finite number`);
    selected ??= value;
  }
  if (selected === undefined) throw new RangeError(`${label} must be a finite number`);
  return selected;
}

function readOptionalNumber(raw: Record<string, unknown>, names: string[], label: string): number | undefined {
  let selected: number | undefined;
  for (const name of names) {
    if (!hasOwn(raw, name)) continue;
    const value = raw[name];
    if (typeof value !== "number" || !Number.isFinite(value)) throw new RangeError(`${label} must be a finite number`);
    selected ??= value;
  }
  return selected;
}

function normalizeSpec(spec: JobSpec): { spec: NormalizedJobSpec; maxFires: number } {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) throw new RangeError("job spec must be an object");
  const raw = spec as unknown as Record<string, unknown>;
  const action = raw.action;
  if (typeof action !== "object" || action === null || Array.isArray(action) ||
      !["notify", "emit", "enqueue_secretary"].includes((action as Record<string, unknown>).type as string)) {
    throw new RangeError("unsupported action type");
  }
  if (spec.kind === "interval") {
    const intervalMs = readRequiredNumber(raw, ["intervalMs", "interval", "interval_ms"], "interval");
    if (intervalMs < 1000) throw new RangeError("interval must be at least 1000ms");
    const maxFires = readOptionalNumber(raw, ["maxFires", "max_fires"], "maxFires") ?? 1000;
    if (!Number.isInteger(maxFires) || maxFires < 1 || maxFires > 1000) {
      throw new RangeError("maxFires must be an integer between 1 and 1000");
    }
    return { spec: { ...spec, intervalMs, maxFires }, maxFires };
  }
  if (spec.kind === "delay") {
    const delayMs = readRequiredNumber(raw, ["delayMs", "delay", "delay_ms"], "delay");
    if (delayMs < 0) throw new RangeError("delay must be non-negative");
    return { spec: { ...spec, delayMs }, maxFires: 1 };
  }
  if (spec.kind === "at") {
    const at = readRequiredNumber(raw, ["at"], "at");
    return { spec: { ...spec, at }, maxFires: 1 };
  }
  throw new RangeError("unsupported job kind");
}

export interface SecretaryRuntime {
  addJob(spec: JobSpec): string;
  schedule(spec: JobSpec): string;
  cancelJob(id: string): boolean;
  subscribe(source: string, handler: SubscriptionHandler): string | false;
  unsubscribe(id: string): boolean;
  publish(source: string, event: unknown): void;
  observe(source: string, event: unknown): void;
  enqueueSecretary(payload: unknown): boolean;
  flush(): boolean;
  setBusy(busy: boolean): void;
  agentSettled(): void;
  requestWake(event: unknown): boolean;
  queueState(): { size: number; dropCount: number; capacity: number };
  status(): RuntimeStatus;
  runtimeStatus(): RuntimeStatus;
  destroy(): void;
  shutdown(): void;
}

export function createSecretaryRuntime(options: SecretaryRuntimeOptions): SecretaryRuntime {
  if (typeof options?.clock?.now !== "function") throw new TypeError("clock.now must be a function");
  const clock = options.clock;
  const uiSink = options.uiSink ?? noop;
  const busSink = options.busSink ?? noop;
  const sendSink = options.sendSink ?? noop;
  const capacity = requireNonNegativeInteger(options.queueCapacity === undefined ? 32 : options.queueCapacity, "queueCapacity", 32);
  if (capacity < 1) throw new RangeError("queueCapacity must be an integer between 1 and 32");
  const wakeCooldownMs = requireNonNegativeInteger(options.wakeCooldownMs === undefined ? 60_000 : options.wakeCooldownMs, "wakeCooldownMs");
  const wakeBudget = requireNonNegativeInteger(options.wakeBudget === undefined ? 100 : options.wakeBudget, "wakeBudget");
  const jobs = new Map<string, Job>();
  const subscriptions = new Map<string, Subscription>();
  const queue: unknown[] = [];
  const wakeTimes = new Map<string, number>();
  let dropCount = 0;
  let sequence = 0;
  let subscriptionSequence = 0;
  let generation = 0;
  let busy = false;
  let wakeCount = 0;
  let pendingWakeCount = 0;
  const pendingWakeKeys = new Set<string>();
  let closed = false;

  const clearJobTimer = (job: Job) => {
    if (job.handle !== undefined) clock.clearTimeout?.(job.handle);
    job.handle = undefined;
  };

  const scheduleTimer = (fn: () => void, delay: number): TimerHandle => {
    if (typeof clock.setTimeout !== "function") throw new Error("clock.setTimeout is required to schedule jobs");
    return clock.setTimeout(fn, Math.max(0, delay));
  };

  const execute = (job: Job, token: number) => {
    if (closed || token !== generation || !jobs.has(job.id)) return;
    const action = job.spec.action as ActionSpec;
    try {
      if (action.type === "notify") uiSink({ message: action.message, level: action.level ?? "info" });
      else if (action.type === "emit") busSink(action.event);
      else enqueueSecretary(action.payload);
    } catch {
      clearJobTimer(job);
      jobs.delete(job.id);
      return;
    }
    if (closed || token !== generation || !jobs.has(job.id)) return;
    job.fires++;
    if (job.spec.kind === "interval" && job.fires < job.maxFires) {
      job.handle = scheduleTimer(() => execute(job, token), job.spec.intervalMs as number);
    } else {
      clearJobTimer(job);
      jobs.delete(job.id);
    }
  };

  const addJob = (input: JobSpec): string => {
    if (closed) throw new Error("secretary runtime is shut down");
    const normalized = normalizeSpec(input);
    if (jobs.size >= 16) throw new Error("maximum active jobs is 16");
    if (typeof clock.setTimeout !== "function") throw new Error("clock.setTimeout is required to schedule jobs");
    const id = `job-${++sequence}`;
    const job: Job = { id, spec: normalized.spec, fires: 0, maxFires: normalized.maxFires };
    const token = generation;
    const delay = job.spec.kind === "interval"
      ? job.spec.intervalMs as number
      : job.spec.kind === "delay"
        ? job.spec.delayMs as number
        : Math.max(0, (job.spec.at as number) - clock.now());
    job.handle = scheduleTimer(() => execute(job, token), delay);
    jobs.set(id, job);
    return id;
  };

  const flush = (): boolean => {
    if (queue.length === 0 || busy || closed) return false;
    const items = queue.splice(0, queue.length);
    const notice = { type: "secretary_notice", items, dropCount };
    try {
      sendSink(notice);
    } catch {
      if (!closed) {
        queue.unshift(...items);
        while (queue.length > capacity) { queue.shift(); dropCount++; }
      }
      return false;
    }
    return true;
  };

  const enqueueSecretary = (payload: unknown): boolean => {
    if (closed) return false;
    if (queue.length >= capacity) { queue.shift(); dropCount++; }
    queue.push(payload);
    return busy || flush();
  };

  const requestWake = (event: unknown): boolean => {
    if (closed || typeof event !== "object" || event === null || Array.isArray(event)) return false;
    const record = event as Record<string, unknown>;
    if (record.type === "secretary_notice") return false;
    const key = String(record.key ?? record.logicalId ?? record.type ?? "default");
    if (wakeCount + pendingWakeCount >= wakeBudget || pendingWakeKeys.has(key)) return false;
    const now = clock.now();
    const previous = wakeTimes.get(key);
    if (previous !== undefined && now - previous < wakeCooldownMs) return false;
    pendingWakeCount++; pendingWakeKeys.add(key);
    try {
      sendSink({ type: "wake", event });
    } catch {
      pendingWakeCount--; pendingWakeKeys.delete(key);
      return false;
    }
    pendingWakeCount--; pendingWakeKeys.delete(key);
    if (closed) return false;
    wakeTimes.set(key, now); wakeCount++;
    return true;
  };

  const status = (): RuntimeStatus => {
    const activeJobs = [...jobs.values()].map((job) => ({ id: job.id, kind: job.spec.kind, fires: job.fires, maxFires: job.maxFires }));
    return {
      jobs: activeJobs,
      subscriptions: [...subscriptions.values()].map(({ id, source }) => ({ id, source })),
      queue: { size: queue.length, dropCount, capacity },
      wake: { used: wakeCount, budget: wakeBudget, cooldownMs: wakeCooldownMs },
      generation,
      closed,
    };
  };

  const destroy = () => {
    if (closed) return;
    generation++;
    for (const job of jobs.values()) clearJobTimer(job);
    jobs.clear(); subscriptions.clear(); queue.length = 0; closed = true;
  };

  return {
    addJob,
    schedule: addJob,
    cancelJob(id) {
      const job = jobs.get(id);
      if (!job) return false;
      clearJobTimer(job); jobs.delete(id); return true;
    },
    subscribe(source, handler) {
      if (closed) return false;
      if (typeof handler !== "function") throw new TypeError("subscription handler must be a function");
      const sourceCount = [...subscriptions.values()].filter((subscription) => subscription.source === source).length;
      if (sourceCount >= 8) return false;
      const id = `subscription-${++subscriptionSequence}`;
      subscriptions.set(id, { id, source, handler });
      return id;
    },
    unsubscribe(id) { return subscriptions.delete(id); },
    publish(source, event) {
      if (closed) return;
      for (const subscription of subscriptions.values()) {
        if (closed) return;
        if (subscription.source === source) subscription.handler(event);
      }
    },
    observe(source, event) {
      if (closed) return;
      for (const subscription of subscriptions.values()) {
        if (closed) return;
        if (subscription.source === source) subscription.handler(event);
      }
    },
    enqueueSecretary,
    flush,
    setBusy(value) { busy = value; if (!busy) flush(); },
    agentSettled() { busy = false; flush(); },
    requestWake,
    queueState: () => ({ size: queue.length, dropCount, capacity }),
    status,
    runtimeStatus: status,
    destroy,
    shutdown: destroy,
  };
}

export const createRuntime = createSecretaryRuntime;
