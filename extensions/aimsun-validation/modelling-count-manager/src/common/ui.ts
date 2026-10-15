/**
 * Plain-DOM helpers. Panels are rendered without any framework (a drop-in cannot share the
 * host's React). Text is always set through textContent; the only innerHTML is the SVG that
 * charts.ts generates and escapes.
 *
 * i18n: a drop-in cannot add keys to the host catalogs. Strings go through `app.translate`
 * with namespaced keys `plugin.<plugin-id>.<key>` and the English text as defaultValue
 * (docs/plugin-api.md, "Following the app language"); the English text is what ships today.
 */
import type { AppLike } from "./host.ts";

export type Translate = (key: string, en: string, params?: Record<string, string | number>) => string;

export function interpolate(text: string, params?: Record<string, string | number>): string {
  if (!params) return text;
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

export function makeTranslate(app: AppLike | null, pluginId: string): Translate {
  return (key, en, params) => {
    try {
      const r = app?.translate?.(`plugin.${pluginId}.${key}`, en, params);
      if (typeof r === "string" && r) return r;
    } catch {
      /* fall through to the English text */
    }
    return interpolate(en, params);
  };
}

type Child = Node | string | null | undefined | false;

export interface ElProps {
  class?: string;
  text?: string;
  attrs?: Record<string, string>;
  on?: Record<string, (e: Event) => void>;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: ElProps = {}, children: Child[] = []): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (props.class) n.className = props.class;
  if (props.text !== undefined) n.textContent = props.text;
  for (const [k, v] of Object.entries(props.attrs ?? {})) n.setAttribute(k, v);
  for (const [k, f] of Object.entries(props.on ?? {})) n.addEventListener(k, f);
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    n.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return n;
}

export function clear(n: Element): void {
  while (n.firstChild) n.removeChild(n.firstChild);
}

export function makeFormat(locale: string): {
  int: (v: number | null | undefined) => string;
  num: (v: number | null | undefined, digits?: number) => string;
  pct: (v: number | null | undefined, digits?: number) => string;
  signed: (v: number | null | undefined, digits?: number) => string;
} {
  let nf: (d: number) => Intl.NumberFormat;
  try {
    new Intl.NumberFormat(locale);
    const cache = new Map<number, Intl.NumberFormat>();
    nf = (d) => {
      let f = cache.get(d);
      if (!f) cache.set(d, (f = new Intl.NumberFormat(locale, { minimumFractionDigits: d, maximumFractionDigits: d })));
      return f;
    };
  } catch {
    nf = (d) => new Intl.NumberFormat(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  const fin = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
  return {
    int: (v) => (fin(v) ? nf(0).format(v) : "-"),
    num: (v, d = 1) => (fin(v) ? nf(d).format(v) : "-"),
    pct: (v, d = 1) => (fin(v) ? `${nf(d).format(v)}%` : "-"),
    signed: (v, d = 1) => (fin(v) ? `${v > 0 ? "+" : ""}${nf(d).format(v)}` : "-"),
  };
}

export const STATUS_COLORS = { pass: "#2e7d32", warn: "#f9a825", fail: "#c62828" } as const;

/** Escape-free helper for a labelled <select>. */
export function selectEl<T extends string | number>(
  options: ReadonlyArray<{ value: T; label: string }>,
  value: T,
  onChange: (v: string) => void,
  attrs: Record<string, string> = {},
): HTMLSelectElement {
  const s = el("select", { class: "av-input", attrs, on: { change: (e) => onChange((e.target as HTMLSelectElement).value) } });
  for (const o of options) {
    const opt = el("option", { text: o.label, attrs: { value: String(o.value) } });
    if (o.value === value) opt.selected = true;
    s.append(opt);
  }
  return s;
}

export function field(label: string, control: HTMLElement): HTMLElement {
  return el("label", { class: "av-field" }, [el("span", { class: "av-label", text: label }), control]);
}
