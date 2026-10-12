/**
 * Manifest sha256 verification for the OD files WITHOUT pulling the 17-35 MB parquet into the JS heap.
 *
 * crypto.subtle.digest is one-shot (needs the whole file as one buffer), so the file is read as a stream
 * (fetch body / File.stream()) and fed chunk by chunk to the incremental pure-TS SHA-256 of
 * _shared/src/sha256.ts: peak extra memory is one network chunk. The cost is one extra sequential read of the
 * file (same-origin / local asset) before DuckDB registers it; timing is reported in the status.
 * A declared hash that does not match throws (the controller shows the error and loads nothing); a file
 * with no declared hash is reported as "undeclared" so the panel can say "hash not verified".
 */
import { Sha256 } from "../_shared/src/sha256.ts";
import type { Src } from "./source.ts";

export type HashState = "verified" | "undeclared" | "unverified";

export interface HashStatus {
  name: string;
  state: HashState;
  /** Wall time spent hashing, ms. */
  ms: number;
  bytes: number;
}

export type VerifyFn = (src: Src) => Promise<HashStatus>;

const HEX64 = /^[0-9a-f]{64}$/i;

export async function verifySrcHash(src: Src, fetchImpl: typeof fetch = fetch, now: () => number = () => performance.now()): Promise<HashStatus> {
  const name = src.name;
  if (!src.sha256) return { name, state: "undeclared", ms: 0, bytes: 0 };
  if (!HEX64.test(src.sha256)) throw new Error(`${name}: manifest sha256 is not a 64-digit hex string`);
  const t0 = now();
  const hasher = new Sha256();
  let bytes = 0;
  const feed = (c: Uint8Array): void => {
    hasher.update(c);
    bytes += c.length;
  };
  let stream: ReadableStream<Uint8Array> | null = null;
  if (src.kind === "file" && src.file) {
    stream = src.file.stream() as ReadableStream<Uint8Array>;
  } else if (src.url) {
    const res = await fetchImpl(src.url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`Could not fetch ${name} for hash verification: HTTP ${res.status}`);
    stream = res.body;
    if (!stream) feed(new Uint8Array(await res.arrayBuffer())); // no streaming body (rare): one buffer, still correct
  } else {
    throw new Error(`no source for ${name}`);
  }
  if (stream) {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) feed(value);
    }
  }
  const got = hasher.digestHex();
  if (got !== src.sha256.toLowerCase()) throw new Error(`sha256 mismatch for ${name}: expected ${src.sha256.toLowerCase()}, got ${got}`);
  return { name, state: "verified", ms: Math.round(now() - t0), bytes };
}
