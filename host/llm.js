import fs from "node:fs";
import path from "node:path";

/**
 * Two transports, one contract.
 *
 * `llm` is the preferred path: it runs through the Harness LLM service, so the
 * request uses whatever account, provider, and model the running DSH session
 * already has. No credential is ever written to plugin configuration, and an
 * installed bundle works for anyone who can use DSH.
 *
 * The direct HTTP path exists only as an explicit override for a deployment
 * that names its own provider (`baseURL` + `apiKeyRef` in the plugin config).
 * It is not the default and must never become one.
 */

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);

/** One `image_url` content block carrying a JPEG file inline. */
export function imageBlock(file, mime = "image/jpeg") {
  const base64 = fs.readFileSync(file).toString("base64");
  return { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } };
}

/** One `text` content block. */
export function textBlock(text) {
  return { type: "text", text };
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(new Error("aborted"));
  }, { once: true });
});

/**
 * One non-streaming chat completion against an OpenAI-compatible endpoint.
 * Retries transient transport and 5xx/429 failures with exponential backoff,
 * because the configured provider answers 503 often enough that a single
 * attempt is not a usable strategy for a 28-batch pipeline.
 */
export async function chat(options) {
  const {
    baseURL, apiKey, model, messages,
    maxTokens = 4000, temperature = 0.2, reasoningEffort,
    retries = 4, signal, timeoutMs = 300000,
    onRetry,
  } = options;
  if (!baseURL) throw new Error("ailearn: baseURL is empty");
  if (!apiKey) throw new Error("ailearn: no API credential resolved");
  const url = `${baseURL.replace(/\/+$/, "")}/chat/completions`;
  const body = JSON.stringify({
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    stream: false,
  });

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw new Error("aborted");
    const controller = new AbortController();
    const abortOuter = () => controller.abort();
    signal?.addEventListener("abort", abortOuter, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body,
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        const retryable = RETRYABLE_STATUS.has(response.status);
        lastError = new Error(`provider ${response.status}: ${raw.slice(0, 300)}`);
        if (!retryable || attempt === retries) throw lastError;
        await onRetry?.({ attempt, error: lastError, waitMs: backoffMs(attempt) });
        await sleep(backoffMs(attempt), signal);
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error(`provider returned non-JSON: ${raw.slice(0, 300)}`);
      }
      const message = parsed.choices?.[0]?.message ?? {};
      const finishReason = parsed.choices?.[0]?.finish_reason ?? "unknown";
      if (!message.content && finishReason === "length") {
        throw new Error("model spent the whole output budget on reasoning (" + (parsed.usage?.completion_tokens ?? "?") + " tokens); raise maxOutputTokens or lower reasoningEffort");
      }
      return {
        content: message.content ?? "",
        reasoning: message.reasoning_content ?? "",
        finishReason,
        usage: parsed.usage ?? {},
        model: parsed.model ?? model,
      };
    } catch (error) {
      lastError = error;
      const aborted = signal?.aborted;
      if (aborted) throw new Error("aborted");
      if (attempt === retries) throw error;
      await onRetry?.({ attempt, error, waitMs: backoffMs(attempt) });
      await sleep(backoffMs(attempt), signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortOuter);
    }
  }
  throw lastError ?? new Error("ailearn: provider call failed");
}

function backoffMs(attempt) {
  return Math.min(30000, 2000 * Math.pow(4, attempt));
}

/**
 * Escape raw control characters that appear inside JSON string literals.
 * Models routinely paste multi-line code into a JSON string, which is illegal
 * JSON; repairing it here keeps one bad quote from discarding a whole batch.
 */
function escapeControlChars(source) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of source) {
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === "\\") { out += ch; escaped = true; continue; }
      if (ch === '"') { out += ch; inString = false; continue; }
      if (ch === "\n") { out += "\\n"; continue; }
      if (ch === "\r") { out += "\\r"; continue; }
      if (ch === "\t") { out += "\\t"; continue; }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}
/**
 * Extract the first JSON object or array from a model reply.
 * Models wrap JSON in fences or prose often enough that a bare JSON.parse is
 * not a usable contract, but a silent repair would hide real prompt drift:
 * anything that fails here is reported, not guessed at.
 */
export function parseJsonReply(text) {
  const source = String(text ?? "").trim();
  if (!source) throw new Error("model returned an empty reply");
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : source;
  const start = candidate.search(/[[{]/);
  if (start < 0) throw new Error(`model reply has no JSON: ${source.slice(0, 200)}`);
  const opener = candidate[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) {
        const slice = candidate.slice(start, i + 1);
        try {
          return JSON.parse(slice);
        } catch {
          // Models routinely put raw newlines and tabs inside string values when
          // quoting code. Those are illegal JSON; escape them rather than losing
          // the whole batch.
          return JSON.parse(escapeControlChars(slice));
        }
      }
    }
  }
  throw new Error(`model reply has unbalanced JSON: ${source.slice(0, 200)}`);
}

