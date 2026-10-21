import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PDFKIT = path.resolve(HERE, "..", "scripts", "pdfkit.py");

/** Run the PDF sidecar and parse its single JSON stdout line. */
export function runPdfKit(python, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [PDFKIT, ...args], {
      windowsHide: true,
      signal: options.signal,
    });
    const out = [];
    const err = [];
    let settled = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill(); } catch { /* already gone */ }
        reject(new Error(`pdfkit timed out after ${options.timeoutMs}ms`));
      }, options.timeoutMs)
      : null;
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const text = Buffer.concat(out).toString("utf8").trim();
      const stderr = Buffer.concat(err).toString("utf8").trim();
      let parsed;
      try {
        parsed = JSON.parse(text.split("\n").filter(Boolean).pop() || "{}");
      } catch {
        return reject(new Error(`pdfkit returned non-JSON (exit ${code}): ${text.slice(0, 400)} ${stderr.slice(0, 400)}`));
      }
      if (code !== 0 || parsed.ok === false) {
        return reject(new Error(parsed.error || stderr || `pdfkit exited with ${code}`));
      }
      resolve(parsed);
    });
  });
}

/** Page count, page size, text-layer coverage, embedded outline. */
export function probePdf(python, pdfPath, options = {}) {
  return runPdfKit(python, ["probe", pdfPath], { timeoutMs: 120000, ...options });
}

/** Render an inclusive page range to JPEG files and return their manifest. */
export function renderPages(python, pdfPath, first, last, options = {}) {
  const dpi = options.dpi ?? 150;
  const quality = options.quality ?? 85;
  const outdir = options.outdir;
  const prefix = options.prefix ?? "p";
  return runPdfKit(
    python,
    ["render", pdfPath, String(first), String(last), String(dpi), String(quality), outdir, prefix],
    { timeoutMs: 300000, signal: options.signal },
  );
}