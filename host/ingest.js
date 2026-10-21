import fs from "node:fs";
import path from "node:path";
import { bookPaths, readJson, writeJson } from "./config.js";
import { renderPages } from "./pdf.js";
import { chat, chatViaLlmService, imageBlock, textBlock, parseJsonReply, resolveLlmRoute } from "./llm.js";
import { renderKp, kpFileName } from "./store.js";

/**
 * The ingest pipeline: page images -> knowledge points.
 *
 * Deliberately not an agent. Twenty-eight batches in one conversation would
 * exhaust the context, lose the ability to resume, and cost several times more
 * in output tokens. A fixed prompt with a fixed schema also keeps field names
 * stable across the whole book, which the index and the mastery table depend on.
 */

const EXTRACT_SYSTEM = [
  "你是教材知识点抽取器。你的输出会被程序解析并长期保存,格式错误等于丢弃。",
  "只输出一个 JSON 对象,不要任何解释文字、不要 Markdown 代码围栏。",
  "所有内容必须来自给出的页面。看不清就留空字符串,绝不猜测。",
].join("\n");

function extractPrompt(batch) {
  return [
    `这是《${batch.bookTitle}》第 ${batch.chapterNo} 章「${batch.chapterTitle}」的连续 ${batch.pageCount} 页扫描图,`,
    `PDF 第 ${batch.first + 1}-${batch.last + 1} 页,印刷页约 ${batch.printFrom}-${batch.printTo}。`,
    "",
    "本批次覆盖的目录小节:",
    ...batch.sections.map((s) => `- ${s.no} ${s.title}`),
    "",
    "请为**每个小节**产出一个知识点。若一个小节跨了批次边界,仍按本批可见内容产出。",
    "",
    "输出 JSON:",
    '{"items":[{"section":"2.2.6","title":"小节标题或更精确的知识点标题",',
    '"claim":"一句话说清这个知识点主张什么,80 字以内",',
    '"evidence":"书中原文摘录,不超过 120 字,能支撑 claim",',
    '"badCode":"书中给出的错误/待改进代码原文,保留缩进;没有就空字符串",',
    '"goodCode":"书中给出的正确代码原文,保留缩进;没有就空字符串",',
    '"language":"csharp|json|xml|sql|text","pitfalls":["学员最容易误解的一点"],',
    '"tags":["异步","面试高频"],"pdfPage":42,"confidence":"high|medium|low"}]}',
    "",
    "硬性要求:",
    "1. 这是扫描页。代码的缩进、行号、泛型尖括号必须与图中完全一致,不许重排、不许美化。",
    "2. badCode / goodCode 必须是书中真实存在的代码;书中没有代码就留空,不要自己编。",
    "3. pdfPage 必须是该知识点正文所在的 PDF 页码,落在本批范围内。",
    "4. pitfalls 只写学员真正会搞错的地方,不要写\"注意理解\"这种废话。",
  ].join("\n");
}

function locateTocPrompt(pageCount) {
  return [
    `这是《${pageCount} 页教材》开头的若干页扫描图,从 PDF 第 1 页开始连续排列。`,
    "",
    "任务:找出目录页的 PDF 页码,并列出这本书有哪些章。",
    "",
    "输出 JSON:",
    '{"tocFound":true,"tocPdfPages":[12,13,14,15],"chapters":[{"no":1,"title":"第1章 .NET Core 入门"}]}',
    "",
    "要求:",
    "1. tocPdfPages 用**从 1 开始**的 PDF 页码,列出目录所在的每一页。",
    "2. chapters 只写到「章」这一级,不要小节。",
    "3. 找不到目录就输出 tocFound:false。",
  ].join("\n");
}

