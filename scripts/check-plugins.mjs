/**
 * Validate every plugin pack before it is allowed to run.
 *
 * A pack is a directory with a `plugin.json`; the kernel will refuse to load one
 * that fails these checks, so this script is the fast copy of the same rules
 * that CI and `pnpm check` use.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API_VERSION } from "../sdk/protocol.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginsDir = path.join(root, "plugins");
const KNOWN_SERVICES = new Set(["books", "progress", "llm", "storage", "ui", "sessions"]);

if (!fs.existsSync(pluginsDir)) {
  console.log("plugins: none");
  process.exit(0);
}

const entries = fs.readdirSync(pluginsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
const failures = [];
const seen = new Set();

for (const entry of entries) {
  const dir = path.join(pluginsDir, entry.name);
  const manifestPath = path.join(dir, "plugin.json");
  if (!fs.existsSync(manifestPath)) {
    failures.push(`${entry.name}: missing plugin.json`);
    continue;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    failures.push(`${entry.name}: plugin.json is not valid JSON (${error.message})`);
    continue;
  }

  const report = (message) => failures.push(`${entry.name}: ${message}`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(manifest.id ?? "")) report("id must match [a-z0-9][a-z0-9-]*");
  else if (seen.has(manifest.id)) report(`duplicate id "${manifest.id}"`);
  else seen.add(manifest.id);

  if (manifest.apiVersion !== API_VERSION) {
    report(`apiVersion ${manifest.apiVersion} != ${API_VERSION} (recompile against this SDK)`);
  }
  if (typeof manifest.name !== "string" || !manifest.name.trim()) report("name is required");
  if (typeof manifest.entry !== "string") report("entry is required");
  else if (!fs.existsSync(path.join(dir, manifest.entry))) report(`entry not found: ${manifest.entry}`);

  if (manifest.client && !fs.existsSync(path.join(dir, manifest.client))) {
    report(`client panel not found: ${manifest.client}`);
  }

  for (const service of manifest.consumes ?? []) {
    if (!KNOWN_SERVICES.has(service)) report(`unknown service "${service}" in consumes`);
  }
  if (manifest.provides != null && typeof manifest.provides !== "object") report("provides must be an object");
}

if (failures.length > 0) {
  console.error(`plugins: ${failures.length} problem(s)\n${failures.join("\n")}`);
  process.exit(1);
}
console.log(`plugins: ${entries.length} pack(s) ok`);
