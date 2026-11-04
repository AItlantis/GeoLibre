import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const localesDir = fileURLToPath(new URL("../apps/geolibre-desktop/src/i18n/locales/", import.meta.url));
// UTF-8 bytes decoded as Latin-1/cp1252 and re-encoded: U+00C2 / U+00C3 followed by a Latin-1 supplement
// character, or the U+00E2 U+20AC lead of curly quotes, dashes and ellipsis.
const MOJIBAKE = /[ÂÃ][\u0080-ÿ]|â€/u;

test("locale catalogs contain no double-encoded (mojibake) text", () => {
  for (const file of readdirSync(localesDir).filter(name => name.endsWith(".json"))) {
    const lines = readFileSync(`${localesDir}${file}`, "utf8").split("\n");
    const bad = lines.flatMap((line, index) => (MOJIBAKE.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : []));
    assert.deepEqual(bad, [], `mojibake in ${file}`);
  }
});
