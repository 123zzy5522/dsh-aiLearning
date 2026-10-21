#!/usr/bin/env node
/**
 * Standalone harness for the ingest pipeline.
 *
 * The DSH Host needs an installed plugin to run this, which makes the first
 * version hard to debug. This CLI drives exactly the same modules without any
 * Host services, so a build can be validated against a real book before the
 * bundle is installed.
 *
 *   node cli.js probe   <bookDir>
 *   node cli.js prepare <bookDir>
 *   node cli.js batch   <bookDir> <chapterNo> [maxBatches]
 *   node cli.js status  <bookDir>
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bookPaths, readJson, writeJson, dshHome } from "./host/config.js";
import { probePdf } from "./host/pdf.js";
import { buildChapterMap, calibrateOffset, planBatches, runBatch, mergeChapter } from "./host/ingest.js";
import { readBook, writeBook, rebuildIndex, loadAllKps } from "./host/store.js";
import { rebuildMastery, dueQueue, coverageGap } from "./host/progress.js";

const CONFIG = {
  // The CLI drives the direct HTTP transport, which exists only for local
  // development against a private endpoint. Nothing here is a default a user
  // should inherit: point AILEARN_BASE_URL at your own provider.
  baseURL: process.env.AILEARN_BASE_URL || "",
  model: process.env.AILEARN_MODEL || "",
  concurrency: 3,
  batchPages: Number(process.env.AILEARN_BATCH || 15),
  maxOutputTokens: 8000,
  retries: 4,
  reasoningEffort: process.env.AILEARN_EFFORT || "low",
  dpi: 150,
  jpegQuality: 85,
};

function resolveApiKey() {
  const ref = process.env.AILEARN_API_KEY_ENV || "DEEPSEEK_API_KEY";
  if (process.env[ref]) return process.env[ref];
  const file = path.join(dshHome(), ".credentials.yaml");
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8");
    const match = text.match(new RegExp(ref + ":\\s*(\\S+)"));
    if (match) return match[1];
  }
  throw new Error(
    `no credential found. Set ${ref} in the environment, or set AILEARN_BASE_URL/AILEARN_MODEL` +
    " plus the matching key env var to point the CLI at your own provider."
  );
}

function resolvePython() {
  const bundled = path.join(dshHome(), "dsh-runtimes", "dsh-primary-runtime", "dependencies", "python",
    process.platform === "win32" ? "python.exe" : "bin/python3");
  const candidates = [process.env.DSH_PYTHON, bundled, "python", "python3"].filter(Boolean);
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["-c", "import pymupdf"], { stdio: "ignore" });
      return candidate;
    } catch { /* try next */ }
  }
  throw new Error("no python with pymupdf found");
}

function findPdf(bookDir) {
  const book = readBook(bookDir);
  if (book?.pdfPath && fs.existsSync(book.pdfPath)) return book.pdfPath;
  const pdfs = fs.readdirSync(bookDir).filter((n) => /\.pdf$/i.test(n)).map((n) => path.join(bookDir, n));
  if (pdfs.length !== 1) throw new Error(`expected exactly one PDF in ${bookDir}, found ${pdfs.length}`);
  return pdfs[0];
}

function makeCtx(bookDir) {
  return {
    python: resolvePython(),
    apiKey: resolveApiKey(),
    dataRoot: path.join(bookDir, ".aiLearn"),
    paths: bookPaths(bookDir),
  };
}

function requireEndpoint() {
  if (!CONFIG.baseURL || !CONFIG.model) {
    throw new Error(
      "cli.js only drives the direct HTTP transport. Set AILEARN_BASE_URL and AILEARN_MODEL " +
      "(and the matching key env var) to use it. The plugin itself needs none of this: it rides ctx.llm."
    );
  }
}

async function cmdProbe(bookDir) {
  const ctx = makeCtx(bookDir);
  const pdf = findPdf(bookDir);
  const probe = await probePdf(ctx.python, pdf);
  console.log(JSON.stringify({ pdf, ...probe }, null, 2));
}

