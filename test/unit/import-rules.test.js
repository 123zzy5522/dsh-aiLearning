import test from "node:test";
import assert from "node:assert/strict";
import { violationFor, collectViolations } from "../../scripts/import-rules.mjs";

// Regression tests for issue #4: the old checker only looked at zone names, so
// the sdk escape branch was unreachable and plugin-to-plugin imports passed.

test("sdk cannot escape into host through a relative import", () => {
  const violations = collectViolations("sdk/tmp-escape.js", 'import { readJson } from "../host/store.js";');
  assert.equal(violations.length, 1);
  assert.match(violations[0], /sdk must not import outside sdk/);
});

test("side-effect imports are checked too", () => {
  // This exact shape (`import "…"` with no `from`) passed the first version of
  // the checker because the specifier regex only matched `from` / `require(`.
  const sdkEscape = collectViolations("sdk/tmp-escape.js", 'import "../host/store.js";');
  assert.equal(sdkEscape.length, 1);

  const sideways = collectViolations("plugins/alpha/host.js", 'import "../beta/host.js";');
  assert.equal(sideways.length, 1);
  assert.match(sideways[0], /sideways import/);
});

test("a plugin cannot import another plugin sideways", () => {
  const violations = collectViolations("plugins/alpha/host.js", 'import { x } from "../beta/host.js";');
  assert.equal(violations.length, 1);
  assert.match(violations[0], /sideways import/);
});

test("a plugin may import sdk and its own files", () => {
  assert.equal(violationFor("plugins/alpha/host.js", "../../sdk/index.js"), null);
  assert.equal(violationFor("plugins/alpha/host.js", "./util.js"), null);
});

test("a plugin may not import host internals or the filesystem", () => {
  assert.match(violationFor("plugins/alpha/host.js", "../../host/store.js"), /must not import host/);
  assert.match(violationFor("plugins/alpha/host.js", "node:fs"), /storage service/);
  assert.match(violationFor("plugins/alpha/host.js", "node:child_process"), /storage service/);
  assert.equal(violationFor("plugins/alpha/host.js", "node:path"), null);
});

test("the client bundle may import react and sdk, never node or host", () => {
  assert.equal(violationFor("client/src/index.js", "react"), null);
  assert.equal(violationFor("client/src/index.js", "../../sdk/protocol.js"), null);
  assert.match(violationFor("client/src/index.js", "../../host/store.js"), /must not import host/);
  assert.match(violationFor("client/src/index.js", "node:fs"), /must not import node:/);
});

test("sdk stays isomorphic", () => {
  assert.match(violationFor("sdk/protocol.js", "node:fs"), /isomorphic/);
  assert.equal(violationFor("sdk/codes.js", "./protocol.js"), null);
});

test("host may import sdk and node builtins, never a plugin", () => {
  assert.equal(violationFor("host/job.js", "node:fs"), null);
  assert.equal(violationFor("host/job.js", "../sdk/index.js"), null);
  assert.match(violationFor("host/job.js", "../plugins/mode-draw/host.js"), /must not import plugin/);
});

test("relative imports may not escape the repository", () => {
  assert.match(violationFor("sdk/protocol.js", "../../../etc/passwd.js"), /escapes the repository/);
});

test("tooling is unrestricted", () => {
  assert.equal(violationFor("test/unit/http.test.js", "../../host/job.js"), null);
  assert.equal(violationFor("test/unit/http.test.js", "node:test"), null);
  assert.equal(violationFor("scripts/build-client.mjs", "esbuild"), null);
});
