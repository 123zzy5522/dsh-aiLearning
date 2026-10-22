# 数据模型

## 目录

所有数据都在**用户的课本目录**下，不进仓库：

```
<book>/
├─ book.pdf
└─ .aiLearn/
   ├─ book.json            教材元信息（章节地图、页码偏移）
   ├─ pages/               按需渲染的页面 JPEG（可删，会重渲）
   ├─ kp/
   │  ├─ index.json        索引（派生，可删）
   │  ├─ .partial/         每批抽取结果（断点续跑的依据）
   │  └─ 01-第1章 xxx.md   知识点正文 ← 唯一事实来源
   ├─ progress/
   │  ├─ events.jsonl      答题流水（只追加，永不改写）
   │  └─ mastery.json      掌握度（派生，可删）
   ├─ jobs/                建库任务记录
   ├─ session.json         绑定的学习会话 + 学习模式
   └─ backup/              重新建库/迁移前的旧数据
```

**读代码时记住**：“派生”意味着删了会自动重建；“事实来源”意味着删了数据就真没了。

## book.json

```jsonc
{
  "version": 1,
  "title": "ASP.NET Core技术内幕与项目实战_15138226",
  "pdfPath": "D:\\...\\book.pdf",
  "pageCount": 412,
  "hasTextLayer": false,
  "pageOffset": 16,             // 印刷页 + 16 = PDF 页
  "tocFound": true,
  "tocPdfPages": [12, 13, 14],
  "chapters": [{ "no": 1, "title": "第1章 .NET Core 入门", "pdfPage": 17, "sections": [] }],
  "batchPages": 12,
  "dpi": 150,
  "createdAt": "..."
}
```

`pageOffset` 由 3 页采样取中位数自动标定；文字版 PDF 直接为 0。

## 知识点 Markdown

一章一个文件，`##` 是知识点边界：

```markdown
## KP-02-2.1.3 using 声明简化嵌套并自动释放资源

- 节: 2.1.3
- 印刷页: 16
- PDF 页: 32
- 标签: #using声明 #资源释放

### 一句话
...

### 书中依据
> 原文摘录

### 坏例子
```csharp
...
```

### 好例子
```csharp
...
```

### 常见误解
1. ...
```

解析器 `parseKpMarkdown` 会忽略代码块里的 `##`，测试覆盖了这一点。

## 知识点 id

```
KP-<章>-<节>        例：KP-02-2.1.3
KP-<章>-h<hash>     没有数字节号时，用标题哈希：KP-05-h1a2b3c
```

为什么不用 `KP-0203`（位置编号）：重抽一章会让后面所有知识点重新编号，`events.jsonl` 里的旧 id 立刻变成孤儿，掌握度归零且**没有任何报错**。

`makeKpId` 唯一决定这个规则，抽取和迁移共用。

## events.jsonl

一行一个 JSON，只追加：

```jsonc
{
  "at": "2026-10-22T05:00:00.000Z",
  "type": "attempt",
  "kpId": "KP-02-2.1.3",
  "dimension": "recall",      // recognize | recall | apply
  "score": 0.75,              // 0..1，按 rubric 采分点比例
  "confidence": 4,            // 答题前自评 1..5（可选）
  "kind": "code",             // mcq | fill | judge | code | recall
  "answer": "学员原话",
  "missed": ["没提到 Dispose 时机"],
  "note": "一句话判分理由"
}
```

`score` 缺省时按 `correct` 布尔折叠。`confidence >= 4 且 score < 0.5` 记一次 **illusion（幻觉点）**——这是整个系统最有价值的单一信号。

## mastery.json

完全从 events 折叠，可随时重建：

```
attempts, scoreSum, correct
dims: { recognize: {n,c}, recall: {n,c}, apply: {n,c} }
ease (2.5 起，答对 +0.1，答错 -0.2，夹在 1.3–3.0)
intervalDays (答对翻倍，上限 60；答错归零)
dueAt, lastAt, illusions, streak
```

`rebuildMastery(dir, { persist: false })` 给轮询用，不写盘。

## index.json

```jsonc
{ "version": 1, "generatedAt": "...", "count": 191,
  "kps": [{ "id", "title", "chapter", "section", "printPage", "pdfPage", "tags", "前置" }] }
```

由 `rebuildIndex` 扫 md 生成。**建库每完成一批就重建一次**，所以库边建边可读。

## jobs/<id>.json

```jsonc
{
  "id": "build-mvhf8xyn", "status": "partial",   // running | paused | partial | done | failed
  "totalBatches": 39, "doneBatches": 33, "failedBatches": 6,
  "batches": [{ "id": "c02-0042", "chapterNo": 2, "first": 41, "last": 52,
                "status": "failed", "attempts": 2, "error": "..." }],
  "log": ["2026-... start: 33 pending", "..."],
  "merged": [{ "chapterNo": 1, "file": "...", "count": 11 }],
  "finishedAt": "..."
}
```

## session.json

```jsonc
{
  "sessionId": "session-...",
  "preset": "ailearn",
  "mode": "beginner",
  "modeUpdatedAt": "...",
  "createdAt": "..."
}
```

**一本书 = 一个目录 = 一个会话**：DSH 的 workspace 按路径唯一，两本书放同一目录会串台。`/open` 优先复用这里记录的 session，找不到才新建。

## 版本与迁移

- 每个文件都有 `version`（book/index）或从结构推断（jobs）。
- `events.jsonl` 没有版本字段：**加字段可以，改字段含义不行**；真要改就写一条新的 event `type`。
- 已实现的一次迁移：位置 id → 节 id（`host/migrate.js`，幂等、先备份、改写 events、重建索引）。
- 尚未实现：统一的 `schemaVersion` + 迁移框架。新增格式字段前，先想清楚旧数据怎么读。

## 备份策略

| 操作 | 备份位置 |
|---|---|
| 重新建库 | `.aiLearn/backup/kp-<stamp>/` + `jobs-<stamp>/` |
| id 迁移 | `.aiLearn/backup/kp-ids-<stamp>/` |

`backup/` 不自动清理，用户自己删。
