import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRegistry, loadPacks, currentMode, setMode } from "../../host/capabilities.js";
import { makeBook, cleanup } from "../helpers/fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function modeOnly(id, overrides = {}) {
  return {
    id,
    apiVersion: 1,
    name: id,
    mode: { label: id, rules: "rules", tools: ["learn_status"], ...overrides },
  };
}

test("the built-in packs load and expose their modes", async () => {
  const registry = createRegistry();
  const result = await loadPacks(root, registry);

  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.loaded.sort(), ["beginner", "review", "sprint"]);
  assert.deepEqual(registry.modes().map((mode) => mode.id).sort(), ["beginner", "review", "sprint"]);
  assert.match(registry.mode("review").rules, /先出题/);
});

test("a broken pack is reported, not fatal", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ailearn-packs-"));
  try {
    const pack = path.join(dir, "plugins", "broken");
    fs.mkdirSync(pack, { recursive: true });
    fs.writeFileSync(path.join(pack, "plugin.json"), JSON.stringify({ id: "broken", apiVersion: 1, entry: "./host.js" }));
    fs.writeFileSync(path.join(pack, "host.js"), "export default { id: 'broken', apiVersion: 1, name: 'x', mode: { label: 'x' } };");

    const registry = createRegistry();
    const result = await loadPacks(dir, registry);
    assert.equal(result.loaded.length, 0);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].error, /rules/);
  } finally {
    cleanup(dir);
  }
});

test("duplicate ids and wrong apiVersion are rejected", () => {
  const registry = createRegistry();
  registry.register(modeOnly("alpha"));
  assert.throws(() => registry.register(modeOnly("alpha")), /duplicate/);
  assert.throws(() => registry.register({ ...modeOnly("beta"), apiVersion: 99 }), /apiVersion/);
  assert.throws(() => registry.register(modeOnly("gamma", { label: "" })), /label/);
});

test("mode choice persists per book and unknown ids are refused", (t) => {
  const fixture = makeBook({ chapters: 1 });
  t.after(() => cleanup(fixture.dir));

  const registry = createRegistry();
  registry.register(modeOnly("alpha"));
  registry.register(modeOnly("beta"));

  assert.equal(currentMode(fixture.dir, registry), "alpha", "defaults to the first registered mode");
  setMode(fixture.dir, registry, "beta");
  assert.equal(currentMode(fixture.dir, registry), "beta");
  assert.throws(() => setMode(fixture.dir, registry, "nope"), /unknown mode/);
});
