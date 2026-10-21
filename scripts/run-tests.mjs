/**
 * Run the unit suite without relying on shell glob expansion.
 *
 * `node --test <dir>` behaves differently across Node versions, and Windows
 * shells do not expand globs, so the file list is resolved here instead.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "test", "unit");
const files = fs.readdirSync(dir).filter((name) => name.endsWith(".test.js")).sort().map((name) => path.join(dir, name));

if (files.length === 0) {
  console.error("test: no unit tests found");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit", cwd: root });
process.exit(result.status ?? 1);
