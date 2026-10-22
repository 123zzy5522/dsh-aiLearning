# Client：面板与构建

## 形态

面板是一个 44×44 的可拖悬浮球 + 一个浮层卡片，挂在 DSH 的 `shell.overlay` 插槽里。

```
client/src/index.js    启动器、面板、所有交互
client/src/navigate.js  跳到主视图的会话（唯一有副作用的跳转）
client.js               ← 构建产物，不要手改
```

`client.js` 是 `window.__ModuleLoader__.load({id, factory})` 形式的预构建 bundle，由 DSH 在启动时通过 `/plugins` 提供给浏览器。**仓库里提交产物**，因为 `link:` 安装和 GitHub 安装都必须开箱即用。

## 构建

```powershell
npm run build:client     # client/src/ → client.js（esbuild，react external）
```

- React 由外壳通过 `require("react")` 提供，不打进 bundle。
- CI 会重新构建并 `git diff --exit-code client.js`：**产物过期直接红**。
- 开发时若想改完即见，需要跑 `node scripts/build-client.mjs --watch` 之类的循环（当前脚本是一次性构建；DSH 的 client-hmr 监视的是产物 mtime，不是源码）。

## 数据来源：只有 `/build`

面板只 GET `/build?dir=`，拿到 `Snapshot`：

```jsonc
{
  "apiVersion": 1,
  "dir": "...",
  "book": { "title", "pages", "chapters", "tocFound" },
  "library": { "kps", "chapters" },
  "build": { "state", "done", "total", "failed", "canPause", "canResume", "log", "batches" },
  "learning": { "ready", "built", "assessed", "unseen", "due", "message" },
  "modes": [{ "id", "label", "summary", "tools" }],
  "mode": "beginner",
  "capabilities": [...],
  "packs": { "loaded": [...], "failed": [...] }
}
```

轮询间隔 2 秒。所有按钮的显隐都由 `build.state` 和 `learning` 推出来，没有第二套业务判断。

## 按钮规则

| 条件 | 主按钮 |
|---|---|
| `build.state === "running"` | **暂停建库**（danger） |
| 没有任务在跑 | **建立知识库** |
| 点「建立知识库」且 `lib.kps > 0` | 先弹决策：继续建库 / 重新建库 / 取消 |
| `learning.ready` | 追加 **开始学习**（primary） |

「重新建库」是两步确认（第二次点「确定清空并重建」），因为它会移走整个 `kp/`。

## 打开学习会话的时序

这是最容易写错的一处，代码在 `client/src/navigate.js`：

```
POST /open                     host 侧创建/复用 session，返回 sessionId
        │
        ▼
浏览器会话目录（sessions.list）还不知道这个 id
        │  （host 通过异步事件 api-session/added 通知，可能晚于 HTTP 响应）
        ▼
sessions.refresh() + 轮询最多 20×50ms，等目录里出现该 id
        │
        ▼
uiWorkspace.openSession(sessionId)   切换主视图
```

两个坑：

- **不能用 `ctx.sessions.open`**：它只 retain 会话、打开历史，不会切主视图。切视图的是 `ctx.uiWorkspace.openSession`。
- **不能拿到 id 立刻开**：目录还没这一行时会抛 `sessions.retain: unknown session`。

任一步失败都降级成一句提示（会话已经建好，用户可以在侧边栏点开），不会静默什么都不做。

## 依赖的服务

客户端插件声明 `inject: ["slots", "sessions"]`。Cordis 只暴露注入过的服务——少了 `sessions`，`ctx.sessions` 就是 `undefined`，按钮会“看起来什么也没发生”。

`uiWorkspace` 是**惰性解析**的（`pluginCtx.get("uiWorkspace")`），因为不是所有构建都发布它；缺失时只是不能自动跳转。

## 样式

- CSS 是 `client/src/index.js` 里的一个模板字符串，注入到 `Launcher` 根节点（不是 Panel）。
- 悬浮球有一份内联兜底样式：即使样式表没加载，它仍是可点可拖的圆。
- 原因是 `shell.overlay` 层是 `pointer-events: none`，按钮必须自己 `pointer-events: auto`。

## 已知的粗糙处

- 面板状态是一个全局对象 + `useReducer` 强制刷新，没有正式的 store；目前只有一个面板，够用。
- 轮询在面板关闭时停止（组件卸载），但打开时会一直每 2 秒请求一次。