function tocPagePrompt(pageNo) {
  return [
    `这是目录的第 ${pageNo} 页。`,
    "",
    "把这一页上出现的**所有**标题条目按出现顺序抄下来。",
    "",
    "输出 JSON:",
    '{"entries":[{"level":1,"no":"3","title":"第3章 .NET Core 核心基础组件","printedPage":53},',
    '{"level":2,"no":"3.1","title":"依赖注入","printedPage":53},',
    '{"level":3,"no":"3.1.1","title":"什么是控制反转、服务定位器和依赖注入","printedPage":53}]}',
    "",
    "要求:",
    "1. level 按目录缩进判断:章=1,节=2,小节=3。",
    "2. no 抄目录里的编号;没有编号就留空字符串。",
    "3. printedPage 抄目录右侧印的页码(书的印刷页码,不是 PDF 页码)。",
    "4. 标题要抄完整,不要截断、不要改写。",
    "5. 这一页没有目录内容就输出空数组。",
  ].join("\n");
}

/** Ask one page for the printed page number shown in its footer. */
function pageNumberPrompt() {
  return "这是教材的一页扫描图。只回答这一页**页脚印的页码数字**(不是 PDF 页码)。输出 JSON:{\"printedPage\": 31}。看不到就输出 null。";
}
/**
 * Sample three body pages to learn the difference between the PDF index and the
 * printed page number. Without this, citations drift by a constant on every
 * book and the learner cannot find the page they are told to read.
 */
export async function calibrateOffset(ctx, config, pdfPath, pageCount) {
  const samples = [0.25, 0.5, 0.75].map((ratio) => Math.min(pageCount - 1, Math.max(0, Math.round(pageCount * ratio))));
  const diffs = [];
  for (const index of samples) {
    try {
      const rendered = await renderPages(ctx.python, pdfPath, index, index, {
        dpi: 130, quality: 80, outdir: path.join(ctx.dataRoot, "pages", "calib"), prefix: `c${index}_`,
      });
      const reply = await complete(ctx, config, [
        { role: "system", content: EXTRACT_SYSTEM },
        { role: "user", content: [imageBlock(rendered.pages[0].file), textBlock(pageNumberPrompt())] },
      ], { maxTokens: 1200 });
      const parsed = parseJsonReply(reply.content || reply.reasoning);
      if (typeof parsed?.printedPage === "number") diffs.push(index + 1 - parsed.printedPage);
    } catch { /* one bad sample must not fail calibration */ }
  }
  if (diffs.length === 0) return 0;
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)];
}

/** Provider options for the explicit direct-HTTP override. */
export function providerOf(config, apiKey) {
  return {
    baseURL: config.baseURL,
    apiKey,
    model: config.model,
    retries: config.retries,
    reasoningEffort: config.reasoningEffort,
  };
}

/**
 * One completion, whichever transport this deployment uses.
 *
 * The default is the Harness LLM service, so the call rides the running DSH
 * account and no credential is ever configured. A deployment that names its own
 * `baseURL` opts into the direct transport, which is how this plugin was
 * developed but must never be the shipped default.
 */
export async function complete(ctx, config, messages, extra = {}) {
  const maxTokens = extra.maxTokens ?? config.maxOutputTokens;
  const needsImages = messages.some((message) => Array.isArray(message.content)
    && message.content.some((block) => block.type === "image_url"));
  const canUseLlm = Boolean(ctx.llmRoute) && (!needsImages || Boolean(ctx.attachments));

  if (canUseLlm) {
    const reply = await chatViaLlmService({
      llm: ctx.llmRoute.llm,
      provider: ctx.llmRoute.provider,
      model: ctx.llmRoute.model,
      reasoningEffort: config.reasoningEffort ?? ctx.llmRoute.reasoningEffort,
      messages,
      maxTokens,
      attachments: ctx.attachments,
      signal: extra.signal,
      timeoutMs: extra.timeoutMs ?? 300000,
    });
    // A long chapter can exhaust the output budget before the JSON closes. Retry
    // once with a doubled budget instead of failing a batch that was almost done.
    if (reply.finishReason === "length" && maxTokens < 32000) {
      return chatViaLlmService({
        llm: ctx.llmRoute.llm,
        provider: ctx.llmRoute.provider,
        model: ctx.llmRoute.model,
        reasoningEffort: config.reasoningEffort ?? ctx.llmRoute.reasoningEffort,
        messages,
        maxTokens: Math.min(32000, maxTokens * 2),
        attachments: ctx.attachments,
        signal: extra.signal,
        timeoutMs: extra.timeoutMs ?? 300000,
      });
    }
    return reply;
  }
  if (needsImages && !ctx.attachments) {
    // Reaching here means the LLM transport is available but this deployment did
    // not publish the attachment service, and the direct transport is the only
    // way to send page images. Say so precisely instead of failing per batch.
    throw new Error(
      "这个部署没有提供附件服务(ctx.attachments),无法通过 DSH 账户发送页面图片。" +
      "请在插件配置里指定 baseURL + apiKeyRef 以改用直连通道。",
    );
  }
  return chat({
    ...providerOf(config, ctx.apiKey),
    messages,
    maxTokens,
    signal: extra.signal,
    onRetry: extra.onRetry,
  });
}

