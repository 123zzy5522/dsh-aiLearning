/**
 * Rewrite a book's knowledge point ids from positional (`KP-0203`) to section
 * (`KP-02-2.1.3`) form.
 *
 *   node scripts/migrate-ids.mjs "D:\\dsh test\\aiLearn" --dry
 *   node scripts/migrate-ids.mjs "D:\\dsh test\\aiLearn"
 */
import { migrateKpIds, hasLegacyIds } from "../host/migrate.js";

const args = process.argv.slice(2);
const dir = args.find((arg) => !arg.startsWith("--"));
const dryRun = args.includes("--dry");

if (!dir) {
  console.error("usage: node scripts/migrate-ids.mjs <bookDir> [--dry]");
  process.exit(1);
}

const legacy = hasLegacyIds(dir);
console.log(`${dir}: ${legacy ? "positional ids found" : "no positional ids"}`);
if (!legacy) process.exit(0);

const report = migrateKpIds(dir, { dryRun });
console.log(`chapters ${report.chapters}, rewritten ${report.rewritten}, events ${report.events}`);
if (report.backup) console.log(`backup: ${report.backup}`);
console.log("sample:", Object.entries(report.mapping).slice(0, 5).map(([from, to]) => `${from} → ${to}`).join(", "));
if (dryRun) console.log("dry run: nothing written");
