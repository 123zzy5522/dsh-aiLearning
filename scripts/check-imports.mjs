/**
 * Enforce the dependency direction that makes the plugin boundary real.
 *
 *   plugins ──► sdk ◄── host ──► node:*
 *      └────────► node:* except fs/child_process
 *
 * The rules themselves live in `import-rules.mjs` so they can be unit-tested;
 * this file only walks the tree and reports.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectViolations } from "./import-rules.mjs";

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

const files = walk(root);
const violations = [];
for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, "/");
  violations.push(...collectViolations(rel, fs.readFileSync(file, "utf8")));
}

if (violations.length > 0) {
  console.error(`imports: ${violations.length} violation(s)\n${violations.join("\n")}`);
  process.exit(1);
}
console.log(`imports: ${files.length} files ok`);
