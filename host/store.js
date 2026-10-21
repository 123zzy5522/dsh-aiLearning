import fs from "node:fs";
import path from "node:path";
import { bookPaths, readJson, writeJson } from "./config.js";

/**
 * Knowledge points live in one Markdown file per chapter. Markdown is the only
 * format that satisfies all four requirements at once: the model reads it, the
 * learner reads it, git diffs it, and a wrong extraction can be corrected by
 * hand in thirty seconds. `index.json` is a derived cache, never the source.
 */

/**
 * Knowledge point ids are derived from the section, not from the order the
 * extractor happened to emit them. A positional id (`KP-0203`) silently
 * renumbers every later knowledge point when one batch is re-extracted, which
 * orphans the attempts already recorded against the old ids.
 *
 * `KP-02-2.1.3` survives a re-extraction of the same section; when a section is
 * missing, a short title hash is used so the id is still stable per title.
 */
export const KP_HEADING = /^##\s+(KP-[A-Za-z0-9][A-Za-z0-9.-]*)\s+(.*)$/;
export const SUB_HEADING = /^###\s+(.+?)\s*$/;

export function makeKpId(chapterNo, { section, title } = {}) {
  const chapter = String(chapterNo).padStart(2, "0");
  const normalized = String(section ?? "").trim();
  if (/^\d+(?:\.\d+)*$/.test(normalized)) return `KP-${chapter}-${normalized}`;
  return `KP-${chapter}-h${shortHash(String(title ?? ""))}`;
}

function shortHash(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  return hash.toString(36).slice(0, 6);
}

