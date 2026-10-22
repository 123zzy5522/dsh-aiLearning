# 插件模型

## 一句话

**内核管数据和生命周期，插件管策略。** 加一个插件 = 加一个目录，不需要改内核。

现在只有一种插件：学习模式（`mode`）。建库抽取器（`ingest`）的接口位置已经预留，见文末。

## 一个包长什么样

```
plugins/review/
├─ plugin.json     # 唯一的契约文件
└─ host.js         # ESM，default export = capability 对象
```

`plugin.json`（会被 `scripts/check-plugins.mjs` 校验）：

```jsonc
{
  "id": "review",                 // [a-z0-9-]，全仓库唯一
  "apiVersion": 1,                // 必须等于 sdk/protocol.js 的 API_VERSION
  "name": "复习",
  "description": "直接出题，答错才补讲。",
  "entry": "./host.js",
  "provides": { "mode": "review" },
  "consumes": ["books", "progress"]
}
```

`host.js`：

```js
export default {
  id: "review",
  apiVersion: 1,
  name: "复习",
  mode: {
    label: "复习",
    summary: "先出题再讲；错了才补 300 字以内。",
    tools: ["learn_status", "learn_kp", "learn_record", "learn_report"],
    rules: [
      "先出题，不要先讲解。",
      "学员答对：一句话确认，直接下一题。",
      "学员答错：200 字以内补讲，再出一道同类型新题。",
    ].join("\n"),
  },
};
```

## 加载过程

1. `apply()` 时 `loadPacks()` 扫 `plugins/*/plugin.json`。
2. 每个包 `import(entry)`，取 `default`（或 `capability`）。
3. `registry.register()` 校验：id 格式、`apiVersion` 匹配、无重复、mode 必须有 `label`/`rules`/`tools`。
4. 失败**只记录不抛出**：`/build` 的 `packs.failed` 会列出来，主流程照常。

这条“坏插件不致命”是硬要求：一个第三方包写错，不能让人家的课本打不开。

## 模式怎么生效

模式不是预设，也不是新的工具集。它是一张**教法卡**，通过三个触点生效：

| 触点 | 机制 |
|---|---|
| 模型 | `learn_status` 的返回值里有 `modeRules`，persona 规定「与默认流程冲突时以 modeRules 为准」 |
| 面板 | `/build` 返回 `modes[]` 与 `mode`，面板渲染下拉框，切换走 `POST /mode` |
| 存储 | 选择写在 `.aiLearn/session.json` 的 `mode` 字段，按书隔离 |

模型也可以自己调 `learn_mode` 列模式/切换。

**没有一模式一预设。** 那会让预设列表随模式膨胀，而且 DSH 的 preset 在创建时固化，中途换模式必须新开会话。

## 插件能做什么、不能做什么

| 能 | 不能（由 `scripts/check-imports.mjs` + 运行时强制） |
|---|---|
| 贡献 `mode.rules`、`label`、`tools` 列表 | 横向 import 另一个插件 |
| 用 `node:*`（`fs`/`child_process` 除外） | 读写 `kp/*.md`（没有 fs 就等于碰不到） |
| import `sdk/` 与自身文件 | 持有密钥、直连模型 |

`node:fs` / `node:child_process` 被禁，是为了让“插件不能改知识库”从口号变成结构事实。

## 版本与兼容

- `apiVersion` 不匹配 → 该包拒绝加载，并出现在 `packs.failed`。
- `sdk/` 的改动等同对所有插件发版；同版本内只加字段。
- 插件自己的 `package.json` 版本与 `apiVersion` 无关：前者是包的发布版本，后者是对内核契约的版本。

## 未来：建库方式也做成插件

`kind: "ingest"` 的接口已经预留，切分点固定：

| 留在内核 | 出成插件 |
|---|---|
| 批次调度、暂停/续跑、合并、索引、id 分配、事件流水 | `probe`（怎么探页数/文字层） |
| | `chapterMap`（怎么识别目录） |
| | `extractBatch`（怎么从一页图/一段文字抽出条目） |

原因：**数据格式不能被插件版本绑架**。抽取器只负责产出符合内核 schema 的条目，格式和调度永远在内核。

接口形态（尚未实现，勿写成既成事实）：

```js
export default {
  id: "ingest-epub",
  apiVersion: 1,
  kind: "ingest",
  ingest: {
    probe(ctx, file) { /* → { pageCount, hasTextLayer } */ },
    extractBatch(ctx, book, batch, signal) { /* → { items[], problems[] } */ },
  },
};
```

真正实现时要补：`book.json` 的 `sourceType`、注册表的 `kind` 分发、以及一条针对抽取器的合约测试。
