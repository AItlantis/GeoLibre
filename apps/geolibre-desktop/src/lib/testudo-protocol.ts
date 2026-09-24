export const TESTUDO_COMMANDS = ["testudoLoadPackage", "testudoSetPlugin", "testudoSetPreset", "testudoGetState"] as const;

/** A Testudo frame accepts only its exact same-origin parent, never a wildcard. */
export function acceptsTestudoMessage(event: Pick<MessageEvent, "source" | "origin" | "data">, parent: Window, origin: string, allowedOrigins: string[]): boolean {
  const request = event.data;
  return event.source === parent && event.origin === origin && allowedOrigins.includes(origin)
    && request?.v === 2 && request.source !== "geolibre" && typeof request.requestId === "string"
    && request.requestId.length > 0 && request.requestId.length <= 200
    && TESTUDO_COMMANDS.includes(request.type);
}
