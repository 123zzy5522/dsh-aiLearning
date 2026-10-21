/**
 * Client entry for the ailearn plugin panel.
 *
 * This is the source of truth for the browser bundle; `client.js` at the repo
 * root is generated from it by `scripts/build-client.mjs` and must not be
 * edited by hand.
 */

import React from "react";
const h = React.createElement;
const API = "/dsh-ailearn/api";

/** Set by `apply`. The panel needs it to reach `uiWorkspace.pickDirectory`. */
let pluginCtx = null;

/** Long-press window before a press turns into a drag. */
const HOLD_MS = 220;
/** Movement that cancels a press instead of toggling the panel. */
const SLOP_PX = 8;
/** Keep the button fully inside the viewport. */
const EDGE_PX = 6;
const BUTTON_PX = 44;
const POSITION_KEY = "dsh-ailearn.fab";

const state = {
  open: false,
  dir: "",
  book: null,
  build: null,
  info: null,
  decision: null,
  notice: "",
  busy: false,
  error: "",
  pos: null,
  listeners: new Set(),
};
function set(patch) {
  Object.assign(state, patch);
  for (const fn of state.listeners) { try { fn(state); } catch { /* isolated */ } }
}
function subscribe(fn) {
  state.listeners.add(fn);
  return () => state.listeners.delete(fn);
}

function clampPosition(x, y) {
  const maxX = Math.max(EDGE_PX, window.innerWidth - BUTTON_PX - EDGE_PX);
  const maxY = Math.max(EDGE_PX, window.innerHeight - BUTTON_PX - EDGE_PX);
  return {
    x: Math.min(Math.max(EDGE_PX, x), maxX),
    y: Math.min(Math.max(EDGE_PX, y), maxY),
  };
}

function loadPosition() {
  try {
    const raw = localStorage.getItem(POSITION_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Number.isFinite(parsed?.x) && Number.isFinite(parsed?.y)) return clampPosition(parsed.x, parsed.y);
    }
  } catch { /* private mode or corrupt entry */ }
  // Default: middle of the left screen edge, away from the titlebar controls
  // and the composer, which are the two occupied corners.
  return clampPosition(EDGE_PX + 2, Math.round(window.innerHeight / 2) - BUTTON_PX / 2);
}

function savePosition(pos) {
  try { localStorage.setItem(POSITION_KEY, JSON.stringify(pos)); } catch { /* ignore */ }
}

try {
  const saved = localStorage.getItem("dsh-ailearn.dir");
  if (saved) state.dir = saved;
} catch { /* private mode */ }
state.pos = loadPosition();

