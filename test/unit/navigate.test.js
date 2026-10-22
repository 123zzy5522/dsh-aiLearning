import test from "node:test";
import assert from "node:assert/strict";
import { openSession, waitForSession } from "../../client/src/navigate.js";

/** Minimal stand-in for the client `sessions` service. */
function fakeSessions(initialIds = [], onRefresh) {
  const byId = Object.fromEntries(initialIds.map((id) => [id, { id }]));
  return {
    byId,
    refreshCalls: 0,
    list: { getSnapshot: () => ({ ids: Object.keys(byId), byId: { ...byId } }) },
    async refresh() {
      this.refreshCalls += 1;
      await onRefresh?.(byId);
    },
  };
}

test("openSession does nothing when the shell publishes no uiWorkspace", async () => {
  const opened = await openSession({ sessions: fakeSessions(["session-1"]) }, "session-1");
  assert.equal(opened, false);
});

test("openSession waits for the async catalog row, then switches the main view", async () => {
  // The host creates the session over HTTP; the browser catalog learns about it
  // from a later event. Opening before that throws "unknown session".
  const sessions = fakeSessions([], async (byId) => {
    byId["session-9"] = { id: "session-9" };
  });
  const calls = [];
  const services = { sessions, uiWorkspace: { openSession: (id) => calls.push(id) } };

  const opened = await openSession(services, "session-9", { attempts: 20, delayMs: 1 });

  assert.equal(opened, true);
  assert.equal(sessions.refreshCalls, 1, "a refresh is attempted before polling");
  assert.deepEqual(calls, ["session-9"]);
});

test("openSession reports failure when the shell rejects the target", async () => {
  const services = {
    sessions: fakeSessions(["session-1"]),
    uiWorkspace: { openSession: () => { throw new Error("sessions.retain: unknown session"); } },
  };
  assert.equal(await openSession(services, "session-1"), false);
});

test("waitForSession gives up without a sessions service", async () => {
  assert.equal(await waitForSession(undefined, "session-1", { attempts: 2, delayMs: 1 }), false);
});

test("waitForSession returns immediately when the catalog already lists it", async () => {
  const sessions = fakeSessions(["session-1"]);
  assert.equal(await waitForSession(sessions, "session-1"), true);
  assert.equal(sessions.refreshCalls, 0, "no unnecessary baseline pull");
});
