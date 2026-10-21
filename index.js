import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import {
  bookPaths, pluginDataDir, pythonCandidates, readJson, writeJson,
} from "./host/config.js";
import { probePdf } from "./host/pdf.js";
import { buildChapterMap, calibrateOffset, providerOf } from "./host/ingest.js";
import { resolveLlmRoute } from "./host/llm.js";
import { newJob, runJob, saveJob, latestJob, resetBuild } from "./host/job.js";
import { readBook, writeBook } from "./host/store.js";
import { rebuildMastery, dueQueue, coverageGap } from "./host/progress.js";
import { registerTools } from "./host/tools.js";
import { API_VERSION, CODES, errorBody } from "./sdk/index.js";

export const name = "dsh-ailearn";
export const inject = ["webServer", "credentials", "tools"];

const API = "/dsh-ailearn/api";
const running = new Map();

/**
 * Config is a Standard Schema, which is what Cordis requires: `resolveConfig`
 * calls `Config["~standard"].validate(raw)`. A plain object has no `~standard`,
 * and the loader fails with "Cannot read properties of undefined (reading
 * 'validate')" before the plugin ever activates.
 */
const CONFIG_SPEC = {
  // Empty by default: the build rides the running DSH account through ctx.llm.
  // Set these only to override with a specific endpoint and credential ref.
  baseURL: { type: "string", default: "" },
  apiKeyRef: { type: "string", default: "" },
  model: { type: "string", default: "" },
  // Optional "provider/model" override for the ingest pass alone.
  ingestModel: { type: "string", default: "" },
  concurrency: { type: "number", default: 3 },
  batchPages: { type: "number", default: 12 },
  maxOutputTokens: { type: "number", default: 8000 },
  retries: { type: "number", default: 4 },
  reasoningEffort: { type: "string", default: "low" },
  dpi: { type: "number", default: 150 },
  jpegQuality: { type: "number", default: 85 },
  pythonPath: { type: "string", default: "" },
  autoInstallRenderer: { type: "boolean", default: true },
  registerTools: { type: "boolean", default: true },
};

export const Config = {
  "~standard": {
    version: 1,
    vendor: "dsh-ailearn",
    validate(value) {
      const input = value ?? {};
      const normalized = {};
      const issues = [];
      for (const [key, spec] of Object.entries(CONFIG_SPEC)) {
        const raw = input[key];
        if (raw === undefined || raw === null) {
          normalized[key] = spec.default;
          continue;
        }
        if (typeof raw !== spec.type) {
          issues.push({ message: `${key} must be a ${spec.type}, got ${typeof raw}`, path: [key] });
          continue;
        }
        normalized[key] = raw;
      }
      if (issues.length > 0) return { issues };
      return { value: normalized };
    },
  },
};

