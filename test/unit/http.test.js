import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeBook, makeFakeContext, request, cleanup } from "../helpers/fixture.mjs";
import { apply, Config } from "../../index.js";
import { renderKp, kpFileName, rebuildIndex } from "../../host/store.js";

function boot() {
  const { ctx, handler } = makeFakeContext();
  apply(ctx, Config["~standard"].validate({}).value);
  assert.ok(handler(), "apply must register the API route");
  return handler();
}

function bookWithOneKp(t) {
  const fixture = makeBook({ chapters: 1 });
  t.after(() => cleanup(fixture.dir));
  const file = path.join(fixture.paths.kpDir, kpFileName(fixture.book.chapters[0]));
  fs.writeFileSync(file, renderKp({ id: "KP-0101", title: "示例知识点", claim: "一句话" }), "utf8");
  rebuildIndex(fixture.dir, fixture.book);
  return fixture;
}

test("GET /build returns one versioned snapshot the UI can render", async (t) => {
  const fixture = bookWithOneKp(t);
  const route = boot();
  const { status, body } = await request(route, "GET", `/dsh-ailearn/api/build?dir=${encodeURIComponent(fixture.dir)}`);

  assert.equal(status, 200);
  assert.equal(body.apiVersion, 1);
  assert.equal(body.dir, fixture.dir);
  assert.equal(body.library.kps, 1);
  assert.equal(body.build.state, "idle");
  assert.equal(body.learning.ready, true);
  assert.equal(body.learning.unseen, 1);
  assert.ok(Array.isArray(body.modes) && body.modes.length >= 1, "plugin packs are exposed to the UI");
  assert.ok(body.modes.some((mode) => mode.id === "review"));
  assert.equal(body.mode, "beginner", "defaults to the first installed mode");
});

test("mode selection is persisted and unknown modes are refused", async (t) => {
  const fixture = bookWithOneKp(t);
  const route = boot();

  const switched = await request(route, "POST", "/dsh-ailearn/api/mode", { dir: fixture.dir, mode: "review" });
  assert.equal(switched.status, 200);
  assert.equal(switched.body.ok, true);
  assert.equal(switched.body.mode.id, "review");

  const snapshot = await request(route, "GET", `/dsh-ailearn/api/build?dir=${encodeURIComponent(fixture.dir)}`);
  assert.equal(snapshot.body.mode, "review");

  const bad = await request(route, "POST", "/dsh-ailearn/api/mode", { dir: fixture.dir, mode: "nope" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "mode/unknown");
});

test("errors carry a stable code, not just a sentence", async (t) => {
  const fixture = bookWithOneKp(t);
  const route = boot();

  const badRequest = await request(route, "POST", "/dsh-ailearn/api/build/start", {});
  assert.equal(badRequest.status, 400);
  assert.equal(badRequest.body.ok, false);
  assert.equal(badRequest.body.code, "api/no-dir");

  const paused = await request(route, "POST", "/dsh-ailearn/api/build/pause", { dir: fixture.dir });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.ok, false);
  assert.equal(paused.body.code, "build/none-running");

  const unknown = await request(route, "GET", "/dsh-ailearn/api/nope");
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.code, "api/unknown-route");
});

test("unknown directories are reported as no book, not as a crash", async (t) => {
  const route = boot();
  const missing = path.join(process.env.TEMP ?? "/tmp", `ailearn-missing-${Date.now()}`);
  const { status, body } = await request(route, "GET", `/dsh-ailearn/api/build?dir=${encodeURIComponent(missing)}`);
  assert.equal(status, 200);
  assert.equal(body.book, null);
  assert.equal(body.learning.ready, false);
  assert.equal(fs.existsSync(missing), false, "a status read must not create directories");
});
