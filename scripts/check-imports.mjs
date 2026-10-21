/**
 * Enforce the dependency direction that makes the plugin boundary real.
 *
 *   plugins ──► sdk ◄── host ──► node:*
 *      └────────► node:* (host side only)
 *
 * Without this check a plugin can import another plugin's internals and the
 * whole "independent pack" claim quietly stops being true.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", ".git", "dist", "backup", ".tmp"]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;

function specifiersOf(source) {
  const found = [];
  for (const match of source.matchAll(SPECIFIER)) found.push(match[1]);
  return found;
}

function zoneOf(rel) {
  if (rel.startsWith("sdk/")) return "sdk";
  if (rel.startsWith("plugins/")) return "plugin";
  if (rel.startsWith("host/") || rel === "index.js") return "host";
  if (rel.startsWith("client/") || rel === "client.js") return "client";
  return "tooling";
}

/** @returns {string|null} a human-readable violation, or null when allowed. */
function violates(rel, spec) {
  const zone = zoneOf(rel);
  const builtin = spec.startsWith("node:");
  const relative = spec.startsWith(".") || spec.startsWith("/");

  if (builtin) {
    // The SDK is loaded by the browser bundle too, so it may not touch Node.
    return zone === "sdk" ? "sdk must stay isomorphic (no node: imports)" : null;
  }
  if (relative) {
    // sdk may only depend on itself; everything else may reach into sdk.
    if (zone === "sdk" && !rel.startsWith("sdk/")) return "sdk must not import outside sdk";
    return null;
  }

  // Bare specifiers: only the client may depend on react (the shell provides it),
  // and only dev tooling (scripts/, test/) may use devDependencies.
  if (zone === "client" && spec === "react") return null;
  if (zone === "plugin" && spec === "react" && /client\.[cm]?jsx?$/.test(rel)) return null;
  if (zone === "tooling") return null;
  return `bare import "${spec}" is not allowed in ${zone}`;
}

const files = walk(root);
const violations = [];
for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, "/");
  const source = fs.readFileSync(file, "utf8");
  for (const spec of specifiersOf(source)) {
    const reason = violates(rel, spec);
    if (reason) violations.push(`${rel}: ${reason}`);
  }
}

if (violations.length > 0) {
  console.error(`imports: ${violations.length} violation(s)\n${violations.join("\n")}`);
  process.exit(1);
}
console.log(`imports: ${files.length} files ok`);
