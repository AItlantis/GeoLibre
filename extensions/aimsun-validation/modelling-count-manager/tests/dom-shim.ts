/**
 * Minimal DOM stand-in for panel tests (no jsdom in this workspace): just enough of
 * document.createElement / createTextNode / append / attributes / querySelector([data-testid=..])
 * for the `el()` helper and the legend builders. Not a general DOM.
 */
class FakeText {
  readonly nodeType = 3;
  data: string;
  constructor(data: string) {
    this.data = data;
  }
  get textContent(): string {
    return this.data;
  }
}

class FakeElement {
  readonly nodeType = 1;
  className = "";
  readonly attributes = new Map<string, string>();
  childNodes: Array<FakeElement | FakeText> = [];
  readonly tagName: string;
  constructor(tagName: string) {
    this.tagName = tagName;
  }
  get children(): FakeElement[] {
    return this.childNodes.filter((n): n is FakeElement => n instanceof FakeElement);
  }
  get textContent(): string {
    return this.childNodes.map((n) => n.textContent).join("");
  }
  set textContent(v: string) {
    this.childNodes = [new FakeText(String(v))];
  }
  append(...nodes: Array<FakeElement | FakeText | string>): void {
    for (const n of nodes) this.childNodes.push(typeof n === "string" ? new FakeText(n) : n);
  }
  setAttribute(k: string, v: string): void {
    this.attributes.set(k, String(v));
  }
  getAttribute(k: string): string | null {
    return this.attributes.get(k) ?? null;
  }
  addEventListener(): void {}
  /** Supports `[data-testid="x"]` selectors (all the panel tests need). */
  querySelector(sel: string): FakeElement | null {
    const m = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel);
    if (!m) throw new Error(`dom-shim: unsupported selector ${sel}`);
    for (const c of this.children) {
      if (c.getAttribute(m[1]) === m[2]) return c;
      const deep = c.querySelector(sel);
      if (deep) return deep;
    }
    return null;
  }
}

/** Installs `document` on globalThis and returns a function that restores the previous value. */
export function installDomShim(): () => void {
  const g = globalThis as { document?: unknown };
  const prev = g.document;
  g.document = {
    createElement: (tag: string) => new FakeElement(tag),
    createTextNode: (s: string) => new FakeText(s),
  };
  return () => {
    if (prev === undefined) delete g.document;
    else g.document = prev;
  };
}
