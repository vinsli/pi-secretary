export type EventLayer = "dispatch" | "process_terminal" | "task_delivery" | "non_terminal" | "unknown";

export interface CatalogedEvent {
  layer: EventLayer;
  category: EventLayer;
  terminal: boolean;
  summary: string;
  event: unknown;
  [key: string]: unknown;
}

const NON_TERMINAL = new Set(["ping", "intercom", "presence"]);
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const bounded = (value: unknown): string => {
  if (typeof value === "string") return value.slice(0, 256);
  try {
    const encoded = JSON.stringify(value);
    return (encoded === undefined ? String(value) : encoded).slice(0, 256);
  } catch { return "[unserializable event]"; }
};
const result = (layer: EventLayer, terminal: boolean, event: unknown, extra: Record<string, unknown> = {}): CatalogedEvent => ({ layer, category: layer, terminal, summary: bounded(event), event, ...extra });

export function classifyHerdrEvent(event: unknown): CatalogedEvent {
  if (!isRecord(event)) return result("unknown", false, event);
  const value = event;
  const type = typeof value.customType === "string" ? value.customType : typeof value.type === "string" ? value.type : typeof value.kind === "string" ? value.kind : "";
  const details = value.details;
  const payload = isRecord(details) ? details : value;
  if ((type === "PiStartedMetadata" || type === "pi_started") &&
      typeof payload.id === "string" && typeof payload.name === "string" && typeof payload.task === "string" &&
      typeof payload.sessionFile === "string" && payload.id.length > 0 && payload.name.length > 0 && payload.task.length > 0 &&
      payload.sessionFile.length > 0 && payload.status === "started") {
    return result("dispatch", false, event, {
      id: payload.id, name: payload.name, task: payload.task, sessionFile: payload.sessionFile, status: payload.status,
    });
  }
  // legacy 事件形状（pi-herdr-agents 时期的消息名）：派工现已走 Herdr 原生的
  // external_worker 工具，这些类型不再由工具层产生；保留分类能力以便旧会话/历史 artifact 仍能归档。
  if (type === "subagent_result" || type === "subagent-result") {
    if (!isRecord(details)) return result("unknown", false, event);
    const data = details;
    if (Object.prototype.hasOwnProperty.call(data, "exitCode")) {
      if (typeof data.exitCode === "number" && Number.isFinite(data.exitCode) && Number.isInteger(data.exitCode)) return result("process_terminal", true, event, { exitCode: data.exitCode });
      return result("unknown", false, event);
    }
    const logicalId = data.logicalId;
    const generationId = data.generationId;
    if (typeof logicalId === "string" && logicalId.length > 0 && typeof generationId === "string" && generationId.length > 0) {
      if (data.generationActive !== undefined && data.generationActive !== true) return result("unknown", false, event);
      return result("task_delivery", false, event);
    }
    return result("unknown", false, event);
  }
  const status = typeof payload.status === "string" ? payload.status : undefined;
  if (type === "persistent-crash" || (type === "subagent_stop" && status === "stopped")) return result("process_terminal", true, event);
  if (NON_TERMINAL.has(type)) return result("non_terminal", false, event);
  return result("unknown", false, event);
}

export const classifyEvent = classifyHerdrEvent;
export const catalogEvent = classifyHerdrEvent;
