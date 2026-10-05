import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const braces = require("braces");

test("braces rejects excessive nested expansion before recursive processing", () => {
  const nested = "{".repeat(101) + "x" + "}".repeat(101);
  assert.throws(() => braces.expand(nested), /Maximum brace nesting depth \(100\) exceeded/);
});

test("braces still expands ordinary alternatives and ranges", () => {
  assert.deepEqual(braces.expand("{a,b}{1..2}"), ["a1", "a2", "b1", "b2"]);
});
