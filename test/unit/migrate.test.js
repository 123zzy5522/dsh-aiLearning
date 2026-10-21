import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeBook, cleanup } from "../helpers/fixture.mjs";
import { renderKp, kpFileName, rebuildIndex, loadAllKps } from "../../host/store.js";
import { migrateKpIds, hasLegacyIds } from "../../host/migrate.js";
import { appendEvent, readEvents } from "../../host/progress.js";

function legacyBook(t) {
  const fixture = makeBook({ chapters: 1 });
  t.after(() => cleanup(fixture.dir));
  const file = path.join(fixture.paths.kpDir, kpFileName(fixture.book.chapters[0]));
  fs.writeFileSync(file, [
    renderKp({ id: "KP-0101", title: "第一点", section: "1.1", claim: "a" }),
    renderKp({ id: "KP-0102", title: "第二点", section: "1.2.3", claim: "b" }),
  ].join("\n---\n\n"), "utf8");
  rebuildIndex(fixture.dir, fixture.book);
  return { fixture, file };
}

test("positional ids become section ids and attempts follow", (t) => {
  const { fixture } = legacyBook(t);
  appendEvent(fixture.dir, { type: "attempt", kpId: "KP-0101", dimension: "recall", score: 1 });

  assert.equal(hasLegacyIds(fixture.dir), true);
  const report = migrateKpIds(fixture.dir);
  assert.equal(report.rewritten, 2);
  assert.equal(report.events, 1);
  assert.ok(fs.existsSync(report.backup), "the old markdown is backed up");

  const kps = loadAllKps(fixture.dir, fixture.book);
  assert.deepEqual(kps.map((kp) => kp.id), ["KP-01-1.1", "KP-01-1.2.3"]);
  assert.equal(readEvents(fixture.dir)[0].kpId, "KP-01-1.1");
  assert.equal(hasLegacyIds(fixture.dir), false);
});

test("migration is idempotent", (t) => {
  const { fixture } = legacyBook(t);
  migrateKpIds(fixture.dir);
  const again = migrateKpIds(fixture.dir);
  assert.equal(again.rewritten, 0);
  assert.equal(again.chapters, 0);
  assert.deepEqual(again.mapping, {});
});

test("ids without a numeric section fall back to a title hash", (t) => {
  const fixture = makeBook({ chapters: 1 });
  t.after(() => cleanup(fixture.dir));
  const file = path.join(fixture.paths.kpDir, kpFileName(fixture.book.chapters[0]));
  fs.writeFileSync(file, renderKp({ id: "KP-0101", title: "本章小结", claim: "x" }), "utf8");
  rebuildIndex(fixture.dir, fixture.book);

  migrateKpIds(fixture.dir);
  const [kp] = loadAllKps(fixture.dir, fixture.book);
  assert.match(kp.id, /^KP-01-h[a-z0-9]+$/);
});
