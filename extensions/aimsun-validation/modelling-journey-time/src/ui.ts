/** Tiny DOM helpers + the package picker shared by both subpath plugins. All text goes through textContent. */
import type { Translator } from "./i18n";

type Attrs = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") e.className = String(v);
    else if (k === "text") e.textContent = String(v);
    else if (k in e && k !== "list") (e as unknown as Record<string, unknown>)[k] = v;
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) e.append(c);
  return e;
}

export const clear = (e: Element): void => e.replaceChildren();

export type Kind = "info" | "warn" | "error";

export function banner(kind: Kind, text: string, extra: Attrs = {}): HTMLElement {
  return el("div", { class: `avp-banner avp-${kind}`, role: kind === "error" ? "alert" : "note", ...extra }, text);
}

export const fmt = (v: number | null | undefined, digits = 1): string =>
  v === null || v === undefined || !Number.isFinite(v) ? "-" : v.toFixed(digits);

export interface PackageBar {
  root: HTMLElement;
  setStatus(text: string, kind?: Kind | "busy"): void;
  setUrl(url: string): void;
}

export function packageBar(o: {
  t: Translator;
  onUrl: (url: string) => void;
  onFiles: (files: File[]) => void;
  hint: string;
}): PackageBar {
  const { t } = o;
  const url = el("input", { type: "text", class: "avp-input", placeholder: "https://.../manifest.json", "aria-label": t("pkg.url", "Package manifest URL") });
  const load = el("button", { type: "button", class: "avp-btn", text: t("pkg.load", "Load") });
  const folder = el("input", { type: "file", class: "avp-file", "aria-label": t("pkg.folder", "Package folder") });
  folder.setAttribute("webkitdirectory", "");
  const files = el("input", { type: "file", multiple: true, class: "avp-file", accept: ".parquet,.json,.geojson", "aria-label": t("pkg.files", "Package files") });
  const status = el("div", { class: "avp-status", role: "status", "aria-live": "polite" });
  load.addEventListener("click", () => url.value.trim() && o.onUrl(url.value.trim()));
  url.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && url.value.trim()) o.onUrl(url.value.trim());
  });
  const pick = (input: HTMLInputElement) => () => {
    const list = [...(input.files ?? [])];
    input.value = "";
    if (list.length) o.onFiles(list);
  };
  folder.addEventListener("change", pick(folder));
  files.addEventListener("change", pick(files));
  const root = el(
    "section",
    { class: "avp-section", "data-avp": "package" },
    el("h3", { class: "avp-h", text: t("pkg.title", "Package") }),
    el("div", { class: "avp-row" }, url, load),
    el("label", { class: "avp-lbl" }, t("pkg.folder", "Package folder"), folder),
    el("label", { class: "avp-lbl" }, t("pkg.files", "Package files"), files),
    el("p", { class: "avp-hint", text: o.hint }),
    status,
  );
  return {
    root,
    setStatus(text, kind = "info") {
      status.textContent = text;
      status.dataset.kind = kind;
    },
    setUrl(u) {
      url.value = u;
    },
  };
}