/** Phase 1: find the table-of-contents pages and the chapter list. */
export async function locateToc(ctx, config, pdfPath, pageCount, bookTitle) {
  const last = Math.min(pageCount - 1, 29);
  const outdir = path.join(ctx.dataRoot, "pages", "toc");
  const rendered = await renderPages(ctx.python, pdfPath, 0, last, {
    dpi: Math.min(config.dpi, 130), quality: config.jpegQuality, outdir, prefix: "toc_",
  });
  const content = rendered.pages.map((page) => imageBlock(page.file));
  content.push(textBlock(locateTocPrompt(pageCount)));
  const reply = await complete(ctx, config, [
    { role: "system", content: EXTRACT_SYSTEM },
    { role: "user", content },
  ], { maxTokens: Math.max(config.maxOutputTokens, 6000) });
  const parsed = parseJsonReply(reply.content || reply.reasoning);
  if (!parsed?.tocFound) return { tocFound: false, tocPdfPages: [], chapters: [] };
  return {
    tocFound: true,
    tocPdfPages: (parsed.tocPdfPages ?? []).map(Number).filter((n) => Number.isFinite(n) && n >= 1 && n <= pageCount),
    chapters: (parsed.chapters ?? []).map((c) => ({ no: Number(c.no) || 0, title: String(c.title ?? "") })),
  };
}

/**
 * Phase 2: read the table of contents one page at a time. The whole TOC in one
 * reply overflows the output budget once reasoning is counted, so each page is
 * its own call and the results merge. Losing one page costs one page.
 */
export async function expandToc(ctx, config, pdfPath, tocPages, chapters) {
  const entries = [];
  for (const pdfPage of tocPages) {
    try {
      const rendered = await renderPages(ctx.python, pdfPath, pdfPage - 1, pdfPage - 1, {
        dpi: config.dpi, quality: config.jpegQuality, outdir: path.join(ctx.dataRoot, "pages", "toc"), prefix: "tocp_",
      });
      const reply = await complete(ctx, config, [
        { role: "system", content: EXTRACT_SYSTEM },
        { role: "user", content: [imageBlock(rendered.pages[0].file), textBlock(tocPagePrompt(pdfPage))] },
      ]);
      const parsed = parseJsonReply(reply.content || reply.reasoning);
      for (const entry of parsed?.entries ?? []) {
        const no = String(entry.no ?? "").trim();
        const title = String(entry.title ?? "").trim();
        if (!title) continue;
        entries.push({
          level: Number(entry.level) || no.split(".").length,
          no,
          title,
          printedPage: Number.isFinite(Number(entry.printedPage)) ? Number(entry.printedPage) : null,
          fromPdfPage: pdfPage,
        });
      }
    } catch (error) {
      ctx.warn?.(`toc page ${pdfPage} failed: ${String(error?.message || error)}`);
    }
  }
  return entries;
}

