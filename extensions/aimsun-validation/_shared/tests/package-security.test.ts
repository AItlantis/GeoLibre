// P2: manifest paths must stay inside the package directory, also when hidden behind URL encoding.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { isSafePackagePath, loadPackage, packageBaseUrl, registerTable, resolveInsidePackage, validateManifest, uniqueSuffix } from "../src/package.ts";
import { Sha256, sha256OfStream } from "../src/sha256.ts";

const BASE = "https://host.example/data/run1/manifest.json";
const DIR = "https://host.example/data/run1/";

const BAD = [
  "..", "../x.parquet", "a/../../x", "a/..", "%2e%2e/x", "%2E%2E/x", "%2e./x", ".%2e/x", "a/%2e%2e/%2e%2e/x", "%252e%252e/x", "%25252e%25252e/x",
  "..%2fx", "a%2f..%2fx", "%2e%2e%2fx", "..\\x", "a\\..\\x", "%5c..%5cx", "%5C%5Cserver%5Cshare", "\\\\server\\share\\x", "//evil.example/x", "/abs/x", "/x",
  "https://evil.example/x", "file:///etc/passwd", "C:/x", "c:\\x", "data:text/plain,hi", "javascript:alert(1)", "a\u0000b", "a%00b", "%zz", "", "a\nb", "%2f%2fevil.example/x",
];
const GOOD = ["a.parquet", "sub/a.parquet", "./a.parquet", "AMPK_3/od_before.parquet", "a%20b.parquet", "a..b.parquet", "my.file.v2.parquet", "dir/.hidden"];

test("isSafePackagePath rejects plain, encoded, double-encoded, backslash, scheme, UNC and absolute paths", () => {
  for (const p of BAD) assert.equal(isSafePackagePath(p), false, `should reject ${JSON.stringify(p)}`);
  for (const p of GOOD) assert.equal(isSafePackagePath(p), true, `should accept ${JSON.stringify(p)}`);
  assert.equal(isSafePackagePath(undefined), false);
  assert.equal(isSafePackagePath(5 as unknown), false);
});

test("resolveInsidePackage: stays under the manifest directory, throws otherwise", () => {
  assert.equal(resolveInsidePackage(BASE, "a.parquet"), `${DIR}a.parquet`);
  assert.equal(resolveInsidePackage(BASE, "sub/./a.parquet"), `${DIR}sub/a.parquet`);
  assert.equal(resolveInsidePackage(DIR, "a%20b.parquet"), `${DIR}a%20b.parquet`);
  assert.equal(packageBaseUrl("https://h.example/p/m.json?x=1#y"), "https://h.example/p/");
  for (const p of BAD) assert.throws(() => resolveInsidePackage(BASE, p), /unsafe package path/, `should throw for ${JSON.stringify(p)}`);
});

test("the WHATWG resolver would have escaped for encoded dot segments: the href prefix check is the backstop", () => {
  // documents WHY the check exists: new URL() normalises %2e%2e to a real parent step
  assert.equal(new URL("%2e%2e/x", DIR).href, "https://host.example/data/x");
  assert.equal(new URL("%2E%2E/x", DIR).href, "https://host.example/data/x");
  assert.equal(new URL("..\\x", DIR).href, "https://host.example/data/x"); // backslash is a separator for special schemes
  assert.equal(new URL("//evil.example/x", DIR).href, "https://evil.example/x");
  assert.throws(() => resolveInsidePackage(BASE, "%2e%2e/x"));
  assert.throws(() => resolveInsidePackage(BASE, "..\\x"));
  assert.throws(() => resolveInsidePackage(BASE, "//evil.example/x"));
});

test("validateManifest rejects every unsafe path form", () => {
  for (const p of BAD.filter((x) => x !== "")) {
    assert.throws(() => validateManifest({ schema_version: 1, files: [{ table: "t", path: p }] }), /path/, `manifest should reject ${JSON.stringify(p)}`);
  }
  assert.doesNotThrow(() => validateManifest({ schema_version: 1, files: [{ table: "t", path: "sub/a.parquet" }] }));
});

test("loadPackage never fetches outside the package directory", async () => {
  const fetched: string[] = [];
  const f = (async (u: string) => {
    fetched.push(String(u));
    return new Response(JSON.stringify({ schema_version: 1, files: [{ table: "t", path: "%2e%2e/secret.parquet" }] }));
  }) as unknown as typeof fetch;
  await assert.rejects(loadPackage({} as never, BASE, { fetchImpl: f }), /path/);
  assert.deepEqual(fetched, [BASE]);
});

test("registerTable: unique per-call file names, always dropped (also when the query fails)", async () => {
  const names: string[] = [];
  const dropped: string[] = [];
  const h = {
    registerBuffer: async (n: string) => void names.push(n),
    dropFile: async (n: string) => void dropped.push(n),
    exec: async (sql: string) => {
      if (/BOOM/.test(sql)) throw new Error("boom");
    },
    query: async () => [{ n: 3 }],
  } as never;
  assert.equal(await registerTable(h, "subpath_obs_jt", "x", new Uint8Array(1), "parquet"), 3);
  assert.equal(await registerTable(h, "subpath_obs_jt", "x", new Uint8Array(1), "parquet"), 3);
  assert.equal(new Set(names).size, 2);
  assert.ok(names.every((n) => /^pkg_subpath_obs_jt_[a-z0-9_]+\.parquet$/.test(n)));
  assert.notEqual(names[0], "pkg_subpath_obs_jt.parquet");
  assert.deepEqual(dropped, names);
  const h2 = { ...(h as object), exec: async () => { throw new Error("boom"); } } as never;
  await assert.rejects(registerTable(h2, "t", "x", new Uint8Array(1), "parquet"), /boom/);
  assert.equal(dropped.length, 3); // dropped despite the failure
  assert.notEqual(uniqueSuffix(), uniqueSuffix());
});

test("Sha256: NIST vectors, block boundaries and chunked updates equal node:crypto", async () => {
  const hex = (d: Uint8Array) => new Sha256().update(d).digestHex();
  assert.equal(hex(new Uint8Array(0)), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(hex(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(hex(new TextEncoder().encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")), "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
  for (const n of [1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 100_003]) {
    const b = randomBytes(n);
    assert.equal(hex(b), createHash("sha256").update(b).digest("hex"), `len ${n}`);
    const h = new Sha256();
    for (let i = 0; i < n; i += 37) h.update(b.subarray(i, Math.min(n, i + 37)));
    assert.equal(h.digestHex(), createHash("sha256").update(b).digest("hex"), `chunked len ${n}`);
  }
  const big = randomBytes(300_000);
  const stream = new Response(big).body as ReadableStream<Uint8Array>;
  const r = await sha256OfStream(stream);
  assert.equal(r.bytes, 300_000);
  assert.equal(r.hex, createHash("sha256").update(big).digest("hex"));
});
