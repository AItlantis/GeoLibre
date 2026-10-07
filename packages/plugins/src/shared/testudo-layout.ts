/** Testudo iframe-only renderer adaptations are gated by the host layout query. */
export function isTestudoLayout(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("layout") === "testudo";
}
