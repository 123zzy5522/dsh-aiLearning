import fs from "node:fs";
import path from "node:path";
import { defineTool } from "./toolkit.js";
import { bookPaths, readJson } from "./config.js";
import { readBook, loadAllKps, findKp } from "./store.js";
import { rebuildMastery, dueQueue, coverageGap, appendEvent } from "./progress.js";
import { currentMode, setMode } from "./capabilities.js";

/**
 * The agent-facing half of the plugin. Every tool reads or writes the same
 * files the Host API uses, so there is exactly one implementation per operation
 * and a UI action and a model action can never disagree.
 */

const DIMENSIONS = ["recognize", "recall", "apply"];

function resolveBookDir(exec, explicit) {
  if (explicit) return explicit;
  const cwd = exec?.agent?.session?.header?.cwd;
  if (cwd) return cwd;
  throw new Error("learn_* needs a book directory: run inside the textbook workspace, or pass bookDir explicitly.");
}

function requireBook(bookDir) {
  const book = readBook(bookDir);
  if (!book) throw new Error(`this directory has no AI textbook yet: ${bookDir}. Run learn_build with action "start" first.`);
  return book;
}

export function registerTools(ctx, deps) {
  const registry = deps.registry ?? null;
  const awaitPacks = deps.awaitPacks ?? (async () => null);

  ctx.tools.register(defineTool({
    name: "learn_status",
    description: "Show the current textbook, the active learning mode and its rules, learning progress, the knowledge points most worth asking about now, and coverage debt. Call this first in every study turn.",
    parameters: {
      bookDir: { type: "string", description: "Textbook workspace directory. Defaults to the current workspace." },
      limit: { type: "integer", description: "How many candidate knowledge points to return (default 6)." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          book: { type: "string", required: true },
          chapters: { type: "integer", required: true },
          totalKps: { type: "integer", required: true },
          assessed: { type: "integer", required: true },
          due: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, title: { type: "string", required: true }, section: { type: "string" }, priority: { type: "integer", required: true } } } },
          weak: { type: "integer", required: true },
          illusions: { type: "integer", required: true },
          modeId: { type: "string", required: true },
          modeLabel: { type: "string", required: true },
          modeRules: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: [
          `教材: ${value.book} (${value.chapters} 章 / ${value.totalKps} 个知识点, 已测 ${value.assessed})`,
          `当前模式: ${value.modeLabel} (${value.modeId})`,
          "",
          "## 本模式的规则（必须遵守）",
          value.modeRules,
          "",
          `薄弱 ${value.weak} 个, 幻觉点 ${value.illusions} 个`,
          "建议下一个讲:",
          ...value.due.map((item, i) => `  ${i + 1}. ${item.id} ${item.title}${item.section ? ` (${item.section})` : ""} 优先级 ${item.priority}`),
        ].join("\n"),
      }],
    },
    async execute(args, exec) {
      await awaitPacks();
      const bookDir = resolveBookDir(exec, args.bookDir);
      const book = requireBook(bookDir);
      const mastery = rebuildMastery(bookDir);
      const queue = dueQueue(bookDir, book, args.limit ?? 6);
      const index = readJson(bookPaths(bookDir).index, { kps: [] });
      const modeId = registry ? currentMode(bookDir, registry) : null;
      const mode = modeId && registry ? registry.mode(modeId) : null;
      return {
        book: book.title,
        chapters: (book.chapters ?? []).length,
        totalKps: (index.kps ?? []).length,
        assessed: Object.keys(mastery.kps).length,
        due: queue.map((item) => ({ id: item.id, title: item.title, section: item.section ?? null, priority: item.priority })),
        weak: mastery.summary.weak,
        illusions: mastery.summary.illusions,
        modeId: modeId ?? "unset",
        modeLabel: mode?.label ?? "未安装模式插件",
        modeRules: mode?.rules ?? "没有可用模式：按“一次一个知识点、讲完立即出题、严格判卷”执行。",
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "learn_mode",
    description: "List installed learning modes, or switch the current mode. Modes are plugins: each one supplies its own teaching rules. Switch at the start of a session, not mid-lesson.",
    parameters: {
      mode: { type: "string", description: "Mode id to activate. Omit to list installed modes." },
      bookDir: { type: "string", description: "Textbook workspace directory." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          active: { type: "string", required: true },
          modes: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, label: { type: "string", required: true }, summary: { type: "string" } } } },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: [
          `当前模式: ${value.active}`,
          "可用模式:",
          ...value.modes.map((mode) => `  - ${mode.id}: ${mode.label}${mode.summary ? ` — ${mode.summary}` : ""}`),
        ].join("\n"),
      }],
    },
    async execute(args, exec) {
      await awaitPacks();
      if (!registry) throw new Error("capability registry is unavailable");
      const bookDir = resolveBookDir(exec, args.bookDir);
      requireBook(bookDir);
      if (args.mode) setMode(bookDir, registry, args.mode);
      return {
        active: currentMode(bookDir, registry) ?? "unset",
        modes: registry.modes().map((mode) => ({ id: mode.id, label: mode.label, summary: mode.summary })),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "learn_kp",
    description: "Read one knowledge point in full: its claim, the book's supporting excerpt, the bad/good code pair, and the common misconceptions. Everything you teach must come from here.",
    parameters: {
      id: { type: "string", required: true, description: "Knowledge point id, such as KP-0203." },
      bookDir: { type: "string", description: "Textbook workspace directory." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", required: true },
          title: { type: "string", required: true },
          markdown: { type: "string", required: true },
          pitfalls: { type: "array", required: true, items: { type: "string" } },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.markdown }],
    },
    execute(args, exec) {
      const bookDir = resolveBookDir(exec, args.bookDir);
      const book = requireBook(bookDir);
      const kp = findKp(bookDir, book, args.id);
      if (!kp) throw new Error(`no such knowledge point: ${args.id}`);
      const markdown = [
        `## ${kp.id} ${kp.title}`,
        kp.section ? `小节: ${kp.section}` : "",
        kp.pdfPage ? `PDF 第 ${kp.pdfPage} 页` : "",
        "",
        `一句话: ${kp.claim}`,
        kp.evidence ? `\n书中原文: ${kp.evidence}` : "",
        kp.badCode ? `\n坏例子:\n\`\`\`${kp.language || ""}\n${kp.badCode}\n\`\`\`` : "",
        kp.goodCode ? `\n好例子:\n\`\`\`${kp.language || ""}\n${kp.goodCode}\n\`\`\`` : "",
        kp.pitfalls?.length ? `\n常见误解:\n${kp.pitfalls.map((p, i) => `${i + 1}. ${p}`).join("\n")}` : "",
      ].filter(Boolean).join("\n");
      return { id: kp.id, title: kp.title, markdown, pitfalls: kp.pitfalls ?? [] };
    },
  }));

  ctx.tools.register(defineTool({
    name: "learn_record",
    description: "Record one graded attempt for one knowledge point. Call this after every probe and every quiz item, including failed ones. This is the only thing that advances mastery.",
    parameters: {
      kpId: { type: "string", required: true, description: "Knowledge point id." },
      dimension: { type: "string", required: true, enum: DIMENSIONS, description: "recognize (spotting it), recall (explaining it), apply (doing it)." },
      score: { type: "number", required: true, description: "0 to 1. Rubric checkpoints hit divided by total checkpoints. No rounding up." },
      confidence: { type: "integer", description: "The learner's stated confidence before answering, 1-5. Used to detect illusions of competence." },
      kind: { type: "string", description: "mcq | fill | judge | code | recall." },
      answer: { type: "string", description: "The learner's answer, verbatim." },
      missed: { type: "array", items: { type: "string" }, description: "Rubric checkpoints the answer missed." },
      note: { type: "string", description: "One short line on why it was scored this way." },
      bookDir: { type: "string", description: "Textbook workspace directory." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          recorded: { type: "boolean", required: true },
          kpId: { type: "string", required: true },
          attempts: { type: "integer", required: true },
          meanScore: { type: "number", required: true },
          dueAt: { type: "string" },
          illusion: { type: "boolean", required: true },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: `已记录 ${value.kpId}: 累计 ${value.attempts} 次, 均值 ${value.meanScore.toFixed(2)}${value.illusion ? " (高信心答错,已标记为幻觉点)" : ""}${value.dueAt ? `, 下次复习 ${value.dueAt.slice(0, 10)}` : ""}`,
      }],
    },
    execute(args, exec) {
      const bookDir = resolveBookDir(exec, args.bookDir);
      requireBook(bookDir);
      const score = Math.max(0, Math.min(1, Number(args.score)));
      appendEvent(bookDir, {
        type: "attempt",
        kpId: args.kpId,
        dimension: DIMENSIONS.includes(args.dimension) ? args.dimension : "recall",
        score,
        correct: score >= 0.8,
        confidence: Number.isFinite(args.confidence) ? args.confidence : null,
        kind: args.kind ?? null,
        answer: args.answer ?? null,
        missed: args.missed ?? [],
        note: args.note ?? null,
      });
      const mastery = rebuildMastery(bookDir);
      const entry = mastery.kps[args.kpId];
      return {
        recorded: true,
        kpId: args.kpId,
        attempts: entry?.attempts ?? 1,
        meanScore: entry ? entry.scoreSum / entry.attempts : score,
        dueAt: entry?.dueAt ?? null,
        illusion: Boolean(entry && entry.illusions > 0 && Number(args.confidence) >= 4 && score < 0.5),
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "learn_report",
    description: "Full progress report: per-knowledge-point mastery, coverage gaps (never assessed), and illusion points. Use it when the learner asks how they are doing, or at the end of a chapter.",
    parameters: {
      bookDir: { type: "string", description: "Textbook workspace directory." },
      chapter: { type: "integer", description: "Restrict to one chapter number." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          total: { type: "integer", required: true },
          assessed: { type: "integer", required: true },
          never: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, title: { type: "string", required: true } } } },
          rows: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, title: { type: "string", required: true }, attempts: { type: "integer", required: true }, mean: { type: "number", required: true }, illusions: { type: "integer", required: true } } } },
        },
      },
      render: (_args, value) => [{
        type: "text",
        text: [
          `覆盖: ${value.assessed}/${value.total} 个知识点被评估过`,
          value.never.length ? `未覆盖 ${value.never.length} 个,例如: ${value.never.slice(0, 5).map((k) => `${k.id} ${k.title}`).join("; ")}` : "覆盖已完整",
          "",
          "已评估:",
          ...value.rows.map((row) => `  ${row.id} ${row.title}: ${row.mean.toFixed(2)} (${row.attempts} 次)${row.illusions ? ` ⚠幻觉 ${row.illusions}` : ""}`),
        ].join("\n"),
      }],
    },
    execute(args, exec) {
      const bookDir = resolveBookDir(exec, args.bookDir);
      const book = requireBook(bookDir);
      const mastery = rebuildMastery(bookDir);
      const gap = coverageGap(bookDir, book);
      const kps = loadAllKps(bookDir, book);
      const byId = new Map(kps.map((kp) => [kp.id, kp]));
      const rows = Object.values(mastery.kps)
        .filter((entry) => args.chapter == null || byId.get(entry.kpId)?.chapter === args.chapter)
        .sort((a, b) => a.scoreSum / a.attempts - b.scoreSum / b.attempts)
        .map((entry) => ({
          id: entry.kpId,
          title: byId.get(entry.kpId)?.title ?? "(已删除)",
          attempts: entry.attempts,
          mean: Number((entry.scoreSum / entry.attempts).toFixed(2)),
          illusions: entry.illusions,
        }));
      return { total: gap.total, assessed: gap.assessed, never: gap.never, rows };
    },
  }));

  ctx.tools.register(defineTool({
    name: "learn_build",
    description: "Build, pause, or inspect the knowledge base for a PDF textbook in the current workspace. action=start or resume continues an unfinished build (finished batches are skipped); action=rebuild wipes the knowledge points and extracts from scratch; action=pause stops the running build; action=status reports batch progress.",
    parameters: {
      action: { type: "string", required: true, enum: ["start", "resume", "rebuild", "pause", "status"], description: "start/resume an unfinished build, rebuild from scratch, pause the running one, or read status." },
      bookDir: { type: "string", description: "Textbook workspace directory." },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string", required: true },
          jobId: { type: "string" },
          done: { type: "integer", required: true },
          total: { type: "integer", required: true },
          failed: { type: "integer", required: true },
          message: { type: "string", required: true },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.message }],
    },
    async execute(args, exec) {
      const bookDir = resolveBookDir(exec, args.bookDir);
      return deps.buildAction(args.action, bookDir);
    },
  }));
}