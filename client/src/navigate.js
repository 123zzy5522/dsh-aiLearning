/**
 * The seam between the ailearn panel and the shell's main view.
 *
 * The shell exposes "select this Session and show its Conversation" on the
 * `uiWorkspace` service (`openSession`), not on `sessions`: that one only
 * retains a Session and opens its history. Keeping the call here makes the
 * requirement testable without a browser.
 */

/**
 * Wait until the browser's Session catalog lists `sessionId`.
 *
 * The ailearn host creates the Session through its own controller, so the
 * browser learns about it from the asynchronous `api-session/added` event,
 * which can land after the `/open` response. Opening before that row exists
 * makes the shell throw `sessions.retain: unknown session`; a list refresh
 * followed by a short poll closes that race.
 *
 * @param {object|undefined} sessions - the client `sessions` service.
 * @param {string} sessionId - the Session the host just returned.
 * @param {{attempts?: number, delayMs?: number}} [options] - poll budget.
 * @returns {Promise<boolean>} whether the catalog now lists the Session.
 */
export async function waitForSession(sessions, sessionId, options = {}) {
  const { attempts = 20, delayMs = 50 } = options;
  const known = () => Boolean(sessions?.list?.getSnapshot?.()?.byId?.[sessionId]);
  if (sessions === undefined || known()) return known();
  if (typeof sessions.refresh === "function") {
    try {
      await sessions.refresh();
    } catch {
      /* offline or busy; the event may still arrive */
    }
  }
  for (let attempt = 0; attempt < attempts && !known(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return known();
}

/**
 * Switch the shell's main view to a Session the host has already created.
 *
 * @param {{uiWorkspace?: object, sessions?: object}} services - client services.
 * @param {string|null|undefined} sessionId - Session to show.
 * @param {{attempts?: number, delayMs?: number}} [options] - poll budget.
 * @returns {Promise<boolean>} whether navigation was requested successfully.
 */
export async function openSession(services, sessionId, options = {}) {
  if (!sessionId) return false;
  const workspace = services?.uiWorkspace;
  if (typeof workspace?.openSession !== "function") return false;
  await waitForSession(services?.sessions, sessionId, options);
  try {
    workspace.openSession(sessionId);
    return true;
  } catch {
    return false;
  }
}
