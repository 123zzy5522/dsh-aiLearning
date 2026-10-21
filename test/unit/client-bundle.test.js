import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const code = fs.readFileSync(path.join(root, "client.js"), "utf8");

/**
 * The bundle is the only artifact DSH actually loads, and a broken one is
 * invisible until someone opens the panel in a browser. Evaluating it in a VM
 * with stub globals catches the cheap failures (bad wrapper, throwing top-level
 * code, missing export) before a push.
 */
test("the built client bundle registers a loadable plugin", () => {
  let captured = null;
  const storage = new Map();
  const context = {
    window: {
      __ModuleLoader__: { load: (entry) => { captured = entry; } },
      innerWidth: 1280,
      innerHeight: 800,
      addEventListener() {},
      removeEventListener() {},
    },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, String(value)),
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(code, context, { filename: "client.js" });

  assert.ok(captured, "the bundle must call window.__ModuleLoader__.load");
  assert.equal(captured.id, "dsh-ailearn");

  const react = {
    createElement: () => null,
    Fragment: {},
    useReducer: () => [0, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: {} }),
    useCallback: (fn) => fn,
  };
  const exports = captured.factory((name) => {
    if (name === "react") return react;
    throw new Error(`unexpected require("${name}") in the client bundle`);
  });

  assert.equal(typeof exports.apply, "function", "the plugin must export apply()");
  // The array comes from another VM realm, so compare contents instead of
  // prototype identity (deepStrictEqual also checks the prototype chain).
  const inject = Array.from(exports.inject);
  assert.ok(inject.includes("slots"), "the panel registers through slots");
  assert.ok(inject.includes("sessions"), "opening a study session needs the sessions service");
});