async function cmdPrepare(bookDir) {
  const ctx = makeCtx(bookDir);
  ctx.paths = bookPaths(bookDir);
  const pdf = findPdf(bookDir);
  const title = path.basename(pdf, path.extname(pdf));
  console.error(`[prepare] probing ${pdf}`);
  requireEndpoint();
  const probe = await probePdf(ctx.python, pdf);
  console.error(`[prepare] ${probe.pageCount} pages, text layer: ${probe.hasTextLayer}`);
  console.error("[prepare] calibrating printed-page offset...");
  const pageOffset = probe.hasTextLayer ? 0 : await calibrateOffset(ctx, CONFIG, pdf, probe.pageCount);
  console.error(`[prepare] page offset = ${pageOffset}`);
  console.error("[prepare] reading the table of contents...");
  const map = await buildChapterMap(ctx, CONFIG, pdf, probe.pageCount, title, pageOffset);
  console.error(`[prepare] tocFound=${map.tocFound}, chapters=${map.chapters?.length ?? 0}, entries=${map.entries ?? 0}`);
  const chapters = (map.chapters?.length ? map.chapters : [{ no: 1, title: "全书", pdfPage: 1, sections: [] }])
    .map((c) => ({ ...c, pdfPage: Math.max(1, Math.min(probe.pageCount, Number(c.pdfPage) || 1)) }))
    .sort((a, b) => a.no - b.no);
  const book = {
    version: 1, title, pdfPath: pdf, pageCount: probe.pageCount, hasTextLayer: probe.hasTextLayer,
    pageOffset, tocFound: Boolean(map.tocFound), tocPdfPages: map.tocPdfPages ?? [],
    chapters, batchPages: CONFIG.batchPages, dpi: CONFIG.dpi, createdAt: new Date().toISOString(),
  };
  writeBook(bookDir, book);
  const batches = planBatches(book);
  console.error(`[prepare] wrote book.json: ${chapters.length} chapters, ${batches.length} batches, offset ${pageOffset}`);
  console.log(JSON.stringify({ chapters: chapters.map((c) => ({ no: c.no, title: c.title, pdfPage: c.pdfPage, sections: c.sections?.length ?? 0 })), batches: batches.length, pageOffset }, null, 2));
}

async function cmdBatch(bookDir, chapterNo, maxBatches) {
  const ctx = makeCtx(bookDir);
  const book = readBook(bookDir);
  if (!book) throw new Error("run `prepare` first");
  const batches = planBatches(book).filter((b) => String(b.chapterNo) === String(chapterNo));
  const limit = maxBatches ? Number(maxBatches) : batches.length;
  let done = 0;
  for (const batch of batches.slice(0, limit)) {
    const started = Date.now();
    try {
      const result = await runBatch(ctx, CONFIG, book, batch);
      done += 1;
      console.error(`[batch] ${batch.id} ok: ${result.items.length} kp, ${result.problems.length} problems, ${Math.round((Date.now() - started) / 1000)}s, usage ${JSON.stringify(result.usage)}`);
      if (result.problems.length) console.error(`         problems: ${result.problems.slice(0, 5).join("; ")}`);
    } catch (error) {
      console.error(`[batch] ${batch.id} FAILED: ${String(error.message).slice(0, 300)}`);
    }
  }
  const merged = mergeChapter(ctx, book, Number(chapterNo));
  if (merged) console.error(`[merge] ${merged.file} (${merged.count} kp)`);
  rebuildIndex(bookDir, book);
  const kps = loadAllKps(bookDir, book);
  console.log(JSON.stringify({ batchesRun: done, merged, totalKps: kps.length }, null, 2));
}

async function cmdStatus(bookDir) {
  const book = readBook(bookDir);
  if (!book) return console.log("no book");
  const mastery = rebuildMastery(bookDir);
  const gap = coverageGap(bookDir, book);
  console.log(JSON.stringify({ title: book.title, chapters: book.chapters.length, ...gap, mastery: mastery.summary, due: dueQueue(bookDir, book, 5) }, null, 2));
}

const [cmd, dir, a, b] = process.argv.slice(2);
const run = { probe: cmdProbe, prepare: cmdPrepare, batch: () => cmdBatch(dir, a, b), status: cmdStatus }[cmd];
if (!run || !dir) {
  console.error("usage: node cli.js <probe|prepare|batch|status> <bookDir> [chapterNo] [maxBatches]");
  process.exit(2);
}
run(dir).catch((error) => { console.error("ERROR:", error.message); process.exit(1); });