async function call(path, options) {
  const response = await fetch(API + path, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    ...options,
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { throw new Error(response.status + " 非 JSON: " + text.slice(0, 200)); }
  if (!response.ok || data?.ok === false) throw new Error(data?.error || data?.message || response.statusText);
  return normalizeSnapshot(data);
}

/**
 * Accept both the legacy (`job` / `learn` / `kps`) and the versioned
 * (`build` / `learning` / `library`) snapshot shapes.
 *
 * The host and the client bundle are deployed separately: the browser can
 * pick up a new client while the old host is still running. Degrading to
 * the legacy field names keeps the panel usable until DSH restarts, instead
 * of showing an empty panel with no explanation.
 */
function normalizeSnapshot(data) {
  if (!data) return data;
  const build = data.build ?? (data.job
    ? {
      state: data.job.status,
      done: data.job.done ?? 0,
      total: data.job.total ?? 0,
      failed: data.job.failed ?? 0,
      canPause: data.job.status === "running",
      canResume: ["paused", "partial", "failed"].includes(data.job.status),
      log: data.job.log ?? [],
    }
    : null);
  const learning = data.learning ?? data.learn ?? null;
  const library = data.library ?? data.kps ?? { kps: 0, chapters: 0 };
  return { ...data, build, learning, library };
}

function useStore() {
  const [, force] = React.useReducer((n) => n + 1, 0);
  React.useEffect(() => subscribe(force), []);
  return state;
}

const CSS = `
.al-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1,#34363d);background:var(--dsw-alias-bg-secondary,#1b1c21);color:inherit;border-radius:7px;padding:6px 12px;font:inherit;cursor:pointer}
.al-btn:hover{border-color:var(--dsw-alias-brand-primary,#6dbf8c)}
.al-btn.primary{background:var(--dsw-alias-brand-primary,#5fbf8a);border-color:transparent;color:#0c1510;font-weight:650}
.al-btn:disabled{opacity:.45;cursor:not-allowed}
.al-fab{position:fixed;z-index:920;pointer-events:auto;width:44px;height:44px;border-radius:50%;border:1px solid var(--dsw-alias-border-l1,#34363d);background:var(--dsw-alias-bg-secondary,#1b1c21);color:inherit;cursor:grab;font-size:19px;display:flex;align-items:center;justify-content:center;box-shadow:0 6px 20px rgba(0,0,0,.28);touch-action:none;user-select:none;-webkit-user-select:none}
.al-fab:hover{border-color:var(--dsw-alias-brand-primary,#6dbf8c)}
.al-fab.al-dragging{cursor:grabbing;transform:scale(1.06);box-shadow:0 12px 32px rgba(0,0,0,.45)}
.al-panel{position:fixed;z-index:921;pointer-events:auto;width:420px;max-width:calc(100vw - 16px);max-height:70vh;overflow:auto;border:1px solid var(--dsw-alias-border-l1,#34363d);border-radius:12px;background:var(--dsw-alias-bg-primary,#101114);color:var(--dsw-alias-label-primary,#e9eaee);box-shadow:0 16px 48px rgba(0,0,0,.4);padding:16px;font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
.al-head{display:flex;align-items:center;gap:8px;margin-bottom:12px}
.al-title{font-size:15px;font-weight:650}
.al-sub{color:var(--dsw-alias-label-secondary,#9aa0aa);font-size:12px}
.al-input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1,#34363d);background:var(--dsw-alias-bg-secondary,#1b1c21);color:inherit;border-radius:7px;padding:7px 9px;font:inherit;margin-bottom:8px}
.al-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}
.al-bar{height:6px;border-radius:3px;background:var(--dsw-alias-bg-tertiary,#202229);overflow:hidden;margin:8px 0}
.al-bar>i{display:block;height:100%;background:var(--dsw-alias-brand-primary,#5fbf8a);transition:width .3s}
.al-log{max-height:150px;overflow:auto;font:11.5px/1.5 ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-secondary,#9aa0aa);white-space:pre-wrap;background:var(--dsw-alias-bg-secondary,#1b1c21);border-radius:6px;padding:8px;margin-top:8px}
.al-err{color:#ff9a9a;margin-top:8px;white-space:pre-wrap}
.al-ok{color:var(--dsw-alias-brand-primary,#5fbf8a)}
.al-dialog{margin:10px 0;padding:12px;border:1px solid var(--dsw-alias-brand-primary,#6dbf8c);border-radius:10px;background:var(--dsw-alias-bg-secondary,#1b1c21)}
.al-dialog-title{font-weight:650;margin-bottom:4px}
.al-btn.danger{border-color:#7a3b3b;color:#ff9a9a}
.al-btn.danger:hover{border-color:#c05b5b}
.al-note{margin-top:8px;color:var(--dsw-alias-brand-primary,#5fbf8c);white-space:pre-wrap}
`;

/** Place the panel next to the button, flipping so it always stays on screen. */
function panelStyle(pos) {
  const width = Math.min(420, window.innerWidth - 16);
  const left = Math.min(Math.max(EDGE_PX, pos.x + BUTTON_PX - width), Math.max(EDGE_PX, window.innerWidth - width - EDGE_PX));
  const spaceAbove = pos.y;
  const top = spaceAbove > 420
    ? Math.max(EDGE_PX, pos.y - 12 - Math.min(420, window.innerHeight * 0.7))
    : Math.min(window.innerHeight - 120, pos.y + BUTTON_PX + 10);
  return { left, top, width };
}

function Panel() {
  const snapshot = useStore();
  const { dir, book, build, busy, error, notice, decision, pos } = snapshot;
  const info = snapshot.info;
  const learning = info?.learning ?? {
    ready: false, built: 0, assessed: 0, unseen: 0, due: 0, message: "",
  };
  const running = build?.state === "running";

  const refresh = React.useCallback(async () => {
    if (!dir) return;
    const data = await call("/build?dir=" + encodeURIComponent(dir));
    set({ info: data, book: data.book, build: data.build });
  }, [dir]);

  React.useEffect(() => {
    if (!dir) return undefined;
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      try {
        const data = await call("/build?dir=" + encodeURIComponent(dir));
        if (alive) set({ info: data, book: data.book, build: data.build });
      } catch (err) { if (alive) set({ error: String(err.message || err) }); }
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => { alive = false; clearInterval(timer); };
  }, [dir]);

  const run = async (label, fn) => {
    set({ busy: true, error: "" });
    try { await fn(); } catch (err) { set({ error: label + "失败: " + String(err.message || err) }); }
    finally { set({ busy: false }); }
  };

  /**
   * Resolve `uiWorkspace` lazily: a hard `inject` entry would keep the whole
   * launcher inactive in a build that does not publish that service, and a
   * missing chooser should only disable the button, not the panel.
   */
  const pickFromWorkspace = async () => {
    let workspace;
    try { workspace = pluginCtx?.get?.("uiWorkspace"); } catch { workspace = undefined; }
    if (!workspace) {
      try { workspace = pluginCtx?.uiWorkspace; } catch { workspace = undefined; }
    }
    if (typeof workspace?.pickDirectory !== "function") {
      throw new Error("当前构建没有提供目录选择器");
    }
    return workspace.pickDirectory();
  };

  /**
   * Open the host directory chooser.
   *
   * Desktop exposes a native bridge on `__DSH_DIRECTORY_PICKER__`; the web
   * build routes through `uiWorkspace.pickDirectory()`. Both hand back the
   * chosen path, or throw when the user cancels or the chooser is absent.
   */
  const pick = async () => {
    set({ error: "" });
    try {
      const desktop = globalThis.__DSH_DIRECTORY_PICKER__;
      const picked = desktop?.pick ? await desktop.pick() : await pickFromWorkspace();
      if (!picked) return;
      set({ dir: picked, book: null, build: null, info: null, decision: null, notice: "" });
      try { localStorage.setItem("dsh-ailearn.dir", picked); } catch { /* ignore */ }
      // Probe immediately: an empty folder is the most common mistake, and
      // saying so right away beats failing later inside 建库.
      try {
        const data = await call("/build?dir=" + encodeURIComponent(picked));
        set({ info: data, book: data.book, build: data.build });
        if (!data.book) set({ error: "这个目录还没有教材。往里放一个 PDF,然后点「建立知识库」。" });
      } catch (err) {
        set({ error: String(err.message || err) });
      }
    } catch (err) {
      const message = String(err?.message || err);
      if (/cancel|abort|dismiss/i.test(message)) return; // user backed out
      set({ error: "打不开目录选择器(" + message + "),可以直接粘贴路径。" });
    }
  };

  const pct = build && build.total ? Math.round((build.done / build.total) * 100) : 0;
  const JOB_LABEL = { running: "建库中", paused: "已暂停", partial: "部分完成", done: "已完成", failed: "失败" };

  const startBuild = (mode) => run(mode === "fresh" ? "重建" : "建库", async () => {
    const result = await call("/build/start", { method: "POST", body: JSON.stringify({ dir, mode }) });
    set({ decision: null, notice: result.message || "" });
    await refresh();
  });

  const pause = () => run("暂停", async () => {
    const result = await call("/build/pause", { method: "POST", body: JSON.stringify({ dir }) });
    set({ notice: result.message || "" });
    await refresh();
  });

  const startLearn = () => run("打开学习会话", async () => {
    const result = await call("/open", { method: "POST", body: JSON.stringify({ dir }) });
    // Creating the session host-side is not enough: the shell has to switch to
    // it, otherwise the button looks like it did nothing. `ctx.sessions.open`
    // is the same entry point the sidebar rows use.
    let opened = false;
    if (result.sessionId) {
      try {
        const sessions = pluginCtx?.get?.("sessions") ?? pluginCtx?.sessions;
        if (typeof sessions?.open === "function") {
          sessions.open(result.sessionId);
          opened = true;
        }
      } catch { /* service absent on this build; fall back to the notice */ }
    }
    set({
      notice: opened
        ? (result.reused ? "已打开原来的学习会话。" : "学习会话已创建并打开。")
        : (result.reused ? "已回到原来的学习会话。" : "学习会话已创建,左侧会话列表里能看到它。"),
    });
  });

  const changeMode = (modeId) => run("切换模式", async () => {
    await call("/mode", { method: "POST", body: JSON.stringify({ dir, mode: modeId }) });
    set({ notice: "模式已切换，下一轮 learn_status 生效。" });
    await refresh();
  });

  /**
   * One entry point for building. When the directory already holds a
   * library, the learner decides between topping it up and starting over
   * instead of the plugin guessing from a button label.
   */
  const onBuildClick = () => {
    if (!dir) return;
    if (learning.built > 0) {
      set({
        decision: {
          built: learning.built,
          chapters: info?.library?.chapters ?? 0,
          finished: build?.state === "done",
          armed: false,
        },
      });
      return;
    }
    startBuild("auto");
  };

  return h("div", { className: "al-panel", style: panelStyle(pos) },
    h("div", { className: "al-head" },
      h("div", { className: "al-title" }, "AI 教材学习"),
      h("div", { style: { flex: 1 } }),
      h("button", { className: "al-btn", onClick: () => set({ open: false }) }, "收起")
    ),
    h("div", { className: "al-sub", style: { marginBottom: 8 } },
      "选一个存放 PDF 课本的目录。建库和教学是两条链路:库可以边建边学。"),
    h("input", {
      className: "al-input",
      placeholder: "例如 D:\\books\\aspnet-core",
      value: dir,
      onChange: (event) => {
        const next = event.target.value;
        set({ dir: next, book: null, build: null, info: null, decision: null, notice: "" });
        try { localStorage.setItem("dsh-ailearn.dir", next); } catch { /* ignore */ }
      },
    }),
    h("div", { className: "al-row" },
      h("button", { className: "al-btn", disabled: busy, onClick: pick }, "选择目录"),
      running
        ? h("button", { className: "al-btn danger", disabled: busy, onClick: pause }, "暂停建库")
        : h("button", {
          className: "al-btn" + (learning.ready ? "" : " primary"),
          disabled: busy || !dir,
          onClick: onBuildClick,
        }, "建立知识库"),
      learning.ready ? h("button", {
        className: "al-btn primary",
        disabled: busy,
        onClick: startLearn,
      }, "开始学习") : null
    ),

    decision ? h("div", { className: "al-dialog" },
      h("div", { className: "al-dialog-title" }, decision.finished ? "知识库已经建完" : "这个目录已经有知识点"),
      h("div", { className: "al-sub" },
        decision.finished
          ? `已建 ${decision.built} 条${decision.chapters ? `(约 ${decision.chapters} 章)` : ""}。`
            + "重新建库会把 kp/ 与 jobs/ 移到 .aiLearn/backup/,再从 PDF 抽一遍。"
          : `已建 ${decision.built} 条${decision.chapters ? `(约 ${decision.chapters} 章)` : ""}。`
            + "继续 = 只补没跑完的批次;重新 = 把 kp/ 与 jobs/ 移到 .aiLearn/backup/,再从 PDF 抽一遍。"),
      h("div", { className: "al-row", style: { marginTop: 10 } },
        decision.finished ? null : h("button", {
          className: "al-btn primary",
          disabled: busy,
          onClick: () => startBuild("resume"),
        }, "继续建库"),
        decision.armed
          ? h("button", { className: "al-btn danger", disabled: busy, onClick: () => startBuild("fresh") }, "确定清空并重建")
          : h("button", {
            className: "al-btn danger",
            disabled: busy,
            onClick: () => set({ decision: { ...decision, armed: true } }),
          }, "重新建库"),
        h("button", { className: "al-btn", disabled: busy, onClick: () => set({ decision: null }) }, "取消")
      ),
      decision.armed
        ? h("div", { className: "al-sub", style: { marginTop: 6 } }, "再点一次确认。旧库会进 backup/,可以找回。")
        : null
    ) : null,

    book ? h("div", null,
      h("div", { className: "al-ok" }, `教材: ${book.title}`),
      h("div", { className: "al-sub" }, `${book.pages} 页 · ${book.chapters} 章 · 目录${book.tocFound ? "已识别" : "未识别(按等分切章)"}`)
    ) : h("div", { className: "al-sub" }, dir ? "这个目录还没有教材。放一个 PDF 进去,再点「建立知识库」。" : "还没有选择目录。"),

    h("div", { className: "al-sub", style: { marginTop: 8 } }, learning.message || "还没有可学的知识点。"),

    (info?.modes?.length ?? 0) > 0 ? h("div", { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 8 } },
      h("span", { className: "al-sub" }, "学习模式"),
      h("select", {
        className: "al-input",
        style: { marginBottom: 0, flex: 1, padding: "5px 8px" },
        value: info.mode ?? info.modes[0].id,
        disabled: busy,
        onChange: (event) => changeMode(event.target.value),
      }, info.modes.map((mode) => h("option", { key: mode.id, value: mode.id, title: mode.summary || "" }, mode.label))),
      info.modes.length > 1 ? null : h("span", { className: "al-sub" }, "（装插件可加模式）")
    ) : null,

    build ? h("div", null,
      h("div", { className: "al-bar" }, h("i", { style: { width: pct + "%" } })),
      h("div", { className: "al-sub" },
        `${JOB_LABEL[build.state] || build.state} · ${build.done}/${build.total} 批 · 失败 ${build.failed}`),
      build.state === "paused"
        ? h("div", { className: "al-sub" }, "已暂停。已完成的批次已经合并进知识点,点「建立知识库 → 继续建库」接着跑。")
        : null,
      build.log?.length ? h("div", { className: "al-log" }, build.log.slice(-6).join("\n")) : null
    ) : null,

    notice ? h("div", { className: "al-note" }, notice) : null,
    error ? h("div", { className: "al-err" }, error) : null,

    h("div", { style: { marginTop: 12, display: "flex", gap: 8 } },
      h("button", {
        className: "al-btn",
        onClick: () => {
          const next = clampPosition(EDGE_PX + 2, Math.round(window.innerHeight / 2) - BUTTON_PX / 2);
          set({ pos: next });
          savePosition(next);
        },
      }, "复位按钮位置")
    ),
);
}