/** Find the one textbook PDF a book directory declares. */
export function findPdf(bookDir) {
  const book = readBook(bookDir);
  if (book?.pdfPath && fs.existsSync(book.pdfPath)) return book.pdfPath;
  const entries = fs.readdirSync(bookDir, { withFileTypes: true });
  const pdfs = entries.filter((e) => e.isFile() && /\.pdf$/i.test(e.name)).map((e) => path.join(bookDir, e.name));
  if (pdfs.length === 0) throw new Error(`这个目录里没有 PDF: ${bookDir}`);
  if (pdfs.length > 1) {
    throw new Error(`这个目录里有 ${pdfs.length} 个 PDF,无法确定教材。请只保留一本,或先建立 .aiLearn/book.json 指定 pdfPath。`);
  }
  return pdfs[0];
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: options.timeoutMs ?? 60000, ...options }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${file} ${args.join(" ")} failed: ${stderr || error.message}`));
      resolve(String(stdout));
    });
  });
}

/** Pick the first interpreter that can import PyMuPDF, installing it if allowed. */
async function resolvePython(config) {
  const candidates = pythonCandidates(config);
  const errors = [];
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ["-c", "import pymupdf"]);
      return candidate;
    } catch (error) {
      errors.push(`${candidate}: ${String(error.message).slice(0, 160)}`);
    }
  }
  if (config.autoInstallRenderer) {
    for (const candidate of candidates) {
      try {
        await execFileAsync(candidate, ["-m", "pip", "install", "--quiet", "pymupdf"], { timeoutMs: 300000 });
        await execFileAsync(candidate, ["-c", "import pymupdf"]);
        return candidate;
      } catch (error) {
        errors.push(`${candidate} install: ${String(error.message).slice(0, 160)}`);
      }
    }
  }
  throw new Error(`找不到可用的 Python + PyMuPDF。请安装 pymupdf,或在插件配置里设置 pythonPath。尝试过:\n${errors.join("\n")}`);
}

/**
 * The attachment service an image-bearing ingest call needs.
 * Resolved lazily because a deployment without it can still build text-only
 * books, and returning `undefined` lets `complete()` fail with a clear reason
 * only when an image actually has to be sent.
 */
function ctxForAttachments(runtime) {
  const ctx = runtime.ctx;
  if (!ctx) return undefined;
  const probes = [
    () => ctx.get?.("attachments"),
    () => ctx.attachments,
  ];
  for (const probe of probes) {
    try {
      const found = probe();
      if (found && typeof found.saveImages === "function") return found;
    } catch { /* not published on this context; try the next accessor */ }
  }
  return undefined;
}

function createRuntime(ctx, config) {
  return {
    ctx,
    config,
    python: null,
    apiKey: null,
    paths: null,
    book: null,
    dataRoot: pluginDataDir(),
  };
}

async function armRuntime(runtime, bookDir) {
  if (!runtime.python) runtime.python = await resolvePython(runtime.config);

  // Default: ride the running DSH account. No credential is read, stored, or
  // configured, which is what makes an installed bundle work for anyone.
  if (!runtime.llmRoute) {
    runtime.llmRoute = await resolveLlmRoute(runtime.ctx, runtime.config);
  }
  if (!runtime.llmRoute) {
    // Explicit override path: a deployment that names its own endpoint.
    const ref = String(runtime.config.apiKeyRef || "").trim();
    if (!runtime.config.baseURL || !ref) {
      throw new Error(
        "没有可用的模型通道:当前会话拿不到 DSH 的 LLM 服务,插件配置里也没有指定 baseURL + apiKeyRef。" +
        "请在设置里给插件填 ingestModel,或指定一个 baseURL 与凭据名。",
      );
    }
    if (!runtime.apiKey) {
      const hit = await runtime.ctx.credentials.resolve(ref);
      if (!hit?.value) throw new Error(`凭据 ${ref} 未配置`);
      runtime.apiKey = hit.value;
    }
  }
  runtime.bookDir = bookDir;
  // `runBatch` is handed this runtime object as its context, so every service the
  // ingest path needs has to live on the runtime directly, not only under .ctx.
  runtime.attachments = ctxForAttachments(runtime);
  runtime.paths = bookPaths(bookDir);
  fs.mkdirSync(runtime.paths.jobs, { recursive: true });
  runtime.book = readBook(bookDir);
  return runtime;
}

/** Prepare a book: probe the PDF, learn the chapter map, calibrate page offset. */
async function prepareBook(runtime, bookDir) {
  const pdfPath = findPdf(bookDir);
  const probe = await probePdf(runtime.python, pdfPath);
  const title = path.basename(pdfPath, path.extname(pdfPath));

  const pageOffset = probe.hasTextLayer ? 0 : await calibrateOffset(
    { python: runtime.python, apiKey: runtime.apiKey, dataRoot: runtime.dataRoot, llmRoute: runtime.llmRoute, attachments: ctxForAttachments(runtime) },
    runtime.config, pdfPath, probe.pageCount,
  );
  const map = await buildChapterMap(
    { python: runtime.python, apiKey: runtime.apiKey, dataRoot: runtime.dataRoot, llmRoute: runtime.llmRoute, attachments: ctxForAttachments(runtime) },
    runtime.config, pdfPath, probe.pageCount, title, pageOffset,
  );

  let chapters = map.chapters ?? [];
  if (chapters.length === 0) {
    chapters = [{ no: 1, title: "全书", pdfPage: 1, sections: [] }];
  }
  for (const chapter of chapters) {
    chapter.pdfPage = Math.max(1, Math.min(probe.pageCount, Number(chapter.pdfPage) || 1));
  }
  chapters.sort((a, b) => a.no - b.no);

  const book = {
    version: 1,
    title,
    pdfPath,
    pageCount: probe.pageCount,
    hasTextLayer: probe.hasTextLayer,
    pageOffset,
    tocFound: Boolean(map.tocFound),
    tocPdfPages: map.tocPdfPages ?? [],
    chapters,
    batchPages: runtime.config.batchPages,
    dpi: runtime.config.dpi,
    createdAt: new Date().toISOString(),
  };
  writeBook(bookDir, book);
  runtime.book = book;
  return book;
}

/**
 * Start a build. Returns immediately; the job runs in the background.
 *
 * `mode` decides what an existing library means:
 *   auto   — resume whatever is unfinished; a finished build is left alone
 *   resume — same, but explicit
 *   fresh  — move the old `kp/` and `jobs/` aside and extract from scratch
 */
async function startBuild(ctx, config, bookDir, mode = "auto") {
  const existing = running.get(bookDir);
  if (existing) {
    return { jobId: existing.jobId ?? "running", status: "running", message: "建库已在后台运行，先暂停再重新开始。" };
  }

  const runtime = await armRuntime(createRuntime(ctx, config), bookDir);
  // Reset synchronously so a status poll right after this call already sees an
  // empty library instead of the one that is about to be replaced.
  if (mode === "fresh") resetBuild(bookDir);
  const controller = new AbortController();
  const control = { aborted: false, paused: false, controller, runtime, jobId: null };
  running.set(bookDir, control);

  (async () => {
    try {
      let book = runtime.book;
      if (!book || !book.chapters?.length) book = await prepareBook(runtime, bookDir);
      const prior = mode === "fresh" ? null : latestJob(runtime.paths);
      if (prior?.status === "done") {
        // Nothing to do: re-running a finished job would burn the whole book's
        // token budget again to produce the same files.
        control.summary = { status: "done", done: prior.doneBatches, total: prior.totalBatches, failed: prior.failedBatches };
        return;
      }
      const job = prior && prior.status !== "done" ? prior : null;
      control.jobId = job?.id ?? null;
      const started = await runJobInBackground(runtime, job, control);
      control.summary = started;
    } catch (error) {
      control.error = String(error?.message || error);
      saveJob(runtime.paths, {
        id: `error-${Date.now().toString(36)}`, status: "failed", createdAt: new Date().toISOString(),
        totalBatches: 0, doneBatches: 0, failedBatches: 0, batches: [], log: [control.error],
      });
    } finally {
      running.delete(bookDir);
    }
  })();

  return {
    jobId: "starting",
    status: "running",
    message: mode === "fresh" ? "已把旧库移入 backup/，开始重建。" : "建库已启动，正在后台运行。",
  };
}

/** Ask a running build to stop; the abort unwinds in-flight batches. */
function pauseBuild(bookDir) {
  const control = running.get(bookDir);
  if (!control) return { ok: false, message: "当前没有正在运行的建库任务。" };
  control.paused = true;
  control.aborted = true;
  control.controller.abort();
  return { ok: true, message: "正在暂停：当前请求会中止，已完成的批次和知识点都保留。" };
}

async function runJobInBackground(runtime, existingJob, control) {
  const { planBatches } = await import("./host/ingest.js");
  const batches = planBatches({ ...runtime.book, batchPages: runtime.config.batchPages });
  const job = existingJob ?? newJob({ ...runtime.book, bookDir: runtime.bookDir }, batches);
  saveJob(runtime.paths, job);
  // Awaited so the book directory stays marked busy for the whole build; the
  // caller returns to the UI immediately because it does not await this.
  await runJob(runtime, job, { signal: control?.controller?.signal }).catch(() => {});
  return job;
}

/** One shape for the tool result and the UI status line. */
function jobSummary(bookDir) {
  const job = latestJob(bookPaths(bookDir));
  if (!job) return { status: "idle", done: 0, total: 0, failed: 0, message: "还没有建库任务。" };
  return {
    status: job.status,
    jobId: job.id,
    done: job.doneBatches ?? 0,
    total: job.totalBatches ?? 0,
    failed: job.failedBatches ?? 0,
    message: `建库 ${job.status}: ${job.doneBatches ?? 0}/${job.totalBatches ?? 0} 批完成，${job.failedBatches ?? 0} 批失败。${(job.log ?? []).slice(-2).join(" | ")}`,
  };
}

function buildActionFactory(ctx, config) {
  return async (action, bookDir) => {
    if (action === "start" || action === "resume") {
      const result = await startBuild(ctx, config, bookDir, action === "resume" ? "resume" : "auto");
      return { status: result.status, jobId: result.jobId, done: 0, total: 0, failed: 0, message: result.message };
    }
    if (action === "rebuild") {
      const result = await startBuild(ctx, config, bookDir, "fresh");
      return { status: result.status, jobId: result.jobId, done: 0, total: 0, failed: 0, message: result.message };
    }
    if (action === "pause") {
      const result = pauseBuild(bookDir);
      return { status: result.ok ? "pausing" : "idle", done: 0, total: 0, failed: 0, message: result.message };
    }
    return jobSummary(bookDir);
  };
}

function emptyBuild(state) {
  return { state, done: 0, total: 0, failed: 0, canPause: false, canResume: false, log: [], batches: [] };
}

function emptyLearning(message) {
  return { ready: false, built: 0, assessed: 0, unseen: 0, due: 0, message };
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

async function readBody(req, maxBytes = 65536) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function apply(ctx, config) {
  if (config.registerTools !== false) {
    registerTools(ctx, { buildAction: buildActionFactory(ctx, config) });
  }

  const route = async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = url.pathname.startsWith(API) ? url.pathname.slice(API.length) : url.pathname;
      const dir = url.searchParams.get("dir") || "";

      if (pathname === "/health") {
        // Report the transport the build will actually use. `attachments` decides
        // whether page images can travel through the DSH account at all, and it is
        // the one dependency that is resolved from the running context rather than
        // from plugin configuration.
        const route = await resolveLlmRoute(ctx, config).catch(() => null);
        const attachments = ctxForAttachments({ ctx });
        return sendJson(res, 200, {
          ok: true,
          transport: route ? "dsl-llm" : "direct-http",
          provider: route?.provider ?? null,
          model: route?.model ?? config.model ?? null,
          attachments: Boolean(attachments),
          python: config.pythonPath || "(auto)",
          batchPages: config.batchPages,
        });
      }

      if (pathname === "/build" && req.method === "GET") {
        // Never create `.aiLearn/` for a path the user merely typed: a status
        // read must not leave directories behind on a typo.
        if (!dir || !fs.existsSync(dir)) {
          return sendJson(res, 200, {
            ok: true,
            apiVersion: API_VERSION,
            dir,
            book: null,
            library: { kps: 0, chapters: 0 },
            build: emptyBuild("idle"),
            learning: emptyLearning("这个目录不存在，或者还没有教材。"),
            modes: [],
            capabilities: [],
          });
        }
        const paths = bookPaths(dir);
        const job = latestJob(paths);
        const book = readBook(dir);
        const index = readJson(paths.index, { kps: [] });
        const kps = index.kps ?? [];
        // Derived, not written: this endpoint is polled while the panel is open.
        const mastery = book ? rebuildMastery(dir, { persist: false }) : { kps: {} };
        const seen = new Set(Object.keys(mastery.kps ?? {}));
        const now = Date.now();
        const assessed = kps.filter((kp) => seen.has(kp.id)).length;
        // Only knowledge points that have been studied can be "due for review";
        // counting never-assessed ones here would double-count the coverage gap.
        const due = kps.filter((kp) => {
          const entry = mastery.kps?.[kp.id];
          return entry && (!entry.dueAt || Date.parse(entry.dueAt) <= now);
        }).length;
        const unseen = Math.max(0, kps.length - assessed);
        const isRunning = running.has(dir);
        // A job file that says "running" with no live control belongs to a
        // process that died (DSH restart, crash). Showing it as running would
        // promise progress that is not happening; the work is simply paused.
        const state = job && job.status === "running" && !isRunning ? "paused" : (job?.status ?? "idle");
        const learn = kps.length === 0
          ? emptyLearning("还没有可学的知识点。先建库，或者把已建的库继续建下去。")
          : {
            ready: true,
            built: kps.length,
            assessed,
            unseen,
            due,
            message: isRunning
              ? `建库中，已有 ${kps.length} 条可以先学（${unseen} 条没学过）。`
              : `已建 ${kps.length} 条：${unseen} 条没学过，${due} 条到期复习。`,
          };
        return sendJson(res, 200, {
          ok: true,
          apiVersion: API_VERSION,
          dir,
          book: book ? { title: book.title, pages: book.pageCount, chapters: book.chapters.length, tocFound: book.tocFound } : null,
          library: { kps: kps.length, chapters: new Set(kps.map((kp) => kp.chapter)).size },
          build: {
            ...emptyBuild(state),
            done: job?.doneBatches ?? 0,
            total: job?.totalBatches ?? 0,
            failed: job?.failedBatches ?? 0,
            canPause: isRunning,
            canResume: Boolean(job) && ["paused", "partial", "failed"].includes(state),
            log: (job?.log ?? []).slice(-12),
            batches: (job?.batches ?? []).map((b) => ({ id: b.id, status: b.status, items: b.items ?? 0, error: b.error })),
          },
          learning: learn,
          modes: [],
          capabilities: [],
        });
      }

      if (pathname === "/build/start" && req.method === "POST") {
        const body = await readBody(req);
        if (!body.dir) return sendJson(res, 400, errorBody(CODES.NO_DIR, "缺少 dir"));
        const mode = body.mode === "fresh" ? "fresh" : body.mode === "resume" ? "resume" : "auto";
        const result = await startBuild(ctx, config, body.dir, mode);
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (pathname === "/build/pause" && req.method === "POST") {
        const body = await readBody(req);
        if (!body.dir) return sendJson(res, 400, errorBody(CODES.NO_DIR, "缺少 dir"));
        const result = pauseBuild(body.dir);
        if (!result.ok) return sendJson(res, 200, errorBody(CODES.BUILD_NONE_RUNNING, result.message));
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (pathname === "/init" && req.method === "POST") {
        const body = await readBody(req);
        if (!body.dir) return sendJson(res, 400, errorBody(CODES.NO_DIR, "缺少 dir"));
        const result = await startBuild(ctx, config, body.dir, "auto");
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (pathname === "/resume" && req.method === "POST") {
        const body = await readBody(req);
        const result = await startBuild(ctx, config, body.dir, "resume");
        return sendJson(res, 200, { ok: true, ...result });
      }

      if (pathname === "/status" && req.method === "GET") {
        const book = readBook(dir);
        if (!book) return sendJson(res, 200, { ok: true, book: null });
        const mastery = rebuildMastery(dir);
        const gap = coverageGap(dir, book);
        return sendJson(res, 200, {
          ok: true,
          book: { title: book.title, chapters: book.chapters.length, pages: book.pageCount },
          mastery: mastery.summary,
          coverage: { total: gap.total, assessed: gap.assessed, never: gap.never.length },
          due: dueQueue(dir, book, 8),
        });
      }

      if (pathname === "/open" && req.method === "POST") {
        const body = await readBody(req);
        const bookDir = body.dir;
        const book = readBook(bookDir);
        if (!book) return sendJson(res, 400, errorBody(CODES.BOOK_NOT_READY, "这个目录还没有建库"));
        const registry = ctx.get("workspaceRegistry");
        const sessions = ctx.get("sessionController");
        if (!registry || !sessions) {
          return sendJson(res, 200, {
            ...errorBody(CODES.SESSION_SERVICE_MISSING, "无法自动创建学习会话,请在侧栏手动新建会话并选择「AI 教材导师」预设。"),
            reason: "no-session-service",
          });
        }
        let workspace = registry.list().find((item) => item.path === bookDir);
        if (!workspace) workspace = await registry.create(bookDir, book.title);
        const stored = readJson(bookPaths(bookDir).session, null);
        if (stored?.sessionId) {
          const live = ctx.get("sessions")?.get?.(stored.sessionId);
          if (live) return sendJson(res, 200, { ok: true, sessionId: stored.sessionId, workspaceId: workspace.id, reused: true });
        }
        const created = await sessions.create({ workspaceId: workspace.id, agentPreset: "ailearn" });
        if (created?.sessionId) writeJson(bookPaths(bookDir).session, { sessionId: created.sessionId, preset: "ailearn", createdAt: new Date().toISOString() });
        return sendJson(res, 200, { ok: true, sessionId: created?.sessionId ?? null, workspaceId: workspace.id, reused: false });
      }

      return sendJson(res, 404, errorBody(CODES.UNKNOWN_ROUTE, `unknown route ${pathname}`));
    } catch (error) {
      return sendJson(res, 500, errorBody(CODES.INTERNAL, String(error?.message || error)));
    }
  };

  ctx.effect(() => ctx.webServer.register({ kind: "prefix", path: API, handler: route }, "dsh-ailearn:api"), "dsh-ailearn:api");
}