/**
 * Shared fixture helpers for tests and the smoke script.
 *
 * Everything here is deterministic and offline: a synthetic book.json, no PDF,
 * and a `runBatch` stub that writes the same partial files the real pipeline
 * would. That lets the scheduler, merge, index and HTTP layers be exercised
 * without Python or a model.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bookPaths, writeJson } from "../../host/config.js";

/** Create a throwaway book directory with `chapters` × 24 pages. */
export function makeBook({ chapters = 1, title = "测试书" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ailearn-test-"));
  const list = Array.from({ length: chapters }, (_, index) => ({
    no: index + 1,
    title: `第${index + 1}章 测试`,
    pdfPage: 1 + index * 24,
    sections: [],
  }));
  const book = {
    version: 1,
    title,
    pdfPath: path.join(dir, "book.pdf"),
    pageCount: chapters * 24,
    hasTextLayer: false,
    pageOffset: 0,
    tocFound: true,
    chapters: list,
  };
  writeJson(path.join(dir, ".aiLearn", "book.json"), book);
  const paths = bookPaths(dir);
  fs.mkdirSync(paths.partialDir, { recursive: true });
  return { dir, book, paths };
}

/** Minimal runtime shape that `runJob` and `mergeChapter` consume. */
export function makeRuntime(fixture, overrides = {}) {
  return {
    bookDir: fixture.dir,
    book: fixture.book,
    paths: fixture.paths,
    config: { batchPages: 12, concurrency: 1, dpi: 150, jpegQuality: 85, ...overrides },
  };
}

/**
 * Deterministic stand-in for `runBatch`: sleeps `delayMs`, honours the abort
 * signal, then persists one partial the way the real extractor would.
 */
export function makeStubBatch({ delayMs = 40 } = {}) {
  let calls = 0;
  const stub = async (runtime, config, book, batch, signal) => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    if (signal?.aborted) throw new Error("aborted");
    const result = {
      batchId: batch.id,
      chapterNo: batch.chapterNo,
      chapterTitle: batch.chapterTitle,
      first: batch.first,
      last: batch.last,
      items: [{
        section: `${batch.chapterNo}.${batch.first}`,
        title: `知识点 ${batch.id}`,
        claim: "一句话说明",
        evidence: "",
        badCode: "",
        goodCode: "",
        tags: [],
        pdfPage: batch.first + 1,
      }],
      problems: [],
    };
    writeJson(path.join(runtime.paths.partialDir, `${batch.id}.json`), result);
    return result;
  };
  stub.calls = () => calls;
  return stub;
}

/** Minimal context that `apply()` needs, with the route handler exposed. */
export function makeFakeContext() {
  const state = { handler: null };
  const ctx = {
    effect: (fn) => { fn(); return () => {}; },
    webServer: { register: (route) => { state.handler = route.handler; } },
    tools: { register: () => {} },
    get: () => undefined,
  };
  return { ctx, handler: () => state.handler };
}

/** Call the registered HTTP handler with a JSON body, return parsed output. */
export async function request(handler, method, urlPath, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  const req = {
    method,
    url: urlPath,
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; },
  };
  let status = 0;
  let payload = "";
  const res = { writeHead: (code) => { status = code; }, end: (text) => { payload = text; } };
  await handler(req, res);
  return { status, body: payload ? JSON.parse(payload) : null };
}

export function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
