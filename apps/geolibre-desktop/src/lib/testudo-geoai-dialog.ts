export type GeoAIDialogState = "idle" | "pending" | "answered" | "clarification-needed" | "unavailable" | "error";
export interface DialogPoint { x: number; y: number }
export interface GeoAIAction {
  type: "plugin" | "scenario" | "seek" | "mapControl" | "camera";
  label: string;
  value?: string | number | boolean | { center: [number, number]; zoom: number; bearing?: number; pitch?: number };
  controlId?: "legend" | "esri-world-imagery";
}
export interface GeoAIDialogSnapshot { open: boolean; collapsed: boolean; state: GeoAIDialogState; requestId: string | null }
export const INITIAL_GEOAI_DIALOG: GeoAIDialogSnapshot = { open: false, collapsed: false, state: "idle", requestId: null };

export function transitionGeoAIDialog(current: GeoAIDialogSnapshot, event:
  | { type: "open" } | { type: "close" } | { type: "collapse" } | { type: "expand" }
  | { type: "pending"; requestId: string } | { type: "cancel" }
  | { type: "reply"; requestId: string; kind: "answered" | "clarification-needed" | "unavailable" | "error" }
): GeoAIDialogSnapshot {
  if (event.type === "open") return { ...current, open: true };
  if (event.type === "close") return { ...current, open: false, state: "idle", requestId: null };
  if (event.type === "collapse") return { ...current, collapsed: true };
  if (event.type === "expand") return { ...current, collapsed: false };
  if (event.type === "pending") return { ...current, state: "pending", requestId: event.requestId };
  if (event.type === "cancel") return current.state === "pending" ? { ...current, state: "idle", requestId: null } : current;
  if (current.requestId !== event.requestId || current.state !== "pending") return current;
  return { ...current, state: event.kind, requestId: null };
}

export function clampDialogPosition(point: DialogPoint, viewport: { width: number; height: number }, size: { width: number; height: number }, margin = 8): DialogPoint {
  return {
    x: Math.max(margin, Math.min(point.x, Math.max(margin, viewport.width - size.width - margin))),
    y: Math.max(margin, Math.min(point.y, Math.max(margin, viewport.height - size.height - margin))),
  };
}

const CAPABILITIES = new Set(["vehicle-playback", "network-kpi", "path-analysis", "emissions-h3", "scenario-comparison"]);
export function validateGeoAIAction(value: unknown): GeoAIAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const action = value as Record<string, unknown>;
  if (typeof action.label !== "string" || !action.label.trim() || action.label.length > 80) return null;
  switch (action.type) {
    case "plugin": return typeof action.value === "string" && CAPABILITIES.has(action.value)
      ? { type: "plugin", label: action.label, value: action.value } : null;
    case "scenario": return typeof action.value === "string" && action.value.length > 0 && action.value.length <= 120
      ? { type: "scenario", label: action.label, value: action.value } : null;
    case "seek": return typeof action.value === "number" && Number.isFinite(action.value) && action.value >= 0 && action.value <= 1_000_000
      ? { type: "seek", label: action.label, value: action.value } : null;
    case "mapControl": return (action.controlId === "legend" || action.controlId === "esri-world-imagery") && typeof action.value === "boolean"
      ? { type: "mapControl", label: action.label, controlId: action.controlId, value: action.value } : null;
    case "camera": {
      const camera = action.value as Record<string, unknown> | null;
      if (!camera || !Array.isArray(camera.center) || camera.center.length !== 2
        || !camera.center.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
        || Math.abs(camera.center[0] as number) > 180 || Math.abs(camera.center[1] as number) > 90
        || typeof camera.zoom !== "number" || !Number.isFinite(camera.zoom) || camera.zoom < 0 || camera.zoom > 24
        || (camera.bearing !== undefined && (typeof camera.bearing !== "number" || !Number.isFinite(camera.bearing)))
        || (camera.pitch !== undefined && (typeof camera.pitch !== "number" || !Number.isFinite(camera.pitch) || camera.pitch < 0 || camera.pitch > 85))) return null;
      return { type: "camera", label: action.label, value: camera as unknown as Extract<GeoAIAction, { type: "camera" }>["value"] };
    }
    default: return null;
  }
}

const STORAGE_KEY = "testudo-geoai-dialog:v1";
export function readDialogPreferences(storage: Pick<Storage, "getItem"> | null): { position?: DialogPoint; collapsed?: boolean } {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return {};
    const value = JSON.parse(raw) as Record<string, unknown>;
    const position = value.position as Record<string, unknown> | undefined;
    return {
      ...(position && Number.isFinite(position.x) && Number.isFinite(position.y)
        ? { position: { x: position.x as number, y: position.y as number } } : {}),
      ...(typeof value.collapsed === "boolean" ? { collapsed: value.collapsed } : {}),
    };
  } catch { return {}; }
}
export function writeDialogPreferences(storage: Pick<Storage, "setItem"> | null, preferences: { position: DialogPoint; collapsed: boolean }): void {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch { /* Private browsing and storage quotas are optional. */ }
}

export function classifyGeoAIReply(reply: { content?: unknown; error?: unknown }): "answered" | "clarification-needed" | "unavailable" | "error" {
  if (typeof reply.error === "string") {
    if (/please clarify|need more detail|more detail/i.test(reply.error)) return "clarification-needed";
    if (/unavailable|ollama|ollaya/i.test(reply.error)) return "unavailable";
    return "error";
  }
  return typeof reply.content === "string" && reply.content.trim() ? "answered" : "error";
}

export function buildGeoAIRequestDetail(input: {
  localRequestId: string; tviewId: string; question: string; scenarioId?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}): Record<string, unknown> {
  const messages = input.messages.slice(-20).map(({ role, content }) => ({ role, content: content.slice(-4_000) }));
  const encodedPrior = () => new TextEncoder().encode(JSON.stringify(messages.slice(0, -1))).length;
  while (messages.length > 1 && encodedPrior() > 10_000) messages.shift();
  return {
    type: "request", localRequestId: input.localRequestId, tviewId: input.tviewId,
    question: input.question.slice(0, 4_000),
    ...(input.scenarioId ? { scenarioId: input.scenarioId.slice(0, 120) } : {}), messages,
  };
}
