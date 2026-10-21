import fs from "node:fs";
import path from "node:path";
import { bookPaths, readJson, writeJson } from "./config.js";

/**
 * Learning state is an append-only event log plus a derived mastery table.
 * The log is the source of truth: it survives a lost session, a model change,
 * or a plugin upgrade, and it can be replayed to any point in time.
 */

const DIMENSIONS = new Set(["recognize", "recall", "apply"]);

/** Append one attempt record. Never rewrites existing lines. */
export function appendEvent(bookDir, event) {
  const paths = bookPaths(bookDir);
  const record = {
    at: new Date().toISOString(),
    ...event,
  };
  fs.appendFileSync(paths.events, JSON.stringify(record) + "\n", "utf8");
  return record;
}

export function readEvents(bookDir) {
  const paths = bookPaths(bookDir);
  if (!fs.existsSync(paths.events)) return [];
  const lines = fs.readFileSync(paths.events, "utf8").split("\n").filter(Boolean);
  const events = [];
  for (const line of lines) {
    try { events.push(JSON.parse(line)); } catch { /* skip a torn last line */ }
  }
  return events;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Fold the event log into per-knowledge-point mastery.
 * Three dimensions are tracked separately because a learner who can recognise a
 * bad smell is not yet a learner who can refactor it, and the gap between those
 * two is exactly what the next session should target.
 */
export function rebuildMastery(bookDir, options = {}) {
  const paths = bookPaths(bookDir);
  const events = readEvents(bookDir);
  const table = {};
  for (const event of events) {
    if (event.type !== "attempt" || !event.kpId) continue;
    const entry = table[event.kpId] ??= {
      kpId: event.kpId,
      attempts: 0,
      scoreSum: 0,
      correct: 0,
      dims: {},
      ease: 2.5,
      intervalDays: 0,
      dueAt: null,
      lastAt: null,
      illusions: 0,
      streak: 0,
    };
    const score = typeof event.score === "number" ? event.score : (event.correct ? 1 : 0);
    entry.attempts += 1;
    entry.scoreSum += score;
    if (score >= 0.8) entry.correct += 1;
    const dimension = DIMENSIONS.has(event.dimension) ? event.dimension : "recall";
    const dim = entry.dims[dimension] ??= { n: 0, c: 0 };
    dim.n += 1;
    if (score >= 0.8) dim.c += 1;
    // High confidence plus a wrong answer is an illusion of competence: the most
    // valuable single signal the loop can collect.
    if (typeof event.confidence === "number" && event.confidence >= 4 && score < 0.5) entry.illusions += 1;
    entry.lastAt = event.at;
    if (score >= 0.8) {
      entry.streak += 1;
      entry.ease = Math.min(3.0, entry.ease + 0.1);
      entry.intervalDays = entry.intervalDays === 0 ? 1 : Math.min(60, Math.round(entry.intervalDays * entry.ease));
    } else {
      entry.streak = 0;
      entry.ease = Math.max(1.3, entry.ease - 0.2);
      entry.intervalDays = 0;
    }
    const base = entry.lastAt ? Date.parse(entry.lastAt) : Date.now();
    const wait = entry.intervalDays === 0 ? 0 : entry.intervalDays * DAY_MS;
    entry.dueAt = new Date(base + wait).toISOString();
  }

  const kps = Object.values(table);
  const now = Date.now();
  const summary = {
    total: kps.length,
    due: kps.filter((entry) => !entry.dueAt || Date.parse(entry.dueAt) <= now).length,
    weak: kps.filter((entry) => entry.attempts > 0 && entry.scoreSum / entry.attempts < 0.6).length,
    illusions: kps.reduce((sum, entry) => sum + entry.illusions, 0),
    meanScore: kps.length === 0 ? null : kps.reduce((sum, entry) => sum + entry.scoreSum / entry.attempts, 0) / kps.length,
  };
  const result = { version: 1, generatedAt: new Date().toISOString(), summary, kps: table };
  // Callers that poll (the build panel) ask for the folded table without
  // rewriting the file on every tick.
  if (options.persist !== false) writeJson(paths.mastery, result);
  return result;
}

/** Knowledge points most worth asking about now, weakest and most-due first. */
export function dueQueue(bookDir, book, limit = 8) {
  const mastery = rebuildMastery(bookDir);
  const index = readJson(pathsOf(bookDir).index, { kps: [] });
  const now = Date.now();
  const scored = [];
  for (const kp of index.kps ?? []) {
    const entry = mastery.kps[kp.id];
    let priority;
    if (!entry) priority = 55; // never assessed: coverage debt
    else {
      const mean = entry.scoreSum / entry.attempts;
      const overdueDays = entry.dueAt ? (now - Date.parse(entry.dueAt)) / DAY_MS : 0;
      priority = (1 - mean) * 60 + Math.max(0, Math.min(30, overdueDays * 3)) + entry.illusions * 8;
    }
    scored.push({ id: kp.id, title: kp.title, section: kp.section, priority: Math.round(priority), seen: Boolean(entry) });
  }
  scored.sort((a, b) => b.priority - a.priority);
  return scored.slice(0, limit);
}

/** Coverage ledger: which knowledge points have never been assessed at all. */
export function coverageGap(bookDir, book) {
  const mastery = rebuildMastery(bookDir);
  const index = readJson(pathsOf(bookDir).index, { kps: [] });
  const assessed = new Set(Object.keys(mastery.kps));
  const never = (index.kps ?? []).filter((kp) => !assessed.has(kp.id));
  return {
    total: (index.kps ?? []).length,
    assessed: assessed.size,
    never: never.map((kp) => ({ id: kp.id, title: kp.title, section: kp.section })),
  };
}

function pathsOf(bookDir) {
  return bookPaths(bookDir);
}