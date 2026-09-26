import type { TestudoBootstrap, TestudoCapabilityId, TestudoDemoMode } from "@geolibre/embed";

const CAPABILITY_IDS: TestudoCapabilityId[] = ["vehicle-playback", "network-kpi", "path-analysis", "emissions-h3", "scenario-comparison"];
export const TESTUDO_COMMANDS = ["testudoSetGuestCapability", "testudoLoadPackage", "testudoSetPlugin", "testudoSetMode", "testudoSetPreset", "testudoGetState"] as const;
export const TESTUDO_DEMO_MODES: TestudoDemoMode[] = ["animation", "flow", "paths", "density"];

export const TESTUDO_CHALLENGE_RE = /^[a-f0-9]{32}$/;
export const TESTUDO_GUEST_TOKEN_RE = /^[A-Za-z0-9._~-]{32,4096}$/;

/** Validate the package envelope without filtering or copying its declared modes/presets. */
export function validateTestudoBootstrap(candidate: TestudoBootstrap, guest: boolean): TestudoBootstrap {
  if (!candidate || typeof candidate.versionId !== "string" || typeof candidate.packageId !== "string"
    || typeof candidate.label !== "string" || candidate.origin !== "published"
    || candidate.manifestPath !== "manifest.json" || candidate.nativeManifestPath !== "geolibre/package.json"
    || !Array.isArray(candidate.capabilities) || !Array.isArray(candidate.presets)
    || candidate.artifactEndpoint !== `/api/v1/view/${encodeURIComponent(candidate.versionId)}/artifact/`
    || candidate.capabilities.some(item => !CAPABILITY_IDS.includes(item.id) || typeof item.available !== "boolean")
    || candidate.presets.some(item => !item || typeof item.id !== "string" || !item.id || !CAPABILITY_IDS.includes(item.plugin))) {
    throw new Error("Invalid Testudo package bootstrap");
  }
  if (guest && (candidate.packageId !== "London/testudo-package-2026-09-24-website-demo-v1"
    || candidate.versionId !== "32787055-7258-45f0-8593-f8c53e1cc788")) {
    throw new Error("Guest capability is scoped to the published London demo");
  }
  return candidate;
}

/** Only the exact, allowlisted parent may send bounded Testudo commands. */
export function acceptsTestudoMessage(event: Pick<MessageEvent, "source" | "origin" | "data">, parent: Window, allowedOrigins: string[], challenge: string): boolean {
  const request = event.data;
  if (event.source !== parent || !allowedOrigins.includes(event.origin)
    || request?.v !== 2 || request.source !== "testudo" || typeof request.requestId !== "string"
    || request.requestId.length === 0 || request.requestId.length > 200 || !TESTUDO_COMMANDS.includes(request.type)) return false;
  if (request.type === "testudoSetGuestCapability") {
    const payload = request.payload;
    return payload?.protocol === 1 && payload.challenge === challenge && TESTUDO_CHALLENGE_RE.test(challenge)
      && typeof payload.guestEmbedToken === "string" && TESTUDO_GUEST_TOKEN_RE.test(payload.guestEmbedToken)
      && Number.isSafeInteger(payload.expiresAt) && payload.expiresAt > Date.now()
      && payload.expiresAt <= Date.now() + 10 * 60_000;
  }
  if (request.type === "testudoSetMode") return request.payload?.challenge === challenge
    && TESTUDO_DEMO_MODES.includes(request.payload?.mode);
  return request.payload?.challenge === challenge;
}

/** Return only the four package-backed modes surfaced by the website demo. */
export function availableTestudoModes(features: { animation: boolean; flow: boolean; paths: boolean; density: boolean }): TestudoDemoMode[] {
  return TESTUDO_DEMO_MODES.filter(mode => features[mode]);
}

/** Accept the legacy scalar index and package/scenario-scoped index maps. */
export function hasDeclaredPathIndex(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
}
