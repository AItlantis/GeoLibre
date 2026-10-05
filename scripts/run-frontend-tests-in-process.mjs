/**
 * Run the frontend test modules in one Node process when the native test runner
 * cannot spawn a worker. The native TypeScript transpiler hook replaces TSX's
 * esbuild service so this fallback does not need another child process.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { test } from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const typescript = require("typescript");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testRoot = resolve(repoRoot, "tests");
const e2eRoot = resolve(repoRoot, "e2e");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.(?:[cm]?js|tsx?|json)$/.test(specifier)) {
      const unresolved = fileURLToPath(new URL(specifier, context.parentURL));
      for (const candidate of [
        `${unresolved}.ts`,
        `${unresolved}.tsx`,
        resolve(unresolved, "index.ts"),
        resolve(unresolved, "index.tsx"),
      ]) {
        if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (!/\.tsx?$/.test(new URL(url).pathname)) return nextLoad(url, context);
    const fileName = fileURLToPath(url);
    const source = readFileSync(fileName, "utf8");
    const transformed = typescript.transpileModule(source, {
      fileName,
      compilerOptions: {
        target: typescript.ScriptTarget.ES2022,
        module: typescript.ModuleKind.ESNext,
        jsx: typescript.JsxEmit.ReactJSX,
        esModuleInterop: true,
        experimentalDecorators: true,
      },
      reportDiagnostics: true,
    });
    const syntaxErrors = (transformed.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === typescript.DiagnosticCategory.Error,
    );
    if (syntaxErrors.length) {
      throw new SyntaxError(typescript.formatDiagnosticsWithColorAndContext(syntaxErrors, {
        getCurrentDirectory: () => repoRoot,
        getCanonicalFileName: (name) => name,
        getNewLine: () => "\n",
      }));
    }
    return { format: "module", source: transformed.outputText, shortCircuit: true };
  },
});

const requestedFiles = process.argv.slice(2).map((value) => value.replaceAll("\\", "/"));
const testFiles = readdirSync(testRoot)
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => ({ name, path: resolve(testRoot, name), display: name }));
if (requestedFiles.some((name) => name.startsWith("e2e/"))) {
  testFiles.push(...readdirSync(e2eRoot)
    .filter((name) => name.endsWith(".test.ts"))
    .map((name) => ({ name, path: resolve(e2eRoot, name), display: `e2e/${name}` })));
}
const selectedFiles = testFiles
  .filter((entry) => requestedFiles.length === 0
    || requestedFiles.includes(entry.name)
    || requestedFiles.includes(entry.display))
  .sort((a, b) => a.display.localeCompare(b.display));
if (requestedFiles.length > 0 && selectedFiles.length !== requestedFiles.length) {
  const known = new Set(testFiles.flatMap((entry) => [entry.name, entry.display]));
  throw new Error(`Unknown frontend test file: ${requestedFiles.find((name) => !known.has(name))}`);
}
for (const entry of selectedFiles) {
  test(entry.display, async () => {
    await import(pathToFileURL(entry.path).href);
  });
}
