/**
 * Stable machine-readable error codes.
 *
 * The host never composes user-facing sentences for failures. It returns a code
 * plus parameters; the client maps the code through `locale/*.json`. That is
 * what keeps copy out of the backend and makes tests assert on behaviour rather
 * than on Chinese strings.
 *
 * Codes are append-only. Renaming one is a breaking change for every client
 * that already maps it.
 */

export const CODES = Object.freeze({
  /** Request is missing the `dir` parameter. */
  NO_DIR: "api/no-dir",
  /** Route does not exist. */
  UNKNOWN_ROUTE: "api/unknown-route",
  /** Unexpected failure inside the host. */
  INTERNAL: "api/internal",

  /** Pause was requested but nothing is running. */
  BUILD_NONE_RUNNING: "build/none-running",
  /** A build is already running for this directory. */
  BUILD_ALREADY_RUNNING: "build/already-running",
  /** Fresh reset could not move the old library aside. */
  BUILD_RESET_FAILED: "build/reset-failed",

  /** Directory has no PDF. */
  BOOK_NO_PDF: "book/no-pdf",
  /** Directory has more than one PDF. */
  BOOK_MULTIPLE_PDF: "book/multiple-pdf",
  /** No book.json yet: the library has not been prepared. */
  BOOK_NOT_READY: "book/not-ready",

  /** The deployment has no session controller, so /open cannot create one. */
  SESSION_SERVICE_MISSING: "session/service-missing",
});

/**
 * Build the legacy-compatible error body.
 *
 * `message` is retained because older clients and agent tools print it; new
 * clients should key off `code`. It is never the source of truth.
 *
 * @param {string} code
 * @param {string} [message]
 * @param {Record<string, unknown>} [params]
 */
export function errorBody(code, message, params) {
  return {
    ok: false,
    code,
    error: message ?? code,
    ...(params ? { params } : {}),
  };
}
