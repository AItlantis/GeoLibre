import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bot, ChevronUp, LoaderCircle, MessageCircle, Minus, Send, X } from "lucide-react";
import {
  buildGeoAIRequestDetail, clampDialogPosition, classifyGeoAIReply, INITIAL_GEOAI_DIALOG, readDialogPreferences,
  transitionGeoAIDialog, validateGeoAIAction, writeDialogPreferences,
  type DialogPoint, type GeoAIAction,
} from "../../lib/testudo-geoai-dialog";

type Message = { role: "user" | "assistant"; content: string; clarification?: boolean; actions?: GeoAIAction[]; actionContext?: { tviewId: string; generation: number } };
type ViewerState = { tviewId: string; generation: number; package: { packageId: string; versionId: string | null; label: string } | null; selectedPlugin: string | null; scenarioId?: string };
const MAX_CHARS = 4_000;
const MAX_TURNS = 10;

function emitCommand(detail: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent("testudo-geoai-command", { detail }));
}
function sessionStorageOrNull(): Storage | null {
  try { return window.sessionStorage; } catch { return null; }
}

export function TestudoGeoAIDialog() {
  const preferences = useMemo(() => readDialogPreferences(typeof window === "undefined" ? null : sessionStorageOrNull()), []);
  const [dialog, setDialog] = useState(() => ({ ...INITIAL_GEOAI_DIALOG, collapsed: preferences.collapsed ?? false }));
  const [position, setPosition] = useState<DialogPoint>(preferences.position ?? { x: 24, y: 72 });
  const [viewer, setViewer] = useState<ViewerState | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const dragRef = useRef<{ pointerX: number; pointerY: number; origin: DialogPoint } | null>(null);
  const localRequestRef = useRef<string | null>(null);
  const cancelledLocalsRef = useRef(new Set<string>());
  const wasOpenRef = useRef(false);

  const persist = useCallback((nextPosition = position, collapsed = dialog.collapsed) => {
    writeDialogPreferences(sessionStorageOrNull(), { position: nextPosition, collapsed });
  }, [dialog.collapsed, position]);
  const open = useCallback(() => {
    setDialog((current) => transitionGeoAIDialog(current, { type: "open" }));
    emitCommand({ type: "state" });
  }, []);
  const cancelPending = useCallback(() => {
    const requestId = dialog.requestId;
    if (requestId?.startsWith("local-")) {
      cancelledLocalsRef.current.add(requestId);
      emitCommand({ type: "cancel-local", localRequestId: requestId });
    } else if (requestId) emitCommand({ type: "cancel", requestId });
    localRequestRef.current = null;
    setDialog((current) => transitionGeoAIDialog(current, { type: "cancel" }));
  }, [dialog.requestId]);
  const close = useCallback(() => {
    cancelPending();
    setDialog((current) => transitionGeoAIDialog(current, { type: "close" }));
  }, [cancelPending]);
  const collapse = useCallback(() => {
    setDialog((current) => transitionGeoAIDialog(current, { type: "collapse" }));
    persist(position, true);
  }, [persist, position]);

  useEffect(() => {
    emitCommand({ type: "state" });
    const onState = (event: Event) => {
      const state = (event as CustomEvent<ViewerState>).detail;
      if (state && typeof state.tviewId === "string" && state.package) setViewer(state);
    };
    const onAccepted = (event: Event) => {
      const accepted = (event as CustomEvent<{ requestId: string; localRequestId: string }>).detail;
      if (!accepted?.requestId || !accepted.localRequestId) return;
      if (cancelledLocalsRef.current.delete(accepted.localRequestId)) {
        emitCommand({ type: "cancel", requestId: accepted.requestId });
        return;
      }
      localRequestRef.current = null;
      setDialog((current) => current.requestId?.startsWith("local-")
        ? transitionGeoAIDialog(current, { type: "pending", requestId: accepted.requestId }) : current);
    };
    const onReply = (event: Event) => {
      const reply = (event as CustomEvent<{ requestId: string; tviewId: string; generation: number; content?: string; error?: string; proposedActions?: unknown[] }>).detail;
      if (!reply || reply.tviewId !== viewer?.tviewId || reply.generation !== viewer?.generation) return;
      const kind = classifyGeoAIReply(reply);
      setDialog((current) => transitionGeoAIDialog(current, { type: "reply", requestId: reply.requestId, kind }));
      const actionChips = kind === "answered" && Array.isArray(reply.proposedActions)
        ? reply.proposedActions.slice(0, 8).map(validateGeoAIAction).filter((action): action is GeoAIAction => action !== null) : [];
      setMessages((items) => [...items, {
        role: "assistant", content: kind === "answered" ? reply.content!.trim() : reply.error ?? "The request could not be completed.",
        clarification: kind === "clarification-needed", ...(actionChips.length ? {
          actions: actionChips, actionContext: { tviewId: reply.tviewId, generation: reply.generation },
        } : {}),
      }].slice(-MAX_TURNS * 2));
      if (kind === "unavailable" || kind === "error") setErrorMessage(reply.error ?? "GeoAI is unavailable.");
    };
    const onError = (event: Event) => {
      const detail = (event as CustomEvent<{ message: string; localRequestId?: string }>).detail;
      if (detail?.localRequestId) {
        setDialog((current) => current.state === "pending" && current.requestId === detail.localRequestId
          ? transitionGeoAIDialog(current, { type: "reply", requestId: detail.localRequestId!, kind: "error" }) : current);
      }
      setErrorMessage(detail?.message ?? "GeoAI request failed.");
    };
    window.addEventListener("testudo-geoai-state", onState);
    window.addEventListener("testudo-geoai-accepted", onAccepted);
    window.addEventListener("testudo-geoai-reply", onReply);
    window.addEventListener("testudo-geoai-error", onError);
    return () => {
      window.removeEventListener("testudo-geoai-state", onState);
      window.removeEventListener("testudo-geoai-accepted", onAccepted);
      window.removeEventListener("testudo-geoai-reply", onReply);
      window.removeEventListener("testudo-geoai-error", onError);
    };
  }, [viewer?.generation, viewer?.tviewId]);

  useEffect(() => {
    if (dialog.open && !dialog.collapsed) composerRef.current?.focus();
    if (!dialog.open && wasOpenRef.current) openButtonRef.current?.focus();
    wasOpenRef.current = dialog.open;
  }, [dialog.open, dialog.collapsed]);

  useEffect(() => {
    if (!dialog.open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (dialog.collapsed) close(); else collapse();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dialog.open, dialog.collapsed, close, collapse]);

  useEffect(() => {
    if (!dialog.open || dialog.collapsed) return;
    const onResize = () => setPosition((old) => {
      const rect = panelRef.current?.getBoundingClientRect();
      const next = clampDialogPosition(old, { width: window.innerWidth, height: window.innerHeight }, { width: rect?.width ?? 400, height: rect?.height ?? 480 });
      persist(next);
      return next;
    });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [dialog.open, dialog.collapsed, persist]);

  useEffect(() => {
    if (!dialog.open || dialog.collapsed || window.innerWidth <= 480) return;
    const rect = panelRef.current?.getBoundingClientRect();
    const next = clampDialogPosition(position, { width: window.innerWidth, height: window.innerHeight },
      { width: rect?.width ?? 400, height: rect?.height ?? 480 });
    if (next.x !== position.x || next.y !== position.y) {
      setPosition(next);
      persist(next);
    }
  }, [dialog.open, dialog.collapsed, position, persist]);

  const send = useCallback((text: string) => {
    const question = text.trim();
    if (!question || question.length > MAX_CHARS || dialog.state === "pending" || !viewer) return;
    const nextMessages: Message[] = [...messages, { role: "user", content: question }].slice(-MAX_TURNS * 2);
    setMessages(nextMessages);
    setDraft("");
    setErrorMessage("");
    const localId = `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    localRequestRef.current = localId;
    setDialog((current) => transitionGeoAIDialog(current, { type: "pending", requestId: localId }));
    emitCommand(buildGeoAIRequestDetail({ localRequestId: localId, tviewId: viewer.tviewId, question,
      ...(viewer.scenarioId ? { scenarioId: viewer.scenarioId } : {}),
      messages: nextMessages.map(({ role, content }) => ({ role, content })) }));
  }, [dialog.state, messages, viewer]);

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    dragRef.current = { pointerX: event.clientX, pointerY: event.clientY, origin: position };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    const point = { x: dragRef.current.origin.x + event.clientX - dragRef.current.pointerX, y: dragRef.current.origin.y + event.clientY - dragRef.current.pointerY };
    const rect = panelRef.current?.getBoundingClientRect();
    const next = clampDialogPosition(point, { width: window.innerWidth, height: window.innerHeight }, { width: rect?.width ?? 400, height: rect?.height ?? 480 });
    setPosition(next);
  };
  const stopDrag = () => { dragRef.current = null; persist(position); };

  return <>
    {!dialog.open ? <button ref={openButtonRef} type="button" aria-label="Open GeoAI assistant" onClick={open}
      className="fixed bottom-5 right-5 z-[80] flex h-12 w-12 items-center justify-center rounded-full border bg-background text-foreground shadow-lg hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <MessageCircle aria-hidden="true" className="h-5 w-5" />
    </button> : <section ref={panelRef} aria-label="GeoAI assistant" aria-live="polite"
      className={`fixed z-[80] flex min-h-[3.25rem] w-[min(400px,calc(100vw-16px))] flex-col overflow-hidden rounded-xl border bg-background text-foreground shadow-2xl ${dialog.collapsed ? "h-13" : "h-[min(560px,calc(100dvh-24px))] max-h-[calc(100dvh-16px)] max-[480px]:bottom-2 max-[480px]:left-2 max-[480px]:right-2 max-[480px]:top-auto max-[480px]:h-[min(72dvh,560px)]"}`}
      style={window.innerWidth > 480 ? { left: position.x, top: position.y } : undefined}>
      <div onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={stopDrag} onPointerCancel={stopDrag}
        className="flex min-h-12 touch-none cursor-move items-center gap-2 border-b px-3">
        <Bot aria-hidden="true" className="h-4 w-4 text-primary" /><strong className="flex-1 text-sm">GeoAI assistant</strong>
        <button type="button" aria-label={dialog.collapsed ? "Expand GeoAI assistant" : "Collapse GeoAI assistant"}
          onClick={() => dialog.collapsed ? (setDialog((current) => transitionGeoAIDialog(current, { type: "expand" })), persist(position, false)) : collapse()}
          className="rounded p-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{dialog.collapsed ? <ChevronUp className="h-4 w-4" /> : <Minus className="h-4 w-4" />}</button>
        <button type="button" aria-label="Close GeoAI assistant" onClick={close} className="rounded p-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><X className="h-4 w-4" /></button>
      </div>
      {!dialog.collapsed ? <>
        <div className="flex-1 space-y-3 overflow-y-auto p-3" aria-label="Conversation">
          {messages.length === 0 ? <div className="space-y-2 text-sm text-muted-foreground"><p>Ask about the current Testudo view.</p>
            <button className="rounded-lg border px-3 py-2 text-left text-foreground hover:bg-accent" onClick={() => send("Summarize the selected scenario.")}>Summarize the selected scenario</button></div> : null}
          {messages.map((message, index) => <div key={`${index}-${message.role}`} className={`max-w-[92%] rounded-xl px-3 py-2 text-sm ${message.role === "user" ? "ml-auto bg-primary text-primary-foreground" : message.clarification ? "border border-amber-500/50 bg-amber-500/10" : "bg-muted"}`}>
            <p className="whitespace-pre-wrap break-words">{message.content}</p>
            {message.actions?.length ? <div className="mt-2 flex flex-wrap gap-1.5">{message.actions.map((action, actionIndex) => <button key={`${action.type}-${actionIndex}`} type="button" className="rounded-full border bg-background px-2.5 py-1 text-xs hover:bg-accent" onClick={() => emitCommand({ type: "action", ...message.actionContext, actionType: action.type, value: action.value, ...(action.controlId ? { controlId: action.controlId } : {}) })}>{action.label}</button>)}</div> : null}
          </div>)}
          {dialog.state === "pending" ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><LoaderCircle className="h-4 w-4 animate-spin" />Thinking…<button type="button" onClick={cancelPending} className="ml-auto underline">Cancel</button></div> : null}
          {errorMessage ? <p role="status" className="text-sm text-destructive">{errorMessage}</p> : null}
        </div>
        <div className="border-t p-2">
          <div className="flex items-end gap-2 rounded-lg border bg-background p-2 focus-within:ring-2 focus-within:ring-ring">
            <textarea ref={composerRef} aria-label="Message GeoAI" rows={2} maxLength={MAX_CHARS} value={draft} onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); send(draft); } }}
              placeholder="Ask about this view…" className="max-h-28 min-h-10 flex-1 resize-none bg-transparent text-sm outline-none" />
            <span className="pb-1 text-[10px] text-muted-foreground">{draft.length}/{MAX_CHARS}</span>
            <button type="button" aria-label="Send message" disabled={!draft.trim() || dialog.state === "pending" || !viewer} onClick={() => send(draft)} className="rounded-md bg-primary p-2 text-primary-foreground disabled:opacity-50"><Send className="h-4 w-4" /></button>
          </div>
        </div>
      </> : null}
    </section>}
  </>;
}
