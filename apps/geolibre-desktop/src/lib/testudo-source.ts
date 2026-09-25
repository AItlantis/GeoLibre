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
