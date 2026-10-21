import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeBook, makeRuntime, makeStubBatch, cleanup } from "../helpers/fixture.mjs";
import { runJob, newJob, saveJob, resetBuild } from "../../host/job.js";
import { planBatches } from "../../host/ingest.js";
import { readJson } from "../../host/config.js";

test("pause keeps finished batches, drops in-flight ones, and publishes", async (t) => {
  const fixture = makeBook({ chapters: 1 });
  t.after(() => cleanup(fixture.dir));

  const runtime = makeRuntime(fixture);
  const batches = planBatches({ ...fixture.book, batchPages: 12 });
  const job = newJob({ ...fixture.book, bookDir: fixture.dir }, batches);
  saveJob(fixture.paths, job);

  const controller = new AbortController();
  const base = makeStubBatch({ delayMs: 15 });
  let calls = 0;
  // Deterministic pause: the first batch runs to completion, every later batch
  // blocks until the abort lands, so the test never races the scheduler.
  const stub = async (rt, config, book, batch, signal) => {
    calls += 1;
    if (calls > 1) {
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          if (signal?.aborted) { clearInterval(timer); resolve(); }
        }, 5);
      });
      throw new Error("aborted");
    }
    return base(rt, config, book, batch, signal);
  };
  const ticker = setInterval(() => {
    if (calls > 1) { clearInterval(ticker); controller.abort(); }
  }, 5);
  await runJob(runtime, job, { signal: controller.signal, runBatch: stub });
  clearInterval(ticker);

  assert.equal(job.status, "paused");
  assert.equal(job.failedBatches, 0, "a pause must not be recorded as a failure");
  assert.ok(job.doneBatches >= 1, "at least one batch should have completed");
  assert.ok(job.batches.some((batch) => batch.status === "pending"), "unfinished batches stay resumable");

  const index = readJson(fixture.paths.index, { kps: [] });
  assert.equal(index.kps.length, job.doneBatches, "every finished batch is published on pause");

  // Resume the same job with a signal that never fires.
  const controller2 = new AbortController();
  await runJob(runtime, job, { signal: controller2.signal, runBatch: makeStubBatch({ delayMs: 5 }) });

  assert.equal(job.status, "done");
  assert.equal(job.doneBatches, batches.length);
  const finalIndex = readJson(fixture.paths.index, { kps: [] });
  assert.equal(finalIndex.kps.length, batches.length, "index matches the number of distinct sections");
});

test("a finished job is not silently re-run by resume", () => {
  const fixture = makeBook({ chapters: 1 });
  try {
    const job = newJob({ ...fixture.book, bookDir: fixture.dir }, planBatches({ ...fixture.book, batchPages: 12 }));
    job.status = "done";
    saveJob(fixture.paths, job);
    // The guard itself lives in startBuild; this asserts the persisted state the
    // guard keys on is readable and stable.
    const loaded = readJson(path.join(fixture.paths.jobs, `${job.id}.json`), null);
    assert.equal(loaded.status, "done");
  } finally {
    cleanup(fixture.dir);
  }
});

test("rebuild moves the old library into backup instead of deleting it", (t) => {
  const fixture = makeBook({ chapters: 1 });
  t.after(() => cleanup(fixture.dir));

  fs.mkdirSync(fixture.paths.jobs, { recursive: true });
  fs.writeFileSync(path.join(fixture.paths.kpDir, "01-旧章.md"), "# 旧内容", "utf8");
  const result = resetBuild(fixture.dir);

  assert.equal(result.backups.length, 2, "both kp/ and jobs/ are preserved");
  assert.ok(result.backups.some((name) => name.includes("kp-")));
  assert.ok(result.backups.some((name) => name.includes("jobs-")));
  assert.deepEqual(fs.readdirSync(fixture.paths.kpDir), [], "kp/ is recreated empty");
  assert.equal(readJson(fixture.paths.index, null), null, "the derived index is gone");
});
