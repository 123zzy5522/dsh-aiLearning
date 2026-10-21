/**
 * End-to-end smoke test: no model, no Python, no network.
 *
 * It exercises the path a user actually walks — build a library, merge it,
 * publish the index, read the UI snapshot — using the same modules the plugin
 * ships. If this fails, the plugin is broken regardless of what the model does.
 */
import assert from "node:assert/strict";
import { makeBook, makeRuntime, makeStubBatch, makeFakeContext, request, cleanup } from "./helpers/fixture.mjs";
import { runJob, newJob, saveJob } from "../host/job.js";
import { planBatches } from "../host/ingest.js";
import { readJson } from "../host/config.js";
import { apply, Config } from "../index.js";

const passed = [];
function pass(name) {
  passed.push(name);
  console.log(`PASS  ${name}`);
}

const fixture = makeBook({ chapters: 2, title: "冒烟测试书" });
try {
  const runtime = makeRuntime(fixture, { concurrency: 2 });
  const batches = planBatches({ ...fixture.book, batchPages: 12 });
  const job = newJob({ ...fixture.book, bookDir: fixture.dir }, batches);
  saveJob(fixture.paths, job);

  const controller = new AbortController();
  await runJob(runtime, job, { signal: controller.signal, runBatch: makeStubBatch({ delayMs: 10 }) });
  assert.equal(job.status, "done");
  assert.equal(job.doneBatches, batches.length);
  assert.equal(job.failedBatches, 0);
  pass(`build ${batches.length} batches → done`);

  const index = readJson(fixture.paths.index, { kps: [] });
  assert.equal(index.kps.length, batches.length);
  assert.deepEqual([...new Set(index.kps.map((kp) => kp.chapter))], [1, 2]);
  pass(`index rebuilt from markdown: ${index.kps.length} kps / 2 chapters`);

  const { ctx, handler } = makeFakeContext();
  apply(ctx, Config["~standard"].validate({}).value);
  const route = handler();

  const snapshot = await request(route, "GET", `/dsh-ailearn/api/build?dir=${encodeURIComponent(fixture.dir)}`);
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.apiVersion, 1);
  assert.equal(snapshot.body.library.kps, index.kps.length);
  assert.equal(snapshot.body.learning.ready, true);
  assert.equal(snapshot.body.build.state, "done");
  pass("GET /build matches disk and reports ready");

  const paused = await request(route, "POST", "/dsh-ailearn/api/build/pause", { dir: fixture.dir });
  assert.equal(paused.body.code, "build/none-running");
  pass("pause with no worker returns a code");

  console.log(`\nsmoke: ${passed.length}/${passed.length} passed`);
} finally {
  cleanup(fixture.dir);
}
