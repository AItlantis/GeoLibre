// P2: manifest sha256 of the OD files is verified by streaming (no 35 MB buffer in the JS heap).
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { OdController } from "../src/_od/controller.ts";
import { buildIndex, itemsFromManifest, type Src } from "../src/_od/source.ts";
import { verifySrcHash } from "../src/_od/verify.ts";
import { openNodeDb } from "./node-db.ts";

const ROOT = process.env.AIMSUN_DATA_DIR;
const big = ROOT ? join(ROOT, "AMPK_3", "od_after.parquet") : "";
const haveBig = !!ROOT && existsSync(big);

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const urlSrc = (url: string, sha256?: string): Src => ({ name: "r/od_before.parquet", kind: "url", url, sha256 });

/** fetch that serves bytes as a chunked stream (64 KiB chunks, like a network body), never one buffer. */
const streamFetch = (bytes: Uint8Array, flipAt = -1, counter?: { maxChunk: number }): typeof fetch =>
  (async () => {
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(ctl) {
        if (i >= bytes.length) return ctl.close();
        const chunk = bytes.slice(i, Math.min(bytes.length, i + 65536));
        if (flipAt >= i && flipAt < i + chunk.length) chunk[flipAt - i] ^= 0x01;
        if (counter) counter.maxChunk = Math.max(counter.maxChunk, chunk.length);
        i += chunk.length;
        ctl.enqueue(chunk);
      },
    });
    return new Response(body);
  }) as unknown as typeof fetch;

test("verifySrcHash: matching hash -> verified; one flipped bit -> mismatch error; no hash -> undeclared", async () => {
  const bytes = new Uint8Array(500_000).map((_, i) => (i * 31 + 7) & 255);
  const good = sha(bytes);
  const ok = await verifySrcHash(urlSrc("http://x/a", good), streamFetch(bytes));
  assert.equal(ok.state, "verified");
  assert.equal(ok.bytes, bytes.length);
  await assert.rejects(verifySrcHash(urlSrc("http://x/a", good), streamFetch(bytes, 123_456)), /sha256 mismatch for r\/od_before\.parquet/);
  assert.equal((await verifySrcHash(urlSrc("http://x/a"), streamFetch(bytes))).state, "undeclared");
  assert.equal((await verifySrcHash(urlSrc("http://x/a", good.toUpperCase()), streamFetch(bytes))).state, "verified");
  await assert.rejects(verifySrcHash(urlSrc("http://x/a", "zz"), streamFetch(bytes)), /64-digit hex/);
  await assert.rejects(verifySrcHash(urlSrc("http://x/a", good), (async () => new Response("", { status: 404 })) as unknown as typeof fetch), /HTTP 404/);
});

test("verifySrcHash on a picked File/Blob streams it too", async () => {
  const bytes = new Uint8Array(200_000).map((_, i) => (i * 13) & 255);
  const src: Src = { name: "f.parquet", kind: "file", file: new Blob([bytes]), sha256: sha(bytes) };
  assert.equal((await verifySrcHash(src)).state, "verified");
  const bad: Src = { ...src, file: new Blob([bytes.slice(0, 199_999)]) };
  await assert.rejects(verifySrcHash(bad), /sha256 mismatch/);
});

test("controller: a corrupted OD file stops the load with the mismatch message; declared+good hashes are reported verified; undeclared ones are flagged", async () => {
  const mk = (sha256?: string): Src => ({ name: "A/od_before.parquet", kind: "url", url: "unused", sha256 });
  const idx = (before: Src) =>
    buildIndex("t", [
      { path: "A/od_before.parquet", run: "A", src: before },
      { path: "A/od_after.parquet", run: "A", src: { name: "A/od_after.parquet", kind: "url", url: "unused" } },
      { path: "A/centroids.geojson", run: "A", src: { name: "A/centroids.geojson", kind: "url", url: "unused" } },
    ]);
  const data = new TextEncoder().encode("not really parquet");
  const verify = (src: Src) => verifySrcHash(src, streamFetch(data));
  const { db } = await openNodeDb();
  const c = new OdController(db, { verify });
  await c.loadIndex(idx(mk("1".repeat(64))));
  assert.equal(c.state.phase, "error");
  assert.match(c.state.message, /sha256 mismatch for A\/od_before\.parquet/);
  assert.equal(c.state.hashes.length, 0);
  await c.dispose();
  // no verify function injected: a declared hash is reported as unverified (never silently trusted)
  const { db: db2 } = await openNodeDb();
  const c2 = new OdController(db2);
  await c2.loadIndex(idx(mk(sha(data)))); // fails later on the fake parquet, after the hash step
  assert.ok(["error", "ready"].includes(c2.state.phase));
  assert.deepEqual(c2.state.hashes.map((h) => [h.name, h.state]), [["A/od_before.parquet", "unverified"], ["A/od_after.parquet", "undeclared"], ["A/centroids.geojson", "undeclared"]]);
  await c2.dispose();
});

test("manifest sha256 reaches the Src (files[], outputs{}, outputs_sha256{})", async () => {
  const h = "ab".repeat(32);
  const m = { schema_version: 1, run: "A", files: [{ path: "A/od_before.parquet", sha256: h }], outputs: { "A/od_after.parquet": { sha256: h } }, outputs_sha256: { "A/centroids.geojson": h } };
  const { items } = await itemsFromManifest("http://x/d/manifest.json", m, async () => false);
  assert.equal(items.length, 3);
  assert.ok(items.every((i) => i.src.sha256 === h));
});

test("real 35 MB od_after.parquet: streaming SHA-256 equals node:crypto, a corrupted copy is rejected; timing reported", { skip: !haveBig && "AIMSUN_DATA_DIR unset or data not found", timeout: 120_000 }, async () => {
  const size = statSync(big).size;
  const expected = createHash("sha256").update(readFileSync(big)).digest("hex");
  const fetchFile = (flip = -1): typeof fetch =>
    (async () => {
      const web = Readable.toWeb(createReadStream(big)) as unknown as ReadableStream<Uint8Array>;
      if (flip < 0) return new Response(web);
      let off = 0;
      const t = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          if (flip >= off && flip < off + chunk.length) {
            chunk = chunk.slice();
            chunk[flip - off] ^= 0xff;
          }
          off += chunk.length;
          ctl.enqueue(chunk);
        },
      });
      return new Response(web.pipeThrough(t));
    }) as unknown as typeof fetch;
  const heap0 = process.memoryUsage().arrayBuffers;
  const t0 = performance.now();
  const r = await verifySrcHash(urlSrc("file", expected), fetchFile());
  const ms = performance.now() - t0;
  const heapGrowth = process.memoryUsage().arrayBuffers - heap0;
  assert.equal(r.state, "verified");
  assert.equal(r.bytes, size);
  console.log(`# streaming sha256 of ${(size / 1e6).toFixed(1)} MB od_after.parquet: ${ms.toFixed(0)} ms (${(size / 1e6 / (ms / 1000)).toFixed(0)} MB/s); arrayBuffers growth ${(heapGrowth / 1e6).toFixed(1)} MB`);
  await assert.rejects(verifySrcHash(urlSrc("file", expected), fetchFile(20_000_000)), /sha256 mismatch/);
});
