import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bookPaths, readJson, writeJson } from "./config.js";
import { API_VERSION } from "../sdk/protocol.js";

/**
 * Capability registry.
 *
 * A capability is one user-visible extension of the kernel: today a learning
 * mode, later an ingest extractor. The kernel owns the data format, the batch
 * scheduler and the tool plumbing; a pack only declares policy (persona, which
 * tools it may use, and its own tool implementations).
 *
 * A pack that fails to load must never take the plugin down: it is reported and
 * skipped, because a broken third-party pack cannot be allowed to make the
 * textbook unreadable.
 */

const ID = /^[a-z0-9][a-z0-9-]*$/;

export function createRegistry() {
  return {
    items: new Map(),
    /** @param {object} capability */
    register(capability) {
      if (!capability || typeof capability !== "object") throw new Error("capability must be an object");
      if (!ID.test(capability.id ?? "")) throw new Error(`invalid capability id: ${capability.id}`);
      if (capability.apiVersion !== API_VERSION) {
        throw new Error(`capability ${capability.id} targets apiVersion ${capability.apiVersion}, kernel is ${API_VERSION}`);
      }
      if (this.items.has(capability.id)) throw new Error(`duplicate capability id: ${capability.id}`);
      if (capability.mode) {
        const mode = capability.mode;
        if (typeof mode.label !== "string" || !mode.label.trim()) throw new Error(`capability ${capability.id}: mode.label is required`);
        if (typeof mode.rules !== "string" || !mode.rules.trim()) throw new Error(`capability ${capability.id}: mode.rules is required`);
        if (!Array.isArray(mode.tools)) throw new Error(`capability ${capability.id}: mode.tools must be an array`);
      }
      this.items.set(capability.id, capability);
      return capability;
    },
    list() {
      return [...this.items.values()].map((capability) => ({
        id: capability.id,
        name: capability.name ?? capability.id,
        apiVersion: capability.apiVersion,
        description: capability.description ?? "",
        kind: capability.mode ? "mode" : "capability",
      }));
    },
    modes() {
      return [...this.items.values()]
        .filter((capability) => capability.mode)
        .map((capability) => ({
          id: capability.id,
          label: capability.mode.label,
          summary: capability.mode.summary ?? "",
          tools: capability.mode.tools,
        }));
    },
    mode(id) {
      const capability = this.items.get(id);
      return capability?.mode ? { id, ...capability.mode } : null;
    },
  };
}

/**
 * Load every pack under `<root>/plugins/*`.
 * @returns {Promise<{loaded: string[], failed: {id: string, error: string}[]}>}
 */
export async function loadPacks(root, registry) {
  const dir = path.join(root, "plugins");
  const result = { loaded: [], failed: [] };
  if (!fs.existsSync(dir)) return result;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packDir = path.join(dir, entry.name);
    const manifest = readJson(path.join(packDir, "plugin.json"), null);
    if (!manifest) {
      result.failed.push({ id: entry.name, error: "plugin.json missing or unreadable" });
      continue;
    }
    try {
      const target = path.join(packDir, manifest.entry ?? "./host.js");
      if (!fs.existsSync(target)) throw new Error(`entry not found: ${manifest.entry}`);
      const module = await import(pathToFileURL(target).href);
      const capability = module.default ?? module.capability;
      if (!capability) throw new Error("entry has no default export");
      const normalized = { ...capability, id: capability.id ?? manifest.id, apiVersion: capability.apiVersion ?? manifest.apiVersion };
      registry.register(normalized);
      result.loaded.push(normalized.id);
    } catch (error) {
      result.failed.push({ id: manifest.id ?? entry.name, error: String(error?.message || error) });
    }
  }
  return result;
}

/** The mode stored on this book, or the first registered one. */
export function currentMode(bookDir, registry) {
  const stored = readJson(bookPaths(bookDir).session, null);
  const modes = registry.modes();
  if (stored?.mode && modes.some((mode) => mode.id === stored.mode)) return stored.mode;
  return modes[0]?.id ?? null;
}

/** Persist a mode choice without touching the session id. */
export function setMode(bookDir, registry, modeId) {
  const mode = registry.mode(modeId);
  if (!mode) throw new Error(`unknown mode: ${modeId}`);
  const paths = bookPaths(bookDir);
  const stored = readJson(paths.session, {}) ?? {};
  writeJson(paths.session, { ...stored, mode: modeId, modeUpdatedAt: new Date().toISOString() });
  return mode;
}
