import test from "node:test";
import assert from "node:assert/strict";
import { makeBook, cleanup } from "../helpers/fixture.mjs";
import { appendEvent, rebuildMastery, coverageGap } from "../../host/progress.js";
import { renderKp, kpFileName, rebuildIndex } from "../../host/store.js";
import fs from "node:fs";
import path from "node:path";

test("mastery folds the event log: intervals, weakness, illusions", (t) => {
  const fixture = makeBook({ chapters: 1 });
  t.after(() => cleanup(fixture.dir));

  appendEvent(fixture.dir, { type: "attempt", kpId: "KP-0101", dimension: "recall", score: 1, confidence: 3 });
  appendEvent(fixture.dir, { type: "attempt", kpId: "KP-0101", dimension: "recall", score: 0.1, confidence: 5 });
  appendEvent(fixture.dir, { type: "attempt", kpId: "KP-0102", dimension: "apply", score: 0.9, confidence: 2 });

  const mastery = rebuildMastery(fixture.dir);
  const first = mastery.kps["KP-0101"];
  assert.equal(first.attempts, 2);
  assert.equal(first.correct, 1);
  assert.equal(first.illusions, 1, "high confidence + wrong answer is an illusion");
  assert.equal(first.intervalDays, 0, "a wrong answer resets the interval");
  assert.ok(Math.abs(first.ease - 2.4) < 1e-9, `expected ease 2.4, got ${first.ease}`);

  assert.equal(mastery.summary.total, 2);
  assert.equal(mastery.summary.illusions, 1);
  assert.equal(mastery.summary.weak, 1, "0.55 mean is under the 0.6 weakness line");
  assert.ok(Math.abs(mastery.summary.meanScore - 0.725) < 1e-9);
});

test("coverage counts knowledge points that were never assessed", (t) => {
  const fixture = makeBook({ chapters: 1 });
  t.after(() => cleanup(fixture.dir));

  const chapter = fixture.book.chapters[0];
  const file = path.join(fixture.paths.kpDir, kpFileName(chapter));
  fs.writeFileSync(file, [
    renderKp({ id: "KP-0101", title: "第一点", claim: "a" }),
    renderKp({ id: "KP-0102", title: "第二点", claim: "b" }),
  ].join("\n---\n\n"), "utf8");
  rebuildIndex(fixture.dir, fixture.book);
  appendEvent(fixture.dir, { type: "attempt", kpId: "KP-0101", dimension: "recall", score: 1 });

  const gap = coverageGap(fixture.dir, fixture.book);
  assert.equal(gap.total, 2);
  assert.equal(gap.assessed, 1);
  assert.deepEqual(gap.never.map((kp) => kp.id), ["KP-0102"]);
});
