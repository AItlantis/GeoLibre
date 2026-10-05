import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const braces = require("braces") as {
  compile(pattern: string): string;
  expand(pattern: string): string[];
};

const nested = (depth: number) => "{".repeat(depth) + "x" + "}".repeat(depth);

test("braces compile and expand reject nesting beyond the parser recursion ceiling", () => {
  const hostile = nested(1000);
  assert.throws(() => braces.compile(hostile), /nesting exceeds maximum depth/);
  assert.throws(() => braces.expand(hostile), /nesting exceeds maximum depth/);
});

test("braces retain ordinary and supported nested pattern behavior", () => {
  assert.deepEqual(braces.expand("{a,{b,c}}"), ["a", "b", "c"]);
  assert.deepEqual(braces.expand(nested(80)), [nested(80)]);
  assert.equal(braces.compile("{a,{b,c}}"), "(a|(b|c))");
});
