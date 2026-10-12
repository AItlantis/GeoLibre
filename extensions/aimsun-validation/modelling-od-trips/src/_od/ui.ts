/**
 * Plain-DOM helpers (a drop-in cannot share the host's React). Text is always set through textContent;
 * the only innerHTML is the SVG generated + escaped by _shared/src/charts.ts.
 * i18n: strings go through `app.translate("plugin.<id>.<key>", english)`; English ships as the default.
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
      /* fall through to English */
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

export interface Fmt {
  int: (v: number | null | undefined) => string;
  num: (v: number | null | undefined, digits?: number) => string;
  pct: (v: number | null | undefined, digits?: number) => string;
  signed: (v: number | null | undefined, digits?: number) => string;
}

export function makeFormat(locale: string): Fmt {
  let loc = locale;
  try {
    new Intl.NumberFormat(loc);
  } catch {
    loc = "en";
  }
  const nf = (d: number) => new Intl.NumberFormat(loc, { minimumFractionDigits: d, maximumFractionDigits: d });
  const ok = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
  return {
    int: (v) => (ok(v) ? nf(0).format(Math.round(v)) : "–"),
    num: (v, d = 1) => (ok(v) ? nf(d).format(v) : "–"),
    pct: (v, d = 1) => (ok(v) ? `${nf(d).format(v * 100)} %` : "–"),
    signed: (v, d = 0) => (ok(v) ? `${v > 0 ? "+" : ""}${nf(d).format(v)}` : "–"),
  };
}

export function select(options: Array<{ value: string; label: string }>, value: string, onChange: (v: string) => void, cls = "ao-input"): HTMLSelectElement {
  const s = el("select", { class: cls });
  for (const o of options) {
    const opt = el("option", { text: o.label, attrs: { value: o.value } });
    if (o.value === value) opt.selected = true;
    s.append(opt);
  }
  s.addEventListener("change", () => onChange(s.value));
  return s;
}

export function field(label: string, control: Node, cls = ""): HTMLElement {
  return el("label", { class: `ao-field ${cls}`.trim() }, [el("span", { class: "ao-label", text: label }), control]);
}

export function kpi(label: string, value: string, sub?: string): HTMLElement {
  return el("div", { class: "ao-kpi" }, [
    el("div", { class: "ao-kpi-v", text: value }),
    el("div", { class: "ao-kpi-l", text: label }),
    sub ? el("div", { class: "ao-kpi-s", text: sub }) : null,
  ]);
}

export interface Column<T> {
  label: string;
  value: (r: T) => string;
  num?: boolean;
  style?: (r: T) => string | undefined;
}

export function table<T>(cols: Array<Column<T>>, rows: readonly T[], onRow?: (r: T) => void, max = 200): HTMLElement {
  const thead = el("thead", {}, [el("tr", {}, cols.map((c) => el("th", { text: c.label, class: c.num ? "ao-num" : "" })))]);
  const tbody = el("tbody");
  for (const r of rows.slice(0, max)) {
    const tr = el(
      "tr",
      { class: onRow ? "ao-click" : "" },
      cols.map((c) => {
        const td = el("td", { text: c.value(r), class: c.num ? "ao-num" : "" });
        const st = c.style?.(r);
        if (st) td.setAttribute("style", st);
        return td;
      }),
    );
    if (onRow) tr.addEventListener("click", () => onRow(r));
    tbody.append(tr);
  }
  return el("div", { class: "ao-table-wrap" }, [el("table", { class: "ao-table" }, [thead, tbody])]);
}

export function section(title: string, body: Array<Node | null | false>, hint?: string): HTMLElement {
  return el("section", { class: "ao-section" }, [el("h3", { class: "ao-h", text: title }), hint ? el("p", { class: "ao-hint", text: hint }) : null, ...body]);
}

export function chartBox(svg: string): HTMLElement {
  const d = el("div", { class: "ao-chart" });
  d.innerHTML = svg; // generated and escaped by _shared/src/charts.ts
  return d;
}