/** Assemble located chapters plus TOC entries into a page-anchored chapter map. */
export function assembleChapterMap(located, entries, pageOffset, pageCount) {
  const chapters = located.map((chapter) => ({ ...chapter, printedPage: null, sections: [] }));
  const byNo = new Map(chapters.map((chapter) => [String(chapter.no), chapter]));
  for (const entry of entries) {
    const head = String(entry.no || "").split(".")[0];
    let chapter = byNo.get(head);
    if (!chapter) chapter = chapters.find((c) => entry.level === 1 && entry.title.includes(String(c.no)));
    if (!chapter) continue;
    if (entry.level <= 1) {
      chapter.printedPage = chapter.printedPage ?? entry.printedPage;
      continue;
    }
    chapter.sections.push({ no: entry.no, title: entry.title, level: entry.level, printedPage: entry.printedPage });
    if (chapter.printedPage == null && entry.printedPage != null) chapter.printedPage = entry.printedPage;
  }
  // Even split for chapters whose printed page never resolved, so a usable map
  // still exists when the TOC is missing or unreadable.
  chapters.forEach((chapter, index) => {
    if (chapter.printedPage != null && pageOffset != null) {
      chapter.pdfPage = Math.max(1, Math.min(pageCount, chapter.printedPage + pageOffset));
    } else if (chapter.pdfPage == null) {
      chapter.pdfPage = Math.max(1, Math.round(((index + 1) * pageCount) / (chapters.length + 1)));
    }
  });
  for (let i = 0; i < chapters.length; i += 1) {
    if (chapters[i + 1] && chapters[i].pdfPage >= chapters[i + 1].pdfPage) {
      chapters[i + 1].pdfPage = Math.min(pageCount, chapters[i].pdfPage + 1);
    }
  }
  return chapters.sort((a, b) => a.no - b.no);
}

/** Discover the chapter map: locate the TOC, then page through it. */
export async function buildChapterMap(ctx, config, pdfPath, pageCount, bookTitle, pageOffset = 0) {
  const located = await locateToc(ctx, config, pdfPath, pageCount, bookTitle);
  if (!located.tocFound) return { tocFound: false, tocPdfPages: [], chapters: [] };
  const entries = await expandToc(ctx, config, pdfPath, located.tocPdfPages, located.chapters);
  const chapters = assembleChapterMap(located.chapters, entries, pageOffset, pageCount);
  return { tocFound: true, tocPdfPages: located.tocPdfPages, chapters, entries: entries.length };
}

