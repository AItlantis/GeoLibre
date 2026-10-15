/** Origin / destination selector: All, one group of the selected grouping, or one centroid (typed "id - name"). */
import type { Selection } from "../../../_shared/src/sql/od-adapter.sql.ts";
import { parseSelection } from "./calc.ts";
import type { ViewEnv } from "./plugin.ts";
import { el, field, select } from "./ui.ts";

export interface SelState {
  kind: "all" | "group" | "centroid";
  value: string;
}

export const allSel = (): SelState => ({ kind: "all", value: "" });

export const toSelection = (s: SelState): Selection => parseSelection(s.kind, s.value);

/** Drop a stored selection that no longer exists in the current grouping. */
export function validSel(env: ViewEnv, s: SelState): SelState {
  if (s.kind === "group" && !env.ctl.state.groups.some((g) => g.name === s.value)) return allSel();
  return s;
}

export function selectorControl(env: ViewEnv, label: string, state: SelState, onChange: (s: SelState) => void, opts: { centroids?: boolean } = {}): HTMLElement {
  const { t, ctl } = env;
  const kinds: Array<{ value: string; label: string }> = [{ value: "all", label: t("sel.all", "All") }];
  if (ctl.state.groups.length) kinds.push({ value: "group", label: t("sel.group", "Group") });
  if (opts.centroids !== false) kinds.push({ value: "centroid", label: t("sel.centroid", "Centroid") });
  const wrap = el("div", { class: "ao-field" });
  const valueBox = el("div");
  const draw = (): void => {
    valueBox.replaceChildren();
    if (state.kind === "group") {
      valueBox.append(
        select(
          ctl.state.groups.map((g) => ({ value: g.name, label: g.name })),
          state.value,
          (v) => {
            state.value = v;
            onChange({ ...state });
          },
        ),
      );
    } else if (state.kind === "centroid") {
      const id = `ao-dl-${Math.random().toString(36).slice(2, 8)}`;
      const input = el("input", { class: "ao-input", attrs: { list: id, placeholder: t("sel.centroidPh", "id or name"), "aria-label": label } });
      input.value = state.value;
      const dl = el("datalist", { attrs: { id } });
      for (const c of ctl.state.centroids) dl.append(el("option", { attrs: { value: `${c.id} - ${c.name}` } }));
      input.addEventListener("change", () => {
        let v = input.value.trim();
        // typed a name: resolve to its id
        if (v && !/^\d/.test(v)) {
          const hit = ctl.state.centroids.find((c) => c.name.toLowerCase() === v.toLowerCase());
          if (hit) v = `${hit.id} - ${hit.name}`;
        }
        state.value = v;
        onChange({ ...state });
      });
      valueBox.append(input, dl);
    }
  };
  const kind = select(kinds, state.kind, (v) => {
    state.kind = v as SelState["kind"];
    state.value = v === "group" ? (ctl.state.groups[0]?.name ?? "") : "";
    draw();
    onChange({ ...state });
  });
  wrap.append(field(label, kind), valueBox);
  draw();
  return wrap;
}
