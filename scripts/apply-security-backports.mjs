import { existsSync, readFileSync, writeFileSync } from "node:fs";

const packagePath = "node_modules/node-forge/package.json";
const sourcePath = "node_modules/node-forge/lib/rsa.js";
const bracesPackagePath = "node_modules/braces/package.json";
const bracesParsePath = "node_modules/braces/lib/parse.js";
if (existsSync(packagePath)) {
  const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
  if (packageJson.version !== "1.4.0") {
    throw new Error(`Expected pinned node-forge 1.4.0, found ${packageJson.version}`);
  }
  const source = readFileSync(sourcePath, "utf8");
  const vulnerable = "if(!asn1.validate(obj, digestInfoValidator, capture, errors) ||\n            obj.value.length !== 2) {";
  const fixed = "if(!asn1.validate(obj, digestInfoValidator, capture, errors) ||\n            obj.value.length !== 2 || obj.value[0].value.length > 2) {";
  if (source.includes(fixed)) {
    // Already backported by a previous install run.
  } else if (!source.includes(vulnerable)) {
    throw new Error("node-forge RSA verifier no longer matches the reviewed backport context");
  } else {
    writeFileSync(sourcePath, source.replace(vulnerable, fixed));
  }
}

// braces 3.0.3 recursively walks the AST in both compile() and expand().
// Bound syntactic brace nesting in the parser so neither recursive walker can
// be driven beyond the reviewed safe depth by attacker-controlled patterns.
if (existsSync(bracesPackagePath)) {
  const bracesPackage = JSON.parse(readFileSync(bracesPackagePath, "utf8"));
  if (bracesPackage.version !== "3.0.3") {
    throw new Error(`Expected audited braces 3.0.3, found ${bracesPackage.version}`);
  }
  let parse = readFileSync(bracesParsePath, "utf8");
  const bracesFixed = "      if (depth >= 100) {\n        throw new RangeError('brace nesting exceeds maximum depth (100)');\n      }\n      depth++;";
  const bracesVulnerable = "      depth++;";
  if (parse.includes(bracesFixed)) {
    // Already backported by a previous install run.
  } else if (!parse.includes(bracesVulnerable)) {
    throw new Error("braces parser no longer matches the reviewed recursion guard context");
  } else {
    parse = parse.replace(bracesVulnerable, bracesFixed);
    writeFileSync(bracesParsePath, parse);
  }
}