/** Run one batch: render, extract, validate, persist. Idempotent by batch id. */
export async function runBatch(ctx, config, book, batch, signal) {
  const partial = path.join(ctx.paths.partialDir, `${batch.id}.json`);
  if (fs.existsSync(partial)) return readJson(partial, null);

  const rendered = await renderPages(ctx.python, book.pdfPath, batch.first, batch.last, {
    dpi: config.dpi, quality: config.jpegQuality, outdir: ctx.paths.pages, prefix: `p`, signal,
  });
  const content = rendered.pages.map((page) => imageBlock(page.file));
  content.push(textBlock(extractPrompt({ ...batch, bookTitle: book.title })));

  const reply = await complete(ctx, config, [
    { role: "system", content: EXTRACT_SYSTEM },
    { role: "user", content },
  ], { signal });

  const parsed = parseJsonReply(reply.content || reply.reasoning);
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  const problems = [];
  const accepted = [];
  for (const item of items) {
    const section = String(item.section ?? "").trim();
    if (!section) { problems.push("item without section"); continue; }
    const pdfPage = Number(item.pdfPage);
    if (!Number.isFinite(pdfPage) || pdfPage < batch.first + 1 || pdfPage > batch.last + 1) {
      problems.push(`${section}: pdfPage ${item.pdfPage} outside ${batch.first + 1}-${batch.last + 1}`);
    }
    if (!String(item.claim ?? "").trim()) { problems.push(`${section}: empty claim`); continue; }
    accepted.push({
      section,
      title: String(item.title ?? "").trim() || section,
      claim: String(item.claim).trim(),
      evidence: String(item.evidence ?? "").trim(),
      badCode: String(item.badCode ?? ""),
      goodCode: String(item.goodCode ?? ""),
      language: String(item.language ?? "").trim() || undefined,
      pitfalls: Array.isArray(item.pitfalls) ? item.pitfalls.map(String).filter(Boolean) : [],
      tags: Array.isArray(item.tags)
        ? item.tags.map(String).flatMap((tag) => tag.replace(/^#+/, "").split(/[\s,，、]+/)).map((tag) => tag.trim()).filter(Boolean)
        : [],
      pdfPage: Number.isFinite(pdfPage) ? pdfPage : batch.first + 1,
      confidence: String(item.confidence ?? "medium"),
    });
  }
  const result = {
    batchId: batch.id,
    chapterNo: batch.chapterNo,
    chapterTitle: batch.chapterTitle,
    first: batch.first,
    last: batch.last,
    items: accepted,
    problems,
    usage: reply.usage,
    model: reply.model,
    at: new Date().toISOString(),
  };
  writeJson(partial, result);
  return result;
}

/** Group a chapter's pages into render batches of at most `batchPages`. */
export function planBatches(book) {
  const chapters = book.chapters ?? [];
  const batches = [];
  for (const chapter of chapters) {
    const start = chapter.pdfPage - 1;
    const next = chapters.find((c) => c.no === chapter.no + 1);
    const end = (next?.pdfPage ? next.pdfPage - 1 : book.pageCount) - 1;
    if (start < 0 || end < start) continue;
    const size = Math.max(1, Number(book.batchPages) || 15);
    for (let first = start; first <= end; first += size) {
      const last = Math.min(end, first + size - 1);
      batches.push({
        id: `c${String(chapter.no).padStart(2, "0")}-${String(first + 1).padStart(4, "0")}`,
        chapterNo: chapter.no,
        chapterTitle: chapter.title,
        first,
        last,
        pageCount: last - first + 1,
        printFrom: first + 1 - (book.pageOffset ?? 0),
        printTo: last + 1 - (book.pageOffset ?? 0),
        sections: chapter.sections ?? [],
      });
    }
  }
  return batches;
}

/** Merge every batch of one chapter into `kp/NN-title.md`. */
export function mergeChapter(ctx, book, chapterNo) {
  const chapter = (book.chapters ?? []).find((c) => c.no === chapterNo);
  if (!chapter) return null;
  const files = fs.existsSync(ctx.paths.partialDir)
    ? fs.readdirSync(ctx.paths.partialDir).filter((name) => name.startsWith(`c${String(chapterNo).padStart(2, "0")}-`) && name.endsWith(".json"))
    : [];
  if (files.length === 0) return null;
  const seen = new Set();
  const kps = [];
  let n = 0;
  for (const name of files.sort()) {
    const data = readJson(path.join(ctx.paths.partialDir, name), null);
    if (!data) continue;
    for (const item of data.items ?? []) {
      const key = item.section || item.title;
      if (seen.has(key)) continue;
      seen.add(key);
      n += 1;
      kps.push({
        id: `KP-${String(chapterNo).padStart(2, "0")}${String(n).padStart(2, "0")}`,
        title: item.title,
        section: item.section,
        printPage: item.pdfPage - (book.pageOffset ?? 0),
        pdfPage: item.pdfPage,
        tags: item.tags,
        prereq: [],
        era: null,
        claim: item.claim,
        evidence: item.evidence,
        badCode: item.badCode,
        goodCode: item.goodCode,
        language: item.language,
        pitfalls: item.pitfalls,
      });
    }
  }
  const cleanTitle = String(chapter.title || "").replace(/^第\s*\d+\s*章\s*/, "");
  const header = [`# 第 ${chapterNo} 章 ${cleanTitle}`, "", `> 由 PDF 第 ${chapter.pdfPage} 页起自动抽取,共 ${kps.length} 个知识点。`, "", "---", ""].join("\n");
  const body = kps.map(renderKp).join("\n---\n\n");
  const file = path.join(ctx.paths.kpDir, kpFileName(chapter));
  fs.writeFileSync(file, header + body, "utf8");
  return { file, count: kps.length };
}