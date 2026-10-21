import fs from "node:fs";
import path from "node:path";
import { bookPaths, readJson, writeJson } from "./config.js";
import { planBatches, runBatch as defaultRunBatch, mergeChapter } from "./ingest.js";
import { rebuildIndex } from "./store.js";

/**
 * Batch scheduler for one book build.
 *
 * The provider answers 503 often enough that all batches succeeding in one pass
 * is not a realistic assumption, so every batch is persisted on its own and the
 * job is resumable: a failure costs one batch, never the whole book.
 *
 * Four states matter to the UI:
 *   running  — workers are in flight
 *   paused   — the learner pressed 暂停; in-flight batches were dropped, the
 *              finished ones were merged, and a later resume picks up the rest
 *   done / partial / failed — the run settled on its own
 */

export function newJob(book, batches) {
  return {
    id: `build-${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    status: "running",
    bookDir: book.bookDir,
    title: book.title,
    totalBatches: batches.length,
    doneBatches: 0,
    failedBatches: 0,
    batches: batches.map((batch) => ({
      id: batch.id,
      chapterNo: batch.chapterNo,
      chapterTitle: batch.chapterTitle,
      first: batch.first,
      last: batch.last,
      status: "pending",
      attempts: 0,
      error: null,
    })),
    log: [],
  };
}

export function jobPath(paths, jobId) {
  return path.join(paths.jobs, `${jobId}.json`);
}

export function loadJob(paths, jobId) {
  return readJson(jobPath(paths, jobId), null);
}

export function saveJob(paths, job) {
  writeJson(jobPath(paths, job.id), job);
}

export function latestJob(paths) {
  if (!fs.existsSync(paths.jobs)) return null;
  const files = fs.readdirSync(paths.jobs).filter((name) => name.endsWith(".json")).sort();
  if (files.length === 0) return null;
  return readJson(path.join(paths.jobs, files[files.length - 1]), null);
}

function note(job, message) {
  job.log.push(`${new Date().toISOString()} ${message}`);
  if (job.log.length > 200) job.log = job.log.slice(-200);
}

/**
 * Publish what is finished so far: merge every chapter that has at least one
 * done batch and rebuild `kp/index.json` from the Markdown.
 *
 * This runs after every batch, not only at the end, because a build is useful
 * long before it is complete — the learner can study chapter 1 while chapter 9
 * is still being extracted. It is also what keeps `index.json` honest: nothing
 * else in the plugin wrote it, so a crash used to leave it pointing at the old
 * build forever.
 */
function publish(runtime, job) {
  const chapters = [...new Set(
    job.batches.filter((entry) => entry.status === "done").map((entry) => entry.chapterNo),
  )].sort((a, b) => a - b);
  const merged = [];
  for (const chapterNo of chapters) {
    try {
      const result = mergeChapter(runtime, { ...runtime.book, batchPages: runtime.config.batchPages }, chapterNo);
      if (result) merged.push({ chapterNo, ...result });
    } catch (error) {
      note(job, `merge chapter ${chapterNo} failed: ${String(error?.message || error)}`);
    }
  }
  job.merged = merged;
  try {
    const index = rebuildIndex(runtime.bookDir, runtime.book);
    job.kps = index.count;
  } catch (error) {
    note(job, `index rebuild failed: ${String(error?.message || error)}`);
  }
}

/** Execute the whole job with bounded concurrency, resuming finished batches. */
export async function runJob(runtime, job, options = {}) {
  const { config } = runtime;
  const signal = options.signal;
  // Injectable so the pause/resume contract can be exercised without a model.
  const runBatch = options.runBatch ?? defaultRunBatch;
  const batches = planBatches({ ...runtime.book, batchPages: config.batchPages });
  const byId = new Map(batches.map((batch) => [batch.id, batch]));

  // A paused run can leave entries marked running: their request was aborted and
  // nothing was persisted, so they are pending again rather than failed.
  for (const entry of job.batches) if (entry.status === "running") entry.status = "pending";

  const pending = job.batches.filter((entry) => entry.status !== "done");
  const concurrency = Math.max(1, Math.min(8, config.concurrency ?? 3));
  let cursor = 0;

  note(job, `start: ${pending.length} pending, concurrency ${concurrency}`);
  saveJob(runtime.paths, job);

  const worker = async () => {
    while (cursor < pending.length) {
      if (signal?.aborted) return;
      const entry = pending[cursor];
      cursor += 1;
      const batch = byId.get(entry.id);
      if (!batch) {
        entry.status = "failed";
        entry.error = "batch plan drift";
        saveJob(runtime.paths, job);
        continue;
      }
      entry.status = "running";
      entry.attempts += 1;
      saveJob(runtime.paths, job);
      try {
        const result = await runBatch(runtime, config, { ...runtime.book, batchPages: config.batchPages }, batch, signal);
        entry.status = "done";
        entry.items = result.items.length;
        entry.problems = result.problems;
        note(job, `${entry.id} ok (${result.items.length} kp)`);
      } catch (error) {
        if (signal?.aborted) {
          // Pause is not a failure: it must not consume the retry budget or be
          // reported to the learner as a model error.
          entry.status = "pending";
          entry.error = null;
          note(job, `${entry.id} paused`);
        } else {
          entry.status = "failed";
          entry.error = String(error?.message || error).slice(0, 400);
          note(job, `${entry.id} failed: ${entry.error}`);
        }
      }
      job.doneBatches = job.batches.filter((b) => b.status === "done").length;
      job.failedBatches = job.batches.filter((b) => b.status === "failed").length;
      publish(runtime, job);
      saveJob(runtime.paths, job);
      options.onProgress?.(job);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  publish(runtime, job);
  job.doneBatches = job.batches.filter((b) => b.status === "done").length;
  job.failedBatches = job.batches.filter((b) => b.status === "failed").length;
  if (signal?.aborted) {
    job.status = "paused";
    note(job, `paused (${job.doneBatches}/${job.totalBatches})`);
  } else {
    job.status = job.failedBatches === 0 ? "done" : (job.doneBatches > 0 ? "partial" : "failed");
    note(job, `finished: ${job.status} (${job.doneBatches}/${job.totalBatches})`);
  }
  job.finishedAt = new Date().toISOString();
  saveJob(runtime.paths, job);
  return job;
}

/**
 * Wipe a knowledge base so it can be rebuilt from the PDF.
 *
 * `kp/` and `jobs/` are moved under `.aiLearn/backup/` rather than deleted: a
 * wrong button press then costs a folder rename instead of a hand-corrected
 * library. `book.json` (chapter map, page offset) and the rendered pages are
 * kept, because re-deriving those costs model calls for no benefit.
 */
export function resetBuild(bookDir) {
  const paths = bookPaths(bookDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupRoot = path.join(paths.root, "backup");
  const backups = [];

  const move = (from, to) => {
    if (!fs.existsSync(from)) return false;
    fs.mkdirSync(backupRoot, { recursive: true });
    fs.renameSync(from, to);
    backups.push(to);
    return true;
  };

  try {
    if (move(paths.kpDir, path.join(backupRoot, `kp-${stamp}`))) fs.mkdirSync(paths.kpDir, { recursive: true });
    if (move(paths.jobs, path.join(backupRoot, `jobs-${stamp}`))) fs.mkdirSync(paths.jobs, { recursive: true });
  } catch (error) {
    throw new Error(`清空旧库失败(${String(error?.message || error)}),请先关闭占用这些文件的程序。`);
  }
  return { backups, stamp };
}
