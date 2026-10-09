import { useCallback, useEffect, useLayoutEffect, useState } from "react";

export type ThemeMode = "light" | "dark";

export function hostedThemeFromMessage(event: { source: MessageEventSource | null; origin: string; data: unknown }, parent: MessageEventSource | null, parentOrigin: string): ThemeMode | null {
  if (event.source !== parent || !parentOrigin || event.origin !== parentOrigin || !event.data || typeof event.data !== "object") return null;
  const message = event.data as { source?: unknown; type?: unknown; theme?: unknown };
  return message.source === "testudo" && message.type === "testudoThemeChanged"
    && (message.theme === "light" || message.theme === "dark") ? message.theme : null;
}

export function getInitialThemeMode(): ThemeMode {
  if (typeof window === "undefined") {
    return "light";
  }

  // An explicit `?theme=dark` / `?theme=light` overrides the OS preference on
  // load (handy for embeds); the in-app toggle still works afterwards.
  const themeParam = new URLSearchParams(window.location.search).get("theme")?.trim().toLowerCase();
  if (themeParam === "dark" || themeParam === "light") {
    return themeParam;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useThemeMode() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(getInitialThemeMode);

  useEffect(() => {
    if (typeof window === "undefined" || window.parent === window) return;
    let parentOrigin = "";
    try { parentOrigin = document.referrer ? new URL(document.referrer).origin : ""; } catch { /* An invalid referrer cannot authorize theme updates. */ }
    if (!parentOrigin) return;
    const onMessage = (event: MessageEvent<unknown>) => {
      const next = hostedThemeFromMessage(event, window.parent, parentOrigin);
      if (next) setThemeMode(next);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useLayoutEffect(() => {
    const isDark = themeMode === "dark";
    document.documentElement.classList.toggle("dark", isDark);
    document.documentElement.style.colorScheme = themeMode;
  }, [themeMode]);

  const toggleThemeMode = useCallback(() => {
    setThemeMode((currentThemeMode) => (currentThemeMode === "dark" ? "light" : "dark"));
  }, []);

  return { themeMode, toggleThemeMode };
}
