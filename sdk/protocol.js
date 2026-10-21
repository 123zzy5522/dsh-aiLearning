/**
 * The wire contract between the host and every client of it.
 *
 * This module is isomorphic on purpose: no `node:` imports, no React, no
 * dependencies. The host imports it, the browser bundle imports it, and
 * third-party plugins may import it. That is what makes it a contract rather
 * than a shared utility drawer.
 *
 * Rules for changing this file:
 *   - additive only within one API_VERSION
 *   - removing or repurposing a field bumps API_VERSION
 *   - every new field documents whether it is optional
 */

export const API_VERSION = 1;

/** Lifecycle of one build job. `paused` also covers an orphaned `running`. */
export const BUILD_STATE = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  PAUSED: "paused",
  PARTIAL: "partial",
  DONE: "done",
  FAILED: "failed",
});

/** What a build request means when a library already exists. */
export const BUILD_MODE = Object.freeze({
  AUTO: "auto",
  RESUME: "resume",
  FRESH: "fresh",
});

/** States that mean "no worker is running right now". */
export const SETTLED_BUILD_STATES = Object.freeze([
  BUILD_STATE.IDLE,
  BUILD_STATE.PAUSED,
  BUILD_STATE.PARTIAL,
  BUILD_STATE.DONE,
  BUILD_STATE.FAILED,
]);

export function isSettledBuild(state) {
  return SETTLED_BUILD_STATES.includes(state);
}

/**
 * @typedef {object} BookSummary
 * @property {string} title
 * @property {number} pages
 * @property {number} chapters
 * @property {boolean} tocFound
 */

/**
 * @typedef {object} BuildSummary
 * @property {string} state        one of BUILD_STATE
 * @property {number} done         finished batches
 * @property {number} total        planned batches
 * @property {number} failed       failed batches in the last pass
 * @property {boolean} canPause
 * @property {boolean} canResume
 * @property {string[]} log        last N lines, for display only
 */

/**
 * @typedef {object} LibrarySummary
 * @property {number} kps
 * @property {number} chapters
 */

/**
 * @typedef {object} LearningSummary
 * @property {boolean} ready       true when at least one KP can be taught
 * @property {number} built
 * @property {number} assessed
 * @property {number} unseen
 * @property {number} due
 * @property {string} message      developer-facing; clients prefer codes + counts
 */

/**
 * @typedef {object} ModeCard
 * @property {string} id
 * @property {string} label
 * @property {string} [summary]
 * @property {string[]} tools      tool names this mode is allowed to use
 */

/**
 * @typedef {object} CapabilitySummary
 * @property {string} id
 * @property {string} name
 * @property {number} apiVersion
 * @property {string} [description]
 */

/**
 * The single payload every UI reads. Additive changes only within a version.
 *
 * @typedef {object} Snapshot
 * @property {number} apiVersion
 * @property {string} dir
 * @property {BookSummary|null} book
 * @property {LibrarySummary} library
 * @property {BuildSummary} build
 * @property {LearningSummary} learning
 * @property {ModeCard[]} modes
 * @property {CapabilitySummary[]} capabilities
 */

/**
 * Props every plugin panel receives. The host owns fetching; a panel renders
 * and emits, nothing more.
 *
 * @typedef {object} PanelProps
 * @property {BookSummary} book
 * @property {object|null} kp          the knowledge point currently being taught
 * @property {ModeCard|null} mode
 * @property {unknown} state           plugin-owned state, persisted by the host
 * @property {(event: {type: string, payload?: unknown}) => void} emit
 */
