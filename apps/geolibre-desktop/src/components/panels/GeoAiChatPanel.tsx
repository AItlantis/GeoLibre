import {
  checkGeoAiAvailability,
  getGeoAiChatStatus,
  isGeoAiChatPanelVisible,
  closeGeoAiChatPanel,
  sendGeoAiChat,
  subscribeGeoAiChat,
  subscribeGeoAiChatPanel,
} from "@geolibre/plugins";
import { Button } from "@geolibre/ui";
import { Loader2, MessageCircle, Send, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

const PANEL_WIDTH = 340;
const EDGE_MARGIN = 12;

/**
 * Floating chat panel for the GeoAI capability (Testudo's `/api/v1/ai/chat`).
 *
 * Ported from the legacy viewer's `#ai-panel` (`geolibre-ai-plugin.js` +
 * `geolibre-ai-adapter.js`) for the GeoLibre-native path (issue #273). The legacy panel also
 * offers a "share as project comment" action and an approve/redeem flow for AI tool proposals
 * (navigate/select_section); this native port intentionally starts with the core chat loop
 * (input, send, response) that every other capability's panel matches in scope — the
 * tool-proposal flow is a natural follow-on, not required to close this gap.
 */
export function GeoAiChatPanel() {
  const visible = useSyncExternalStore(subscribeGeoAiChatPanel, isGeoAiChatPanelVisible, isGeoAiChatPanelVisible);
  if (!visible) return null;
  return <GeoAiChatCard />;
}

function GeoAiChatCard() {
  const { t } = useTranslation();
  const status = useSyncExternalStore(subscribeGeoAiChat, getGeoAiChatStatus, getGeoAiChatStatus);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => { void checkGeoAiAvailability(); }, []);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [status.messages.length]);

  const send = () => {
    const prompt = draft.trim();
    if (!prompt || status.loading) return;
    setDraft("");
    void sendGeoAiChat(prompt);
  };

  return (
    <div
      className="absolute bottom-3 end-3 z-30 flex flex-col rounded-lg border border-border map-glass shadow-lg"
      style={{ width: PANEL_WIDTH, maxHeight: 420 }}
      role="dialog"
      aria-label={t("toolbar.geoai.title", "GeoAI")}
    >
      <div className="flex items-center gap-2 rounded-t-lg border-b border-border bg-muted/40 px-3 py-2">
        <MessageCircle className="h-4 w-4 text-sky-500" />
        <span className="text-sm font-medium">{t("toolbar.geoai.title", "GeoAI")}</span>
        <Button variant="ghost" size="icon" className="ms-auto h-6 w-6" aria-label={t("toolbar.geoai.close", "Close")} onClick={() => closeGeoAiChatPanel()}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto px-3 py-2 text-sm" style={{ minHeight: 120, maxHeight: 280 }}>
        {status.messages.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {status.available
              ? t("toolbar.geoai.empty", "Ask a question about this package.")
              : t("toolbar.geoai.unavailable", "GeoAI is not available for this package.")}
          </p>
        )}
        {status.messages.map(message => (
          <div key={message.id} className={message.role === "user" ? "text-foreground" : message.role === "error" ? "text-destructive" : "text-foreground"}>
            <span className="me-1 text-xs font-medium text-muted-foreground">
              {message.role === "user" ? t("toolbar.geoai.you", "You") : message.role === "error" ? t("toolbar.geoai.errorLabel", "Error") : t("toolbar.geoai.assistant", "GeoAI")}
            </span>
            <span className="whitespace-pre-wrap">{message.text}</span>
          </div>
        ))}
      </div>

      {status.error && status.messages.length === 0 && <p role="alert" className="px-3 pb-1 text-xs text-destructive">{status.error}</p>}

      <div className="flex items-center gap-2 border-t border-border p-2">
        <input
          type="text"
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm"
          placeholder={t("toolbar.geoai.placeholder", "Ask GeoAI…")}
          aria-label={t("toolbar.geoai.placeholder", "Ask GeoAI…")}
          value={draft}
          disabled={status.loading}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        <Button variant="secondary" size="icon" className="h-8 w-8" aria-label={t("toolbar.geoai.send", "Send")} disabled={status.loading || draft.trim().length === 0} onClick={send}>
          {status.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}