/**
 * Floating launcher.
 *
 * Drag it anywhere: press and move, or press and hold and then move. A press
 * that releases without moving toggles the panel. The position persists,
 * because a control pinned to one corner always ends up over something else.
 */
function Launcher(props) {
  useStore();
  const drag = React.useRef({
    pressed: false, dragging: false, moved: false,
    offsetX: 0, offsetY: 0, lastX: 0, lastY: 0, timer: null,
  });

  React.useEffect(() => {
    const onResize = () => {
      const next = clampPosition(state.pos.x, state.pos.y);
      set({ pos: next });
      savePosition(next);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      clearTimeout(drag.current.timer);
    };
  }, []);

  const beginDrag = () => {
    if (drag.current.dragging) return;
    drag.current.dragging = true;
    clearTimeout(drag.current.timer);
    set({ pos: { ...state.pos } }); // force a re-render so the drag class applies
  };

  const onPointerDown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    drag.current.pressed = true;
    drag.current.moved = false;
    drag.current.dragging = false;
    drag.current.offsetX = event.clientX - rect.left;
    drag.current.offsetY = event.clientY - rect.top;
    drag.current.lastX = event.clientX;
    drag.current.lastY = event.clientY;
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    clearTimeout(drag.current.timer);
    // Holding without moving also arms a drag, for touch and trackpads.
    drag.current.timer = setTimeout(() => { if (drag.current.pressed) beginDrag(); }, HOLD_MS);
  };

  const onPointerMove = (event) => {
    if (!drag.current.pressed) return;
    const dx = event.clientX - drag.current.lastX;
    const dy = event.clientY - drag.current.lastY;
    if (!drag.current.dragging) {
      if (Math.abs(dx) + Math.abs(dy) < SLOP_PX) return;
      beginDrag();
    }
    drag.current.lastX = event.clientX;
    drag.current.lastY = event.clientY;
    drag.current.moved = true;
    set({ pos: clampPosition(event.clientX - drag.current.offsetX, event.clientY - drag.current.offsetY) });
  };

  const finish = () => {
    clearTimeout(drag.current.timer);
    const { dragging, moved, pressed } = drag.current;
    drag.current.pressed = false;
    drag.current.dragging = false;
    drag.current.moved = false;
    if (dragging) {
      savePosition(state.pos);
      if (!moved) set({ open: !state.open }); // held still, then released
      return;
    }
    if (pressed) set({ open: !state.open });
  };

  const onPointerCancel = () => {
    clearTimeout(drag.current.timer);
    const wasDragging = drag.current.dragging && drag.current.moved;
    drag.current.pressed = false;
    drag.current.dragging = false;
    drag.current.moved = false;
    if (wasDragging) savePosition(state.pos);
  };

  const button = h("button", {
    className: "al-fab" + (drag.current.dragging ? " al-dragging" : ""),
    title: "AI 教材学习 · 可拖动",
    // Inline geometry as a safety net: if the stylesheet is ever missing the
    // button must still be a positioned, clickable target rather than a bare
    // emoji flowing with the overlay's layout.
    style: {
      position: "fixed",
      left: state.pos.x + "px",
      top: state.pos.y + "px",
      width: BUTTON_PX + "px",
      height: BUTTON_PX + "px",
      pointerEvents: "auto",
      zIndex: 920,
      cursor: drag.current.dragging ? "grabbing" : "grab",
      touchAction: "none",
      borderRadius: "50%",
      border: "1px solid var(--dsw-alias-border-l1,#34363d)",
      background: "var(--dsw-alias-bg-secondary,#1b1c21)",
      color: "inherit",
      fontSize: "19px",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      boxShadow: "0 6px 20px rgba(0,0,0,.28)",
      userSelect: "none",
      WebkitUserSelect: "none",
    },
    onPointerDown,
    onPointerMove,
    onPointerUp: finish,
    onPointerCancel,
    onContextMenu: (event) => event.preventDefault(),
  }, "📚");

  // The stylesheet must live outside the panel: the launcher itself needs
  // `.al-fab`, and a <style> rendered only while the panel is open leaves the
  // button unstyled — visible as a bare emoji that cannot be clicked or dragged.
  return h(React.Fragment, null, props?.children ?? null, h("style", null, CSS), button, state.open ? h(Panel) : null);
}

export default {
  inject: ["slots"],
  apply(ctx) {
    pluginCtx = ctx;
    ctx.slots.inject("shell.overlay", () => ctx.slots.register({
      name: "shell.overlay",
      id: "dsh-ailearn-launcher",
      order: 70,
    }, Launcher));
  },
};