/** Render one knowledge point to its canonical Markdown block. */
export function renderKp(kp) {
  const lines = [];
  lines.push(`## ${kp.id} ${kp.title}`);
  lines.push("");
  if (kp.section) lines.push(`- 节: ${kp.section}`);
  if (kp.printPage != null) lines.push(`- 印刷页: ${kp.printPage}`);
  if (kp.pdfPage != null) lines.push(`- PDF 页: ${kp.pdfPage}`);
  if (kp.tags?.length) lines.push(`- 标签: ${kp.tags.map((t) => `#${t}`).join(" ")}`);
  if (kp.prereq?.length) lines.push(`- 前置: ${kp.prereq.join(", ")}`);
  if (kp.era) lines.push(`- 时代评估: ${kp.era}`);
  lines.push("");
  lines.push("### 一句话");
  lines.push(kp.claim || "(待补)");
  lines.push("");
  if (kp.evidence) {
    lines.push("### 书中依据");
    lines.push(...String(kp.evidence).split("\n").map((l) => `> ${l}`));
    lines.push("");
  }
  if (kp.badCode) {
    lines.push("### 坏例子");
    lines.push("```" + (kp.language || "csharp"));
    lines.push(String(kp.badCode).replace(/\n+$/, ""));
    lines.push("```");
    lines.push("");
  }
  if (kp.goodCode) {
    lines.push("### 好例子");
    lines.push("```" + (kp.language || "csharp"));
    lines.push(String(kp.goodCode).replace(/\n+$/, ""));
    lines.push("```");
    lines.push("");
  }
  if (kp.pitfalls?.length) {
    lines.push("### 常见误解");
    kp.pitfalls.forEach((item, index) => lines.push(`${index + 1}. ${item}`));
    lines.push("");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Split a Markdown buffer into `## ` blocks, ignoring headings inside fences. */
function splitBlocks(text) {
  const blocks = [];
  let current = null;
  let fence = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*```/.test(line)) fence = !fence;
    const heading = !fence && line.match(KP_HEADING);
    if (heading) {
      if (current) blocks.push(current);
      current = { id: heading[1], title: heading[2].trim(), lines: [] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) blocks.push(current);
  return blocks;
}

/** Parse one chapter file back into knowledge-point records. */
export function parseKpMarkdown(text) {
  return splitBlocks(text).map((block) => {
    const kp = { id: block.id, title: block.title, tags: [], prereq: [], pitfalls: [] };
    const sections = [];
    let section = { name: null, lines: [] };
    let fence = false;
    for (const line of block.lines) {
      if (/^\s*```/.test(line)) fence = !fence;
      const sub = !fence && line.match(SUB_HEADING);
      if (sub) {
        sections.push(section);
        section = { name: sub[1].trim(), lines: [] };
        continue;
      }
      section.lines.push(line);
    }
    sections.push(section);

    for (const entry of sections) {
      const body = entry.lines.join("\n").trim();
      if (entry.name === null) {
        for (const line of entry.lines) {
          const bullet = line.match(/^-\s*([^:]+):\s*(.*)$/);
          if (!bullet) continue;
          const key = bullet[1].trim();
          const value = bullet[2].trim();
          if (key === "节") kp.section = value;
          else if (key === "印刷页") kp.printPage = Number(value) || null;
          else if (key === "PDF 页") kp.pdfPage = Number(value) || null;
          else if (key === "标签") kp.tags = [...value.matchAll(/#([^\s#]+)/g)].map((m) => m[1]);
          else if (key === "前置") kp.prereq = value.split(/[,，\s]+/).filter(Boolean);
          else if (key === "时代评估") kp.era = value;
        }
        continue;
      }
      if (entry.name === "一句话") kp.claim = body;
      else if (entry.name === "书中依据") {
        kp.evidence = entry.lines.filter((l) => l.startsWith(">")).map((l) => l.replace(/^>\s?/, "")).join("\n").trim();
      } else if (entry.name === "常见误解") {
        kp.pitfalls = entry.lines
          .map((l) => l.match(/^\s*\d+\.\s*(.+)$/))
          .filter(Boolean)
          .map((m) => m[1].trim());
      } else if (entry.name === "坏例子" || entry.name === "好例子") {
        const code = extractFence(entry.lines);
        if (entry.name === "坏例子") kp.badCode = code.body;
        else kp.goodCode = code.body;
        if (code.language) kp.language = code.language;
      }
    }
    return kp;
  });
}

function extractFence(lines) {
  let language = "";
  const body = [];
  let inside = false;
  for (const line of lines) {
    const fence = line.match(/^\s*```(\S*)\s*$/);
    if (fence && !inside) { inside = true; language = fence[1] || ""; continue; }
    if (fence && inside) { inside = false; continue; }
    if (inside) body.push(line);
  }
  return { language, body: body.join("\n").trim() };
}

export function kpFileName(chapter) {
  const no = String(chapter.no).padStart(2, "0");
  const safe = String(chapter.title || "chapter").replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
  return `${no}-${safe}.md`;
}

export function readBook(bookDir) {
  const paths = bookPaths(bookDir);
  return readJson(paths.book, null);
}

export function writeBook(bookDir, book) {
  const paths = bookPaths(bookDir);
  writeJson(paths.book, book);
  return book;
}

/** Load every chapter file into one flat list. */
export function loadAllKps(bookDir, book) {
  const paths = bookPaths(bookDir);
  const all = [];
  for (const chapter of book?.chapters ?? []) {
    const file = path.join(paths.kpDir, kpFileName(chapter));
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const kp of parseKpMarkdown(text)) all.push({ ...kp, chapter: chapter.no });
  }
  return all;
}

/** Rebuild `kp/index.json` from the chapter files. Derived, so it is safe to lose. */
export function rebuildIndex(bookDir, book) {
  const paths = bookPaths(bookDir);
  const all = loadAllKps(bookDir, book);
  const index = {
    version: 1,
    generatedAt: new Date().toISOString(),
    count: all.length,
    kps: all.map((kp) => ({
      id: kp.id,
      title: kp.title,
      chapter: kp.chapter,
      section: kp.section ?? null,
      printPage: kp.printPage ?? null,
      pdfPage: kp.pdfPage ?? null,
      tags: kp.tags ?? [],
      "前置": kp.prereq ?? [],
    })),
  };
  writeJson(paths.index, index);
  return index;
}

export function findKp(bookDir, book, id) {
  return loadAllKps(bookDir, book).find((kp) => kp.id === id) ?? null;
}