/**
 * Collect one streamed chat completion from `ctx.llm`.
 *
 * The service exposes token-level chunks, not a finished message, so this folds
 * `text-delta` / `reasoning-delta` into the same `{content, reasoning, finishReason}`
 * shape the direct transport returns. Both transports therefore feed the same
 * parsers downstream and a caller never branches on which one ran.
 */
export async function chatViaLlmService(options) {
  const {
    llm, provider, model, messages,
    maxTokens = 4000, reasoningEffort,
    signal, timeoutMs = 300000,
    attachments,
  } = options;
  if (!llm || typeof llm.stream !== "function") throw new Error("ailearn: ctx.llm is unavailable");
  if (!provider) throw new Error("ailearn: no provider resolved for the LLM transport");
  if (!model) throw new Error("ailearn: no model resolved for the LLM transport");

  const request = {
    provider,
    model,
    messages: await toServiceMessages(messages, attachments),
    maxTokens,
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };

  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;

  let content = "";
  let reasoning = "";
  let finishReason = "unknown";
  try {
    for await (const chunk of llm.stream({ ...request, signal: combined })) {
      if (chunk.type === "text-delta") content += chunk.text;
      else if (chunk.type === "reasoning-delta") reasoning += chunk.text;
      else if (chunk.type === "finish") {
        finishReason = chunk.reason?.kind ?? "stop";
        if (chunk.reason?.kind === "error") {
          throw new Error(`ailearn: LLM request failed: ${chunk.reason.failure?.message ?? "unknown"}`);
        }
        if (chunk.reason?.kind === "aborted") throw new Error("aborted");
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  if (!content && finishReason === "length") {
    throw new Error("model spent the whole output budget on reasoning; raise maxTokens or lower reasoningEffort");
  }
  return { content, reasoning, finishReason, usage: {}, model, transport: "llm" };
}

/**
 * Translate this plugin's simple messages into the service's frozen Message
 * objects.
 *
 * Images cannot travel as base64 here: the service admits durable attachment
 * references, so each rendered page is committed through `ctx.attachments`
 * first. That is also what keeps the request inside the deployment's own image
 * limits instead of smuggling an arbitrary payload through the provider call.
 */
async function toServiceMessages(messages, attachments) {
  const out = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push(makeMessage(message.role, [{ type: "text", text: message.content }]));
      continue;
    }
    const blocks = [];
    for (const block of message.content ?? []) {
      if (block.type === "text") {
        blocks.push({ type: "text", text: block.text });
      } else if (block.type === "image_url") {
        if (!attachments) throw new Error("ailearn: image blocks require ctx.attachments on the LLM transport");
        // `image_url.url` carries `data:image/jpeg;base64,...` from the renderer.
        const match = /^data:([^;]+);base64,(.*)$/s.exec(block.image_url?.url ?? "");
        if (!match) throw new Error("ailearn: image block is not a base64 data URL");
        const data = Buffer.from(match[2], "base64");
        const [ref] = await attachments.saveImages([{ mediaType: match[1], data }]);
        blocks.push({ type: "image", attachment: ref });
      }
    }
    out.push(makeMessage(message.role, blocks));
  }
  return out;
}

function makeMessage(role, content) {
  const normalized = role === "system" ? "system" : role === "assistant" ? "assistant" : "user";
  return {
    id: `ailearn-${Math.random().toString(36).slice(2)}`,
    role: normalized,
    content,
    source: normalized === "system" ? { kind: "system-prompt" } : { kind: "plugin", plugin: "dsh-ailearn" },
  };
}

/**
 * Resolve the provider, model, and LLM service an ingest call should use.
 *
 * Preference order is deliberate: an explicit `ingestModel` override wins, then
 * the running agent's own selection, then the deployment default. Nothing here
 * reads a credential — that is the whole point of routing through the service.
 */
export async function resolveLlmRoute(ctx, config) {
  const llm = ctx.get?.("llm") ?? ctx.llm;
  if (!llm || typeof llm.stream !== "function") return null;

  let provider;
  let model;
  let reasoningEffort;

  const explicit = String(config.ingestModel ?? "").trim();
  if (explicit) {
    const slash = explicit.indexOf("/");
    if (slash > 0) {
      provider = explicit.slice(0, slash);
      model = explicit.slice(slash + 1);
    } else {
      model = explicit;
    }
  }
  if (!provider || !model) {
    try {
      const selection = ctx.get?.("agentDefaultModel")?.currentSelection?.();
      if (selection) {
        provider = provider ?? selection.provider;
        model = model ?? selection.model;
        reasoningEffort = reasoningEffort ?? selection.reasoningEffort;
      }
    } catch { /* fall through to the explicit path */ }
  }
  if (!provider || !model) return null;
  return { llm, provider, model, reasoningEffort: config.reasoningEffort ?? reasoningEffort };
}
