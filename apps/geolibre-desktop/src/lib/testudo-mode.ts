/** Testudo's signed-in iframe has no direct model or editing plugins. */
export const TESTUDO_BLOCKED_PLUGIN_IDS = ["maplibre-gl-geoagent", "maplibre-gl-geo-editor"] as const;

/** Whether the current URL selects the Testudo shell. */
export function isTestudoLayout(search?: string): boolean {
  const query = search ?? (typeof window === "undefined" ? "" : window.location.search);
  return new URLSearchParams(query).get("layout")?.trim().toLowerCase() === "testudo";
}

/** Reject direct assistant entry points inside the signed-in Testudo shell. */
export function assertAssistantAllowed(search?: string): void {
  if (isTestudoLayout(search)) throw new Error("The GeoLibre assistant is disabled in Testudo embeds.");
}
