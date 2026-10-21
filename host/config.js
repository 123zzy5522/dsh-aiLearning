import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Harness home, honouring the same override the Host uses. */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
}

/** Per-profile plugin data. Never inside a user's book directory. */
export function pluginDataDir() {
  const dir = path.join(dshHome(), "ailearn");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Locate a Python interpreter that can import PyMuPDF.
 * Order: explicit config, DSH_PYTHON, the bundled runtime interpreter, PATH.
 * The bundled one is what `load_workspace_dependencies` reports, so it is the
 * normal answer; the rest exist so a profiling mistake is recoverable.
 */
export function pythonCandidates(config = {}) {
  const list = [];
  if (config.pythonPath) list.push(config.pythonPath);
  if (process.env.DSH_PYTHON) list.push(process.env.DSH_PYTHON);
  const bundled = path.join(
    dshHome(), "dsh-runtimes", "dsh-primary-runtime", "dependencies", "python",
    process.platform === "win32" ? "python.exe" : "bin/python3",
  );
  list.push(bundled);
  if (process.platform === "win32") list.push("python.exe", "python");
  else list.push("python3", "python");
  return [...new Set(list.filter(Boolean))];
}

/** Directory of a book's private data, created on demand. */
export function bookDataDir(bookDir) {
  const dir = path.join(bookDir, ".aiLearn");
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "kp"), { recursive: true });
  fs.mkdirSync(path.join(dir, "progress"), { recursive: true });
  fs.mkdirSync(path.join(dir, "pages"), { recursive: true });
  return dir;
}

export function bookPaths(bookDir) {
  const root = bookDataDir(bookDir);
  return {
    root,
    book: path.join(root, "book.json"),
    index: path.join(root, "kp", "index.json"),
    kpDir: path.join(root, "kp"),
    partialDir: path.join(root, "kp", ".partial"),
    pages: path.join(root, "pages"),
    events: path.join(root, "progress", "events.jsonl"),
    mastery: path.join(root, "progress", "mastery.json"),
    coverage: path.join(root, "progress", "coverage.json"),
    session: path.join(root, "session.json"),
    jobs: path.join(root, "jobs"),
  };
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  fs.renameSync(tmp, file);
}