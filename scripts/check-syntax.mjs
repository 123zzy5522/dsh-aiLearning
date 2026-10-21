/**
 * Parse-check every JavaScript file in the repository.
 *
 * Uses `node --check` per file instead of a parser dependency so this works on a
 * clean checkout with no install step.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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

const files = walk(root);
const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (result.status !== 0) {
    failures.push(`${path.relative(root, file)}\n${result.stderr.trim()}`);
  }
}

if (failures.length > 0) {
  console.error(`syntax: ${failures.length} file(s) failed\n\n${failures.join("\n\n")}`);
  process.exit(1);
}
console.log(`syntax: ${files.length} files ok`);
