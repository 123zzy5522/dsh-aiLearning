import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeBook, cleanup } from "../helpers/fixture.mjs";
import { renderKp, parseKpMarkdown, kpFileName, rebuildIndex, loadAllKps } from "../../host/store.js";

const SAMPLE = {
  id: "KP-0101",
  title: "using 声明简化嵌套并自动释放资源",
  section: "1.2.3",
  printPage: 16,
  pdfPage: 32,
  tags: ["using声明", "资源释放"],
  claim: "using 声明在变量离开作用域时自动调用 Dispose。",
  evidence: "原文第一行\n原文第二行",
  badCode: "## 这不是知识点标题\nusing (var a = Open())\n{\n    using (var b = Open2()) { }\n}",
  goodCode: "using var a = Open();\nusing var b = Open2();",
  language: "csharp",
  pitfalls: ["以为可以手动指定释放时机"],
};

test("markdown round-trip keeps every field the tutor needs", (t) => {
  const fixture = makeBook({ chapters: 1 });
  t.after(() => cleanup(fixture.dir));

  const text = renderKp(SAMPLE);
  const parsed = parseKpMarkdown(text);
  assert.equal(parsed.length, 1, "a code fence containing '## ' must not split the block");
  const kp = parsed[0];
  assert.equal(kp.id, SAMPLE.id);
  assert.equal(kp.title, SAMPLE.title);
  assert.equal(kp.section, SAMPLE.section);
  assert.equal(kp.printPage, SAMPLE.printPage);
  assert.equal(kp.pdfPage, SAMPLE.pdfPage);
  assert.deepEqual(kp.tags, SAMPLE.tags);
  assert.equal(kp.claim, SAMPLE.claim);
  assert.equal(kp.evidence, SAMPLE.evidence);
  assert.equal(kp.language, "csharp");
  assert.match(kp.badCode, /## 这不是知识点标题/);
  assert.equal(kp.goodCode, SAMPLE.goodCode);
  assert.deepEqual(kp.pitfalls, SAMPLE.pitfalls);

  fs.writeFileSync(path.join(fixture.paths.kpDir, kpFileName(fixture.book.chapters[0])), text, "utf8");
  const index = rebuildIndex(fixture.dir, fixture.book);
  assert.equal(index.count, 1);
  assert.equal(index.kps[0].chapter, 1);
  assert.equal(index.kps[0].id, SAMPLE.id);
  assert.equal(loadAllKps(fixture.dir, fixture.book).length, 1);
});

test("index is derived: deleting the markdown empties it", (t) => {
  const fixture = makeBook({ chapters: 1 });
  t.after(() => cleanup(fixture.dir));

  const file = path.join(fixture.paths.kpDir, kpFileName(fixture.book.chapters[0]));
  fs.writeFileSync(file, renderKp({ ...SAMPLE, id: "KP-0101" }), "utf8");
  assert.equal(rebuildIndex(fixture.dir, fixture.book).count, 1);

  fs.rmSync(file);
  assert.equal(rebuildIndex(fixture.dir, fixture.book).count, 0);
});
