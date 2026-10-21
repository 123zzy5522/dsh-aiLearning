/**
 * Dependency-direction rules for the whole repository.
 *
 * Extracted from the CLI so the rules can be exercised as ordinary unit tests:
 * a boundary checker that is only tested by "the repo happens to pass" is how
 * the plugin-sideways-import rule ended up unreachable in the first place.
 *
 * Allowed matrix (target →):
 *
 *            sdk   host   client   plugins(own)   plugins(other)   node:*
 *   sdk       ok    no     no       no            no               no
 *   host      ok    ok     no       no            no               ok
 *   client    ok    no     ok       no            no               no
 *   plugin    ok    no     no       ok            no               fs/child no
 *   tooling   unrestricted (scripts, tests)
 */

import path from "node:path";

// Covers `import x from`, `export … from`, dynamic `import()`, `require()`, and
// side-effect `import "…"` — the last one is how the plugin-sideways regression
// slipped through the first version of this checker.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["']([^"']+)["']/g;

/** Which layer a repo-relative path belongs to. */
export function zoneOf(relPath) {
  const rel = relPath.replace(/\\/g, "/");
  if (rel.startsWith("sdk/")) return "sdk";
  if (rel.startsWith("host/") || rel === "index.js") return "host";
  if (rel.startsWith("client/") || rel === "client.js") return "client";
  if (rel.startsWith("plugins/")) return "plugin";
  return "tooling";
}

/** Pack id for `plugins/<id>/…`, otherwise null. */
export function packOf(relPath) {
  const match = /^plugins\/([^/]+)\//.exec(relPath.replace(/\\/g, "/"));
  return match ? match[1] : null;
}

/** Resolve a relative specifier to a repo-relative posix path. */
export function resolveRelative(relPath, specifier) {
  const from = path.posix.dirname(relPath.replace(/\\/g, "/"));
  return path.posix.normalize(path.posix.join(from, specifier));
}

/**
 * @param {string} relPath  importer, repo-relative, posix or Windows separators
 * @param {string} specifier the string between the quotes
 * @returns {string|null} a human-readable violation, or null when allowed
 */
export function violationFor(relPath, specifier) {
  const zone = zoneOf(relPath);

  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const target = resolveRelative(relPath, specifier);
    if (target === ".." || target.startsWith("../")) {
      return `import "${specifier}" escapes the repository`;
    }
    if (zone === "tooling") return null;

    const targetZone = zoneOf(target);
    if (zone === "sdk") {
      return targetZone === "sdk" ? null : `sdk must not import outside sdk (got ${targetZone}: ${target})`;
    }
    if (zone === "host") {
      return ["host", "sdk"].includes(targetZone) ? null : `host must not import ${targetZone}`;
    }
    if (zone === "client") {
      return ["client", "sdk"].includes(targetZone) ? null : `client must not import ${targetZone}`;
    }
    if (zone === "plugin") {
      const own = packOf(relPath);
      const other = packOf(target);
      if (targetZone === "host" || targetZone === "client") return `plugin must not import ${targetZone}`;
      if (targetZone === "plugin" && other !== own) {
        return `plugin "${own}" must not import plugin "${other}" (sideways import)`;
      }
      if (targetZone === "tooling") return "plugin must not import repository tooling";
      return null;
    }
    return null;
  }

  if (specifier.startsWith("node:")) {
    if (zone === "sdk") return "sdk must stay isomorphic (no node: imports)";
    if (zone === "client") return "client bundle must not import node: builtins";
    if (zone === "plugin" && (specifier === "node:fs" || specifier === "node:child_process")) {
      return `plugin must use the host storage service, not ${specifier}`;
    }
    return null;
  }

  if (specifier.startsWith("/")) return `absolute import "${specifier}" is not allowed`;
  if (zone === "tooling") return null;
  if (zone === "client" && specifier === "react") return null;
  if (zone === "plugin" && specifier === "react" && /client\.[cm]?jsx?$/.test(relPath)) return null;
  return `bare import "${specifier}" is not allowed in ${zone}`;
}

/** Every specifier in a source file, in order. */
export function specifiersOf(source) {
  const found = [];
  for (const match of source.matchAll(SPECIFIER)) found.push(match[1]);
  return found;
}

/** All violations in one file. */
export function collectViolations(relPath, source) {
  const out = [];
  for (const specifier of specifiersOf(source)) {
    const reason = violationFor(relPath, specifier);
    if (reason) out.push(`${relPath}: ${reason}`);
  }
  return out;
}
