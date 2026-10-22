# Host：内核模块

Host 跑在 DSH 主进程里，是 `package.json` 的 `dsh.bundle` 指向的那个插件。它负责所有**数据和生命周期**，不做任何教学策略。

## 装配：index.js

只做五件事，别往里加业务：

1. `Config`（Standard Schema，`~standard.validate`）—— 见 [DESIGN 5.2](../DESIGN.md)。
2. 创建能力注册表，加载 `plugins/*`（异步，失败只记录不致命）。
3. 注册 HTTP 路由（下表）。
4. 注册 6 个 agent 工具（`host/tools.js`）。
5. 建库调度：内存里的 `running` map 是**唯一**判断“这个目录有没有活着的任务”的来源。

### 路由

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | 通道、provider、attachments 是否可用 |
| GET | `/build?dir=` | **唯一的读入口**，返回 `Snapshot`（含 modes/mode/packs） |
| POST | `/build/start` | `{dir, mode: auto\|resume\|fresh}` |
| POST | `/build/pause` | 中止在飞批次，已完成批次保留 |
| POST | `/mode` | 切换学习模式，写进 `session.json` |
| POST | `/open` | 找/建 workspace 与学习会话，返回 `sessionId` |
| GET | `/status` | 掌握度摘要（旧接口，面板不用） |
| POST | `/init`、`/resume` | `/build/start` 的兼容别名 |

错误统一走 `sdk/codes.js` 的 `errorBody(code, message, params)`：`code` 是给程序看的，`error` 字符串只为兼容旧客户端。

## 建库调度：host/job.js

一个 job 是 `jobs/<id>.json`，包含批次数组、状态、日志。

### 状态机

```
pending ──► running ──► done
                │
                ├──► failed          （模型/网络错误，消耗重试）
                └──► pending         （用户暂停，不消耗重试）
```

job 级状态：`running | paused | partial | done | failed`。

两条容易踩的规则，都已经在代码里：

- **暂停不是失败。** abort 时把在飞批次退回 `pending`，不写 `error`，不计入 `failedBatches`。
- **续跑必须立刻翻 `running`。** `runJob` 在第一个批次之前就 `job.status = "running"` 并落盘；否则 UI 在整个运行期间都读到上一次的 `partial`，暂停按钮永远不出现。

`/build` 读状态时，内存里有 worker 就压过磁盘状态；磁盘是 `running` 但内存没 worker（进程死过）→ 显示 `paused`。

### 发布

`publish()` 在**每完成一批**之后运行：把所有有已完成批次的章节 `mergeChapter`，再 `rebuildIndex`。所以库是边建边可用的，不是等 39 批全完。

### 重新建库

`resetBuild()` 把 `kp/` 和 `jobs/` 移到 `.aiLearn/backup/<stamp>/`，保留 `book.json` 和已渲染页面（重算要再花一遍模型钱）。

## 抽取：host/ingest.js

| 阶段 | 函数 | 说明 |
|---|---|---|
| 页码标定 | `calibrateOffset` | 抽样几页，用“印刷页 ↔ PDF 页”的中位数 |
| 目录定位 | `locateToc` | 先找出目录页在哪几页 |
| 目录展开 | `expandToc` | 逐页抽出章节与小节 |
| 组装 | `assembleChapterMap` | 得到 `chapters[]` |
| 规划 | `planBatches` | 按章切批，默认 12 页/批 |
| 单批 | `runBatch` | 渲染 → 视觉抽取 → 校验 → 写 `.partial/<batchId>.json`（幂等：文件存在就直接返回） |
| 合并 | `mergeChapter` | 按 `section` 去重，生成 `KP-<章>-<节>`，写 `kp/NN-title.md` |

`runBatch` 里有两处防御，都是被真实故障逼出来的：

- `parseJsonReply` 会把字符串里的裸 `\n` 转义后重试（模型爱把多行代码塞进 JSON 字符串）。
- `complete()` 看到 `finishReason === "length"` 会把输出预算翻倍重试一次。

## 数据：host/store.js 与 host/progress.js

`store.js` 是 Markdown 编解码器 + 索引重建：

- `renderKp` / `parseKpMarkdown` 必须互为逆运算（有测试）。
- `makeKpId` 决定 id：`KP-<章>-<节>`，没有数字节号时用标题哈希。
- `rebuildIndex` 扫全部 md 重新生成 `index.json`；**`index.json` 随时可以删**。

`progress.js` 是事件溯源：

- `appendEvent` 只追加，从不修改历史行。
- `rebuildMastery` 从 `events.jsonl` 折叠出每个知识点的 attempts/scoreSum/dims/ease/interval/illusions。
- `dueQueue` 排序：从未测过的（覆盖债）→ 均分低的 → 到期久的 → 幻觉点加权。
- `rebuildMastery(dir, { persist: false })` 给轮询用，不写文件。

## 能力注册表：host/capabilities.js

- `createRegistry()`：`register` 校验 id 格式、`apiVersion` 必须等于内核、重复 id 拒绝、mode 必须有 `label/rules/tools`。
- `loadPacks(root, registry)`：扫 `plugins/*/plugin.json`，动态 import `entry`，单个包失败只记录。
- `currentMode` / `setMode`：模式存在 `session.json`，按书隔离。

## 模型通道：host/llm.js

两条传输，默认第一条：

1. `ctx.llm`（DSH 账户，**零密钥**）—— 插件配置里没有任何 key。
2. 直连 HTTP —— 只有显式配了 `baseURL + apiKeyRef` 才用，给特殊部署。

`resolveLlmRoute` 拿不到服务时会返回 null，让上层给出明确错误，而不是静默降级成直连。

## 迁移：host/migrate.js

`migrateKpIds` 把旧的 `KP-0101` 位置 id 改成 `KP-01-1.1`，同时改写 `events.jsonl` 的 `kpId`，先备份 `kp/`。

**幂等**：已经是新格式的标题不会被二次改写。命令行入口 `node scripts/migrate-ids.mjs <bookDir> [--dry]`。

## 不该出现在 host 里的东西

- 某个模式的教法、判分口径 → 放 `plugins/*/host.js` 的 `mode.rules`。
- 某个学科的特殊规则 → 同上，做成一个模式包。
- 面向用户的完整句子 → 放 `locale/`，host 只给 `code`。
