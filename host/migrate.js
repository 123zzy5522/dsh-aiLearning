import fs from "node:fs";
import path from "node:path";
import { bookPaths } from "./config.js";
import { readBook, kpFileName, rebuildIndex, makeKpId } from "./store.js";

/**
 * One-way migration from positional ids (`KP-0203`) to section ids
 * (`KP-02-2.1.3`).
 *
 * Positional ids renumber every later knowledge point when one batch is
 * re-extracted, which silently orphans the attempts recorded against the old
 * ids. Section ids survive a re-extraction of the same section.
 *
 * The rewrite is idempotent: headings that already carry a section id are left
 * alone, and a second run reports zero rewrites.
 */

const OLD_HEADING = /^##\s+(KP-\d{4})\s+(.*)$/;
const OLD_HEADING_ANYWHERE = /^##\s+(KP-\d{4})\s+/m;

export function migrateKpIds(bookDir, { dryRun = false } = {}) {
  const book = readBook(bookDir);
  if (!book) throw new Error(`not a prepared book: ${bookDir}`);
  const paths = bookPaths(bookDir);
  const mapping = new Map();
  const report = { chapters: 0, rewritten: 0, events: 0, backup: null };
  const changedChapters = new Set();
  let backedUp = false;

  for (const chapter of book.chapters ?? []) {
    const file = path.join(paths.kpDir, kpFileName(chapter));
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const used = new Set();
    let current = null;
    let changed = false;

    const finalize = () => {
      if (!current) return;
      const base = makeKpId(current.chapterNo, current);
      let id = base;
      let suffix = 2;
      while (used.has(id)) {
        id = `${base}-${suffix}`;
        suffix += 1;
      }
      used.add(id);
      mapping.set(current.oldId, id);
      lines[current.index] = `## ${id} ${current.title}`;
      report.rewritten += 1;
      changed = true;
      current = null;
    };

    for (let i = 0; i < lines.length; i += 1) {
      const heading = OLD_HEADING.exec(lines[i]);
      if (heading) {
        finalize();
        current = { chapterNo: chapter.no, oldId: heading[1], title: heading[2].trim(), section: null, index: i };
        continue;
      }
      if (current && lines[i].startsWith("## ")) {
        finalize();
        continue;
      }
      if (current && lines[i].startsWith("- 节:")) {
        current.section = lines[i].slice("- 节:".length).trim();
        finalize();
      }
    }
    finalize();

    if (!changed) continue;
    changedChapters.add(chapter.no);
    if (dryRun) continue;

    if (!backedUp) {
      const backup = path.join(paths.root, "backup", `kp-ids-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
      fs.mkdirSync(path.dirname(backup), { recursive: true });
      fs.cpSync(paths.kpDir, backup, { recursive: true });
      report.backup = backup;
      backedUp = true;
    }
    fs.writeFileSync(file, lines.join("\n"), "utf8");
  }

  report.chapters = changedChapters.size;
  if (mapping.size === 0) return { ...report, mapping: {} };

  // Attempts already recorded against the old ids.
  if (fs.existsSync(paths.events)) {
    const lines = fs.readFileSync(paths.events, "utf8").split("\n").filter(Boolean);
    let touched = 0;
    const rewritten = lines.map((line) => {
      try {
        const event = JSON.parse(line);
        const next = event.kpId && mapping.get(event.kpId);
        if (!next) return line;
        touched += 1;
        return JSON.stringify({ ...event, kpId: next });
      } catch {
        return line;
      }
    });
    report.events = touched;
    if (touched > 0 && !dryRun) fs.writeFileSync(paths.events, rewritten.join("\n") + "\n", "utf8");
  }

  if (!dryRun) rebuildIndex(bookDir, book);
  return { ...report, mapping: Object.fromEntries(mapping) };
}

/** Does this library still use positional ids? */
export function hasLegacyIds(bookDir) {
  const book = readBook(bookDir);
  if (!book) return false;
  const paths = bookPaths(bookDir);
  for (const chapter of book.chapters ?? []) {
    const file = path.join(paths.kpDir, kpFileName(chapter));
    if (!fs.existsSync(file)) continue;
    if (OLD_HEADING_ANYWHERE.test(fs.readFileSync(file, "utf8"))) return true;
  }
  return false;
}
