/** Testudo's embedded shell is selected by `?layout=testudo`. */
export function isTestudoLayout(search?: string): boolean {
  const query = search ?? (typeof window === "undefined" ? "" : window.location.search);
  return new URLSearchParams(query).get("layout")?.trim().toLowerCase() === "testudo";
}

/** Prevent the stock browser assistant from reaching any direct model path. */
export function assertAssistantAllowed(search?: string): void {
  if (isTestudoLayout(search)) {
    throw new Error("The GeoLibre assistant is disabled in Testudo embeds.");
  }
}
