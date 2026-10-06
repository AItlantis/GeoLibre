import type { VehicleDirectoryHandle, VehiclePackageSource } from "@geolibre/plugins";
import { TESTUDO_GUEST_TOKEN_RE } from "./testudo-protocol";

export function packagePath(value: string): string {
  let decoded = value;
  for (let i = 0; i < 4; i++) {
    const next = decodeURIComponent(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  if (!decoded || /[\\?#:\u0000-\u001f]/.test(decoded) || decoded.split("/").some(p => !p || p === "." || p === "..")) {
    throw new Error("Invalid package artifact path");
  }
  return decoded;
}

export interface SignedSourceOptions {
  origin: string;
  artifactEndpoint: string;
  bearerToken?: string;
  guestEmbedToken?: string;
  getGuestEmbedToken?: () => string;
  byteOrigins: string[];
  signal: AbortSignal;
  fetch?: typeof fetch;
}

/** No base URL: DuckDB must consume authenticated buffers, never bypass this source. */
export function createSignedPackageSource(options: SignedSourceOptions): VehiclePackageSource {
  const guest = typeof options.guestEmbedToken === "string" || typeof options.getGuestEmbedToken === "function";
  if (guest === Boolean(options.bearerToken) || (typeof options.guestEmbedToken === "string" && !TESTUDO_GUEST_TOKEN_RE.test(options.guestEmbedToken))) {
    throw new Error("Provide exactly one valid Testudo package credential");
  }
  const endpoint = new URL(options.artifactEndpoint, options.origin);
  if (endpoint.origin !== options.origin || !/^\/api\/v1\/view\/[^/]+\/artifact\/$/.test(endpoint.pathname) || endpoint.search || endpoint.hash) {
    throw new Error("Invalid Testudo artifact endpoint");
  }
  const request = options.fetch ?? fetch;
  const guestToken = () => {
    const token = options.getGuestEmbedToken?.() ?? options.guestEmbedToken;
    if (!token || !TESTUDO_GUEST_TOKEN_RE.test(token)) throw new Error("Guest package capability expired; reload this demo to continue.");
    return token;
  };
  // The bootstrap validation and the selected plugin both read these immutable
  // package manifests. Reuse their bytes so loading does not repeat signed URL
  // issuance and a second cross-origin transfer for the same package.
  const metadataReads = new Map<string, Promise<ArrayBuffer>>();
  const readArtifact = async (path: string): Promise<ArrayBuffer> => {
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(60_000)]);
    const relative = path.split("/").map(encodeURIComponent).join("/");
    for (let attempt = 0; attempt < 2; attempt++) {
      const descriptorResponse = await request(new URL(relative, endpoint), {
        headers: { Authorization: guest ? `Testudo-Embed ${guestToken()}` : `Bearer ${options.bearerToken}` },
        signal, cache: "no-store", credentials: "omit", redirect: "error",
      });
      if (!descriptorResponse.ok) throw new Error(`Package permission or artifact lookup failed (${descriptorResponse.status})`);
      const descriptor = await descriptorResponse.json() as { url?: string; signed_url?: string; expires_at?: number };
      const signed = new URL(descriptor.url ?? descriptor.signed_url ?? "");
      if (!options.byteOrigins.includes(signed.origin) || signed.username || signed.password
        || (signed.protocol !== "https:" && !(signed.protocol === "http:" && ["localhost", "127.0.0.1"].includes(signed.hostname)))
        || (guest && (signed.search || signed.hash))) {
        throw new Error("Untrusted package byte origin");
      }
      if (!Number.isFinite(descriptor.expires_at)) throw new Error("Invalid signed artifact expiry");
      if (descriptor.expires_at! * 1000 <= Date.now() && attempt === 0) continue;
      const response = await request(signed, { signal, credentials: "omit", redirect: "error", cache: "no-store",
        ...(guest ? { headers: { Authorization: `Testudo-Embed ${guestToken()}` } } : {}) });
      if ([401, 403].includes(response.status) && attempt === 0) continue;
      if (!response.ok) throw new Error(`Package artifact read failed (${response.status})`);
      return response.arrayBuffer();
    }
    throw new Error("Package artifact signature expired");
  };
  return {
    baseUrl: null,
    async read(path) {
      const canonical = packagePath(path);
      if (canonical !== "manifest.json" && canonical !== "geolibre/package.json") return readArtifact(canonical);
      let task = metadataReads.get(canonical);
      if (!task) {
        task = readArtifact(canonical);
        metadataReads.set(canonical, task);
        void task.catch(() => { if (metadataReads.get(canonical) === task) metadataReads.delete(canonical); });
      }
      return task;
    },
  };
}

/** Read-only adapter for the existing native directory loaders; no filesystem access. */
export function sourceDirectory(source: VehiclePackageSource, name: string, prefix = ""): VehicleDirectoryHandle {
  return {
    name,
    async getFileHandle(file) {
      const path = packagePath(prefix + file);
      return { async getFile() { return new Blob([await source.read(path)]); } };
    },
    async getDirectoryHandle(directory) {
      const path = packagePath(prefix + directory);
      return sourceDirectory(source, name, path + "/");
    },
  };
}

/** Credential-free byte source whose parent resolves each artifact in its private auth closure. */
export function createParentProxiedPackageSource(options: {
  parent: Window;
  allowedOrigins: string[];
  targetOrigin: () => string | null;
  challenge: string;
  tviewId: string;
  generation: () => number;
  signal?: AbortSignal;
  timeoutMs?: number;
}): VehiclePackageSource {
  let sequence = 0;
  const pending = new Map<string, { generation: number; path: string; resolve: (bytes: ArrayBuffer) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const onMessage = (event: MessageEvent) => {
    if (event.source !== options.parent || !options.allowedOrigins.includes(event.origin)) return;
    const data = event.data;
    if (!data || data.v !== 2 || data.source !== "testudo" || data.type !== "testudoArtifactResponse" || !data.payload) return;
    const response = data.payload as Record<string, unknown>;
    if (containsCredentialField(response) || response.challenge !== options.challenge || typeof response.requestId !== "string" || typeof response.tviewId !== "string"
      || typeof response.generation !== "number" || typeof response.artifactRef !== "string") return;
    const operation = pending.get(response.requestId);
    if (!operation || operation.generation !== response.generation || operation.path !== response.artifactRef
      || options.tviewId !== response.tviewId || options.generation() !== response.generation) return;
    pending.delete(response.requestId); clearTimeout(operation.timer);
    if (response.bytes instanceof ArrayBuffer) operation.resolve(response.bytes);
    else operation.reject(new Error(typeof response.error === "string" ? response.error.slice(0, 1000) : "Artifact response was invalid."));
  };
  const abortPending = () => {
    if (typeof window !== "undefined") window.removeEventListener("message", onMessage);
    for (const operation of pending.values()) { clearTimeout(operation.timer); operation.reject(new Error("Package artifact request was cancelled.")); }
    pending.clear();
  };
  if (typeof window !== "undefined") window.addEventListener("message", onMessage);
  options.signal?.addEventListener("abort", abortPending, { once: true });
  return {
    baseUrl: null,
    async read(path) {
      const artifactRef = packagePath(path);
      const targetOrigin = options.targetOrigin();
      if (!targetOrigin || !options.allowedOrigins.includes(targetOrigin)) throw new Error("The Testudo host origin is not allowlisted.");
      const generation = options.generation();
      const requestId = `testudo-artifact-${Date.now()}-${++sequence}`;
      if (options.signal?.aborted) throw new Error("Package artifact request was cancelled.");
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error("Timed out waiting for host package artifact.")); }, options.timeoutMs ?? 60_000);
        pending.set(requestId, { generation, path: artifactRef, resolve, reject, timer });
        options.parent.postMessage({ v: 2, source: "geolibre", type: "testudoArtifactRequest", payload: { challenge: options.challenge, requestId, tviewId: options.tviewId, generation, artifactRef } }, targetOrigin);
      });
    },
  };
}

function containsCredentialField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCredentialField);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => /authorization|token|credential|password|secret/i.test(key) || containsCredentialField(child));
}
