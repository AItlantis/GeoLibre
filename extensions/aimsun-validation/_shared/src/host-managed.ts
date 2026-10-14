/**
 * Host-managed mode shared by the Aimsun analysis plugins.
 *
 * When the Testudo analysis bridge opens a plugin (handleUrlParameters carries `aimsunHost=testudo`
 * next to `aimsunPackage` / `aimsunRun`), only the host may choose the package and the run: the panel
 * hides its own package picker and run selector and shows a read-only label instead. Standalone usage
 * (no host marker) is unchanged.
 */
export const HOST_PARAM = "aimsunHost";
export const HOST_TESTUDO = "testudo";

/** True when the URL parameters come from the Testudo analysis bridge. */
export function isHostOpen(params: { get(name: string): string | null }): boolean {
  return params.get(HOST_PARAM) === HOST_TESTUDO;
}

export interface PackageUiPlan {
  /** Folder button, manifest URL box, Load button and manifest help text. */
  showPackagePicker: boolean;
  /** The plugin's own run / scenario selector. */
  showRunSelector: boolean;
  /** Read-only "package / run" line fed by the host. */
  showHostLabel: boolean;
}

export function packageUiPlan(hostManaged: boolean): PackageUiPlan {
  return { showPackagePicker: !hostManaged, showRunSelector: !hostManaged, showHostLabel: hostManaged };
}

/** Read-only label, e.g. "Package: jumeira / Run: AMPK_3" (parts that are unknown are omitted). */
export function hostLabel(pkg: string | null | undefined, run: string | null | undefined, t: (key: string, fallback: string, vars?: Record<string, string | number>) => string): string {
  const parts: string[] = [];
  if (pkg) parts.push(t("host.package", "Package: {{label}}", { label: pkg }));
  if (run) parts.push(t("host.run", "Run: {{run}}", { run }));
  return parts.join(" / ");
}
