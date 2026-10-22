# 架构总览

## 一句话

`dsh-ailearn` 是一个 DSH 插件：把一本 PDF 课本**离线编译**成知识点库，再用一个**没有 shell、没有写权限**的教学会话把它学完。建库和教学是两条独立链路，只通过磁盘上的文件相接。

## 三条边界

这个仓库的几乎所有设计决定都能归到这三条边界上：

| 边界 | 规则 | 被谁强制 |
|---|---|---|
| **前后端** | 浏览器 bundle 与 host 进程只通过 `/dsh-ailearn/api` 的 JSON 通信，互不 import | `scripts/check-imports.mjs`（`client/` 不能 import `host/`） |
| **内核/插件** | 内核管数据与生命周期，插件只管策略 | 同一脚本（`plugins/` 只能 import `sdk/`、`node:*`、自身） |
| **数据/派生物** | `kp/*.md` 是唯一事实来源，`index.json`、`mastery.json` 都能重建 | 代码结构（重建函数独立） |

## 分层

```
┌──────────────────────────────────────────────────────────────┐
│ 浏览器 (client/src → client.js)                               │
│   面板：选目录 / 建库 / 暂停 / 模式下拉 / 开始学习              │
│   只拿 Snapshot，不判断业务                                    │
└───────────────────────────┬──────────────────────────────────┘
                            │ HTTP JSON (apiVersion 1)
┌───────────────────────────▼──────────────────────────────────┐
│ host (index.js + host/)                                       │
│                                                               │
│  index.js        装配：Config、路由、会话创建、建库调度        │
│  host/capabilities.js   能力注册表 + 插件包加载                │
│  host/job.js     批次调度（并发、暂停、续跑、发布）            │
│  host/ingest.js  目录识别、页码标定、分批抽取、章节合并        │
│  host/store.js   KP Markdown 编解码 + 索引                    │
│  host/progress.js 事件流水 + 掌握度折叠                        │
│  host/tools.js   6 个 agent 工具                              │
│  host/llm.js     模型通道（ctx.llm 优先，直连仅作覆盖）         │
└───────────────────────────┬──────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
   <书>/.aiLearn/       plugins/*/           sdk/
   kp/*.md              beginner             protocol.js
   progress/            review               codes.js
   jobs/                sprint
```

## 两条链路

### 建库（离线、可中断、不经过模型对话）

```
PDF ──探针──► 页数/文字层 ──标定──► 页码偏移
                              │
                         目录识别 ──► book.json（章节地图）
                              │
              ┌───────────────┴───────────────┐
              │ 批次（默认 12 页/批，并发 3）   │
              │  渲染页图 → 视觉抽取 → 校验    │
              │  每批独立落盘 .partial/*.json  │
              └───────────────┬───────────────┘
                              ▼
                  合并章节 → kp/*.md → index.json
                  （每完成一批就发布一次，可边建边学）
```

关键点：**建库不是对话 agent 干的**。39 批塞进一个会话会撑爆上下文、无法断点续跑、输出 token 贵 3–5 倍，而且格式会漂。

### 教学（会话内、有工具、无文件写权限）

```
learn_status ──► 返回：进度 + 当前模式规则(modeRules) + 建议知识点
     │
learn_kp ──────► 返回一个知识点的完整 Markdown
     │
  讲解 200–300 字 + 坏例子/好例子
     │
  出**一道**探测题
     │
  按 rubric 判分（模型自己判，必须引用原话）
     │
learn_record ──► 追加一行 events.jsonl（唯一推进掌握度的入口）
```

预设只挂 `persona + tool-fs(read) + compaction + 本插件工具`：**没有 bash，没有写文件**。模型物理上改不了知识库。

## 谁负责什么

| 问题 | 归谁 | 在哪 |
|---|---|---|
| 这本 PDF 有几页、有没有文字层 | 内核 | `host/pdf.js`、`host/ingest.js` |
| 一章该拆几批、哪批失败了 | 内核 | `host/job.js` |
| 知识点长什么样、id 怎么取 | 内核 | `host/store.js` |
| 这个知识点学得怎么样 | 内核 | `host/progress.js` |
| 现在该讲哪一个 | 内核（排序）+ 模式（策略） | `host/progress.js`、`plugins/*` |
| 怎么教、怎么判、先讲还是先考 | **插件** | `plugins/*/host.js` 的 `mode.rules` |
| 面板显示什么按钮 | 前端（按 Snapshot 判断） | `client/src/index.js` |

## 稳定契约

唯一跨三方（host / client / 插件）的契约在 `sdk/`（见 [`sdk/protocol.js`](../../sdk/protocol.js)）：

- `API_VERSION = 1`
- `CODES`：错误码（`build/none-running`、`mode/unknown`…）
- `Snapshot` / `BuildSummary` / `LearningSummary` / `ModeCard` 的形状

**改它等于对所有插件发版。** 同一版本内只能加字段；改字段含义必须升 `apiVersion`。

## 现在有什么、没什么

| 有 | 没有（见 [README 路线图](../../README.md)） |
|---|---|
| 建库全链路：探针、目录、标定、抽取、合并、索引、暂停/续跑 | 建库方式插件化（EPUB、OCR）——接口预留 |
| 6 个 agent 工具、3 个学习模式插件 | 绘图理解、题库 few-shot |
| 掌握度 / 幻觉点 / 覆盖台账 | 复习范围限定（按章） |
| CI：语法、导入边界、插件 manifest、单测、冒烟、产物新鲜度 | 多人协作的 `schemaVersion` 迁移框架 |
