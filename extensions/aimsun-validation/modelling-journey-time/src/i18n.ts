/**
 * Localization for a drop-in plugin: its UI is plain DOM, so it cannot use the host's react-i18next.
 * Per docs/i18n.md and docs/plugin-api.md ("Following the app language") the host gives
 * getLocale / onLocaleChange / translate; keys are namespaced `plugin.<plugin-id>.<key>` and the
 * English text is ALWAYS passed as the default (the host catalogs do not ship these strings).
 */
import type { HostApp } from "./host";

export type Params = Record<string, string | number>;

export function interpolate(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

export interface Translator {
  (key: string, defaultValue: string, params?: Params): string;
  locale(): string;
}

export function makeTranslator(pluginId: string, getApp: () => HostApp | null): Translator {
  const t = ((key: string, defaultValue: string, params?: Params): string => {
    const app = getApp();
    const out = app?.translate?.(`plugin.${pluginId}.${key}`, defaultValue, params);
    return typeof out === "string" && out ? out : interpolate(defaultValue, params);
  }) as Translator;
  t.locale = () => getApp()?.getLocale?.() ?? "en";
  return t;
}
