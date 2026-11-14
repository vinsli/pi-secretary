import { describe, expect, test } from "bun:test";
import { createSecretaryRuntime } from "../lib/runtime";
import { classifyHerdrEvent } from "../lib/catalog";
import { createCooldownGate } from "../lib/l2-cooldown";
import { createDeadlineTracker } from "../lib/l2-deadline";
import type { ActionSpec, Clock, JobSpec } from "../lib/types";

class FakeClock implements Clock {
  current = 0;
  private next = 1;
  private timers = new Map<number, { at: number; fn: () => void }>();
  now = () => this.current;
  setTimeout = (fn: () => void, ms: number) => {
    const id = this.next++;
    this.timers.set(id, { at: this.current + Math.max(0, ms), fn });
    return id;
  };
  clearTimeout = (id: unknown) => { this.timers.delete(id as number); };
  pendingCount() { return this.timers.size; }
  advance(ms: number) {
    this.current += ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.current)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      due[1].fn();
    }
  }
}

const interval = (action: ActionSpec, extra: Partial<JobSpec> = {}): JobSpec => ({
  kind: "interval", intervalMs: 1000, action, ...extra,
});

function sinks() {
  return { ui: [] as unknown[], bus: [] as unknown[], sent: [] as unknown[] };
}

describe("Secretary runtime red/green contract", () => {
  test("runs interval, delay and at jobs through injected clock and action sinks", () => {
    const clock = new FakeClock();
    const out = sinks();
    const runtime = createSecretaryRuntime({
      clock, uiSink: (x) => out.ui.push(x), busSink: (x) => out.bus.push(x), sendSink: (x) => out.sent.push(x),
    });
    runtime.addJob(interval({ type: "notify", message: "tick" }, { maxFires: 2 }));
    runtime.addJob({ kind: "delay", delayMs: 500, action: { type: "emit", event: { kind: "delay" } } });
    runtime.addJob({ kind: "at", at: 1500, action: { type: "emit", event: { kind: "at" } } });
    clock.advance(500); clock.advance(500); clock.advance(500); clock.advance(1000);
    expect(out.ui).toHaveLength(2);
    expect(out.bus).toEqual([{ kind: "delay" }, { kind: "at" }]);
  });

  test("rejects invalid job bounds and sixteenth-plus active job", () => {
    const runtime = createSecretaryRuntime({ clock: new FakeClock() });
    expect(() => runtime.addJob(interval({ type: "notify", message: "bad" }, { intervalMs: 999 }))).toThrow();
    expect(() => runtime.addJob(interval({ type: "notify", message: "bad" }, { maxFires: 1001 }))).toThrow();
    expect(() => runtime.addJob({ kind: "delay", delayMs: 0, action: { type: "eval" } as any })).toThrow();
    for (let i = 0; i < 16; i++) runtime.addJob(interval({ type: "notify", message: String(i) }));
    expect(() => runtime.addJob(interval({ type: "notify", message: "overflow" }))).toThrow();
  });

  test("busy timers continue, idle flushes one merged notice, settled flushes queued work", () => {
    const clock = new FakeClock(); const out = sinks();
    const runtime = createSecretaryRuntime({ clock, sendSink: (x) => out.sent.push(x) });
    runtime.setBusy(true);
    runtime.addJob(interval({ type: "enqueue_secretary", payload: { id: 1 } }));
    runtime.addJob({ kind: "delay", delayMs: 1000, action: { type: "enqueue_secretary", payload: { id: 2 } } });
    clock.advance(1000);
    expect(out.sent).toHaveLength(0);
    runtime.setBusy(false);
    expect(out.sent).toHaveLength(1);
    expect((out.sent[0] as any).type).toBe("secretary_notice");
    expect((out.sent[0] as any).items).toHaveLength(2);
    runtime.setBusy(true); clock.advance(1000); runtime.agentSettled();
    expect(out.sent).toHaveLength(2);
  });

  test("queue drops oldest at 32 and reports dropCount", () => {
    const runtime = createSecretaryRuntime({ clock: new FakeClock(), queueCapacity: 32 });
    runtime.setBusy(true);
    for (let i = 0; i < 33; i++) runtime.enqueueSecretary({ id: i });
    expect(runtime.queueState()).toMatchObject({ size: 32, dropCount: 1 });
    runtime.setBusy(false);
    expect(runtime.queueState().size).toBe(0);
  });

  test("destroy and shutdown invalidate old generations", () => {
    const clock = new FakeClock(); const out = sinks();
    const runtime = createSecretaryRuntime({ clock, uiSink: (x) => out.ui.push(x) });
    runtime.addJob(interval({ type: "notify", message: "old" }));
    runtime.destroy(); clock.advance(5000);
    expect(out.ui).toEqual([]);
    expect(() => runtime.addJob(interval({ type: "notify", message: "dead" }))).toThrow();
  });

  test("reentrant action sinks do not reschedule destroyed or cancelled interval jobs", () => {
    const destroyClock = new FakeClock();
    let destroyed!: ReturnType<typeof createSecretaryRuntime>;
    destroyed = createSecretaryRuntime({ clock: destroyClock, uiSink: () => destroyed.destroy() });
    destroyed.addJob(interval({ type: "notify", message: "destroy" }));
    destroyClock.advance(1000);
    expect(destroyClock.pendingCount()).toBe(0);

    const cancelClock = new FakeClock();
    let cancelled!: ReturnType<typeof createSecretaryRuntime>;
    let cancelId = "";
    cancelled = createSecretaryRuntime({ clock: cancelClock, uiSink: () => expect(cancelled.cancelJob(cancelId)).toBe(true) });
    cancelId = cancelled.addJob(interval({ type: "notify", message: "cancel" }));
    cancelClock.advance(1000);
    expect(cancelClock.pendingCount()).toBe(0);
  });

  test("wake budget, cooldown and secretary_notice self-loop guard", () => {
    const clock = new FakeClock(); const out = sinks();
    const runtime = createSecretaryRuntime({ clock, sendSink: (x) => out.sent.push(x) });
    expect(runtime.requestWake({ type: "secretary_notice" })).toBe(false);
    expect(runtime.requestWake({ type: "ping" })).toBe(true);
    expect(runtime.requestWake({ type: "ping" })).toBe(false);
    clock.advance(60_000);
    expect(runtime.requestWake({ type: "ping" })).toBe(true);
    for (let i = 0; i < 98; i++) { clock.advance(60_000); runtime.requestWake({ type: "ping" }); }
    expect(runtime.requestWake({ type: "ping" })).toBe(false);
    expect(out.sent).toHaveLength(100);
  });

  test("requestWake only spends budget after a successful send", () => {
    const clock = new FakeClock(); let fail = true; const out = sinks();
    const runtime = createSecretaryRuntime({ clock, sendSink: (x) => { if (fail) throw new Error("wake failed"); out.sent.push(x); } });
    expect(runtime.requestWake({ type: "ping" })).toBe(false);
    expect(runtime.status().wake.used).toBe(0);
    fail = false;
    expect(runtime.requestWake({ type: "ping" })).toBe(true);
    expect(runtime.status().wake.used).toBe(1);
    expect(out.sent).toHaveLength(1);
  });

  test("catalog preserves structured Herdr evidence and does not parse plain text", () => {
    expect(classifyHerdrEvent({ customType: "PiStartedMetadata", id: "p1", name: "worker", task: "T", sessionFile: "/tmp/s", status: "started" })).toMatchObject({ layer: "dispatch", terminal: false, sessionFile: "/tmp/s" });
    expect(classifyHerdrEvent({ type: "PiStartedMetadata", id: "p1", name: "worker", task: "T", status: "started" }).layer).toBe("unknown");
    for (const field of ["id", "name", "task", "sessionFile"] as const) {
      const metadata = { customType: "PiStartedMetadata", id: "p1", name: "worker", task: "T", sessionFile: "/tmp/s", status: "started" };
      metadata[field] = "";
      expect(classifyHerdrEvent(metadata).layer).toBe("unknown");
    }
    for (const status of ["", "uncertain", "stopped", "started "]) {
      expect(classifyHerdrEvent({ customType: "PiStartedMetadata", id: "p1", name: "worker", task: "T", sessionFile: "/tmp/s", status }).layer).toBe("unknown");
    }
    expect(classifyHerdrEvent({ customType: "subagent_result", details: { exitCode: 0 } })).toMatchObject({ layer: "process_terminal", terminal: true });
    expect(classifyHerdrEvent({ customType: "subagent_result", details: { logicalId: "l1", generationId: "g1" } })).toMatchObject({ layer: "task_delivery", terminal: false });
    expect(classifyHerdrEvent({ customType: "subagent_result", details: { logicalId: "l1" } }).layer).toBe("unknown");
    expect(classifyHerdrEvent({ customType: "subagent_result", details: { logicalId: "l1", generationId: "g1", generationActive: false } }).layer).toBe("unknown");
    expect(classifyHerdrEvent({ customType: "subagent_result", details: { exitCode: null, logicalId: "l1", generationId: "g1" } }).layer).toBe("unknown");
    expect(classifyHerdrEvent({ customType: "subagent_result", details: { exitCode: "0" } }).layer).toBe("unknown");
    for (const exitCode of [NaN, Infinity, -Infinity, 1.5]) {
      expect(classifyHerdrEvent({ customType: "subagent_result", details: { exitCode } }).layer).toBe("unknown");
    }
    expect(classifyHerdrEvent({ type: "persistent-crash", status: "failed" })).toMatchObject({ layer: "process_terminal", terminal: true });
    expect(classifyHerdrEvent({ type: "subagent_stop", status: "stopped" })).toMatchObject({ layer: "process_terminal", terminal: true });
    for (const type of ["ping", "intercom", "presence"]) expect(classifyHerdrEvent({ type })).toMatchObject({ layer: "non_terminal", terminal: false });
    const unknown = classifyHerdrEvent("process exited with code 1");
    expect(unknown.layer).toBe("unknown"); expect(unknown.summary.length).toBeLessThanOrEqual(256);
  });

  test("runtime supports cancellation, subscriptions, observation and status", () => {
    const clock = new FakeClock(); const seen: unknown[] = [];
    const runtime = createSecretaryRuntime({ clock, wakeBudget: 0 });
    const id = runtime.addJob({ kind: "delay", delayMs: 5000, action: { type: "notify", message: "later" } });
    const subscription = runtime.subscribe("worker", (event) => seen.push(event));
    const extraSubscriptions = Array.from({ length: 7 }, () => runtime.subscribe("worker", () => {}));
    expect(extraSubscriptions.every(Boolean)).toBe(true);
    expect(runtime.subscribe("worker", () => {})).toBe(false);
    expect(runtime.subscribe("other", () => {})).toEqual("subscription-9");
    runtime.publish("worker", { id: 1 }); runtime.observe("worker", { id: 2 });
    expect(seen).toEqual([{ id: 1 }, { id: 2 }]);
    expect(runtime.unsubscribe(subscription as string)).toBe(true);
    expect(runtime.unsubscribe(subscription)).toBe(false);
    expect(runtime.unsubscribe("subscription-9")).toBe(true);
    for (const extra of extraSubscriptions) expect(runtime.unsubscribe(extra as string)).toBe(true);
    expect(runtime.cancelJob(id)).toBe(true);
    expect(runtime.cancelJob(id)).toBe(false);
    expect(runtime.status()).toMatchObject({
      jobs: [], subscriptions: [], queue: { size: 0, dropCount: 0, capacity: 32 },
      wake: { used: 0, budget: 0, cooldownMs: 60_000 }, generation: 0, closed: false,
    });
    expect(runtime.runtimeStatus()).toEqual(runtime.status());
  });

  test("rejects invalid runtime options, job numbers, and clocks without timers", () => {
    expect(() => createSecretaryRuntime({ clock: new FakeClock(), queueCapacity: 0 })).toThrow(RangeError);
    expect(() => createSecretaryRuntime({ clock: new FakeClock(), queueCapacity: 1.5 })).toThrow(RangeError);
    expect(() => createSecretaryRuntime({ clock: new FakeClock(), wakeBudget: -1 })).toThrow(RangeError);
    expect(() => createSecretaryRuntime({ clock: new FakeClock(), wakeCooldownMs: Infinity })).toThrow(RangeError);
    const clock = new FakeClock();
    const runtime = createSecretaryRuntime({ clock });
    expect(() => runtime.addJob(interval({ type: "notify", message: "bad" }, { intervalMs: NaN }))).toThrow(RangeError);
    expect(() => runtime.addJob({ kind: "delay", delayMs: Infinity, action: { type: "notify", message: "bad" } })).toThrow(RangeError);
    expect(() => runtime.addJob({ kind: "at", at: "now" as any, action: { type: "notify", message: "bad" } })).toThrow(RangeError);
    const noTimer = createSecretaryRuntime({ clock: { now: () => 0 } });
    expect(() => noTimer.addJob({ kind: "delay", delayMs: 0, action: { type: "notify", message: "bad" } })).toThrow(/setTimeout/);
    expect(createSecretaryRuntime({ clock: new FakeClock(), wakeBudget: 0 }).requestWake({ type: "ping" })).toBe(false);
  });

  test("retains queued data when send sink throws", () => {
    let fail = true;
    const runtime = createSecretaryRuntime({ clock: new FakeClock(), sendSink: () => { if (fail) throw new Error("sink failed"); } });
    runtime.setBusy(true); runtime.enqueueSecretary({ id: 1 }); runtime.setBusy(false);
    expect(runtime.queueState()).toMatchObject({ size: 1, dropCount: 0 });
    fail = false; expect(runtime.flush()).toBe(true);
    expect(runtime.queueState().size).toBe(0);
  });

  test("flush preserves the outer snapshot when a nested flush succeeds before outer failure", () => {
    const sent: any[] = []; let calls = 0;
    let runtime!: ReturnType<typeof createSecretaryRuntime>;
    runtime = createSecretaryRuntime({
      clock: new FakeClock(),
      sendSink: (notice) => {
        calls++;
        if (calls === 1) {
          runtime.enqueueSecretary({ id: 2 });
          throw new Error("outer flush failed");
        }
        sent.push(notice);
      },
    });
    runtime.setBusy(true);
    runtime.enqueueSecretary({ id: 1 });
    runtime.setBusy(false);
    expect(runtime.queueState().size).toBe(1);
    expect((sent[0] as any).items).toEqual([{ id: 2 }]);
    expect(runtime.flush()).toBe(true);
    expect((sent[1] as any).items).toEqual([{ id: 1 }]);
    expect(runtime.queueState().size).toBe(0);
  });

  test("flush reapplies capacity when an outer failure restores after nested success", () => {
    const sent: any[] = []; let calls = 0;
    let runtime!: ReturnType<typeof createSecretaryRuntime>;
    runtime = createSecretaryRuntime({
      clock: new FakeClock(), queueCapacity: 1,
      sendSink: (notice) => {
        calls++;
        if (calls === 1) {
          runtime.enqueueSecretary({ id: 2 });
          runtime.setBusy(true);
          runtime.enqueueSecretary({ id: 3 });
          throw new Error("outer flush failed");
        }
        sent.push(notice);
      },
    });
    runtime.setBusy(true);
    runtime.enqueueSecretary({ id: 1 });
    runtime.setBusy(false);
    expect(sent.map((notice) => notice.items)).toEqual([[{ id: 2 }]]);
    expect(runtime.queueState()).toMatchObject({ size: 1, dropCount: 1, capacity: 1 });
    runtime.setBusy(false);
    expect(sent.map((notice) => notice.items)).toEqual([[{ id: 2 }], [{ id: 3 }]]);
    expect(runtime.queueState()).toMatchObject({ size: 0, dropCount: 1, capacity: 1 });
  });

  test("maxFires stops interval jobs after the configured successful executions", () => {
    const clock = new FakeClock();
    const out: unknown[] = [];
    const runtime = createSecretaryRuntime({ clock, uiSink: (value) => out.push(value) });
    const id = runtime.addJob(interval({ type: "notify", message: "tick" }, { maxFires: 2 }));
    clock.advance(1000);
    expect(out).toHaveLength(1);
    expect(runtime.status().jobs[0]?.fires).toBe(1);
    clock.advance(1000);
    expect(out).toHaveLength(2);
    expect(runtime.status().jobs).toEqual([]);
    expect(clock.pendingCount()).toBe(0);
    expect(runtime.cancelJob(id)).toBe(false);
  });

  test("action sink failures stop jobs without escaping timer callbacks", () => {
    for (const [action, options] of [
      [{ type: "notify", message: "bad" } as ActionSpec, { uiSink: () => { throw new Error("ui failed"); } }],
      [{ type: "emit", event: { bad: true } } as ActionSpec, { busSink: () => { throw new Error("bus failed"); } }],
    ] as const) {
      const clock = new FakeClock();
      const runtime = createSecretaryRuntime({ clock, ...options });
      const id = runtime.addJob(interval(action));
      expect(() => clock.advance(1000)).not.toThrow();
      expect(runtime.status().jobs).toEqual([]);
      expect(runtime.cancelJob(id)).toBe(false);
      expect(clock.pendingCount()).toBe(0);
    }
  });

  test("destroy rejects new subscriptions and makes publish and observe no-ops", () => {
    const seen: unknown[] = [];
    const runtime = createSecretaryRuntime({ clock: new FakeClock() });
    runtime.subscribe("worker", (event) => seen.push(event));
    runtime.destroy();
    expect(runtime.subscribe("worker", (event) => seen.push(event))).toBe(false);
    runtime.publish("worker", { id: 1 });
    runtime.observe("worker", { id: 2 });
    expect(seen).toEqual([]);
  });

  test("retains expired deadlines when enqueue fails", () => {
    const clock = new FakeClock(); let fail = true;
    const tracker = createDeadlineTracker({ clock, enqueue: () => { if (fail) throw new Error("enqueue failed"); } });
    tracker.add("x", 1000, { type: "deadline" }); clock.advance(1000);
    expect(tracker.poll()).toEqual([]); expect(tracker.pending()).toBe(1);
    fail = false; expect(tracker.poll()).toEqual(["x"]); expect(tracker.pending()).toBe(0);
  });

  test("deadline poll preserves a reentrant replacement for the same id", () => {
    const clock = new FakeClock(); let reentered = false;
    let tracker!: ReturnType<typeof createDeadlineTracker>;
    tracker = createDeadlineTracker({
      clock,
      enqueue: () => {
        if (!reentered) { reentered = true; tracker.set("x", 2000, { type: "replacement" }); }
      },
    });
    tracker.add("x", 1000, { type: "initial" });
    clock.advance(1000);
    expect(tracker.poll()).toEqual(["x"]);
    expect(tracker.pending()).toBe(1);
    clock.advance(1000);
    expect(tracker.poll()).toEqual(["x"]);
    expect(tracker.pending()).toBe(0);
  });

  test("cooldown gate and deadline tracker are clock-injected and expire once", () => {
    const clock = new FakeClock(); const enqueued: unknown[] = [];
    const gate = createCooldownGate({ clock, cooldownMs: 60_000 });
    expect(gate.allow("worker")).toBe(true); expect(gate.allow("worker")).toBe(false);
    clock.advance(60_000); expect(gate.allow("worker")).toBe(true);
    const tracker = createDeadlineTracker({ clock, enqueue: (x) => enqueued.push(x) });
    tracker.add("a", 1000, { type: "deadline" });
    clock.advance(1000); expect(tracker.poll()).toEqual(["a"]); expect(tracker.poll()).toEqual([]);
    expect(enqueued).toEqual([{ type: "deadline", id: "a" }]);
    tracker.add("b", 5000, { type: "manual" }); tracker.resolve("b"); clock.advance(5000); expect(tracker.poll()).toEqual([]);
  });
});
