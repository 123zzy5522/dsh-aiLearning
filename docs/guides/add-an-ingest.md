# 怎么加一种建库方式（未实现，设计稿）

> **状态：接口尚未实现。** 本文描述的是切分方式和要改的地方，不是既成事实。
> 现在只有一条建库路径：扫描版/文字版 PDF。

## 为什么不是“把建库整个做成插件”

建库产出的是**数据格式**（`kp/*.md`、`index.json`、`events.jsonl`）。如果格式由插件定义，插件版本就绑定了数据格式：升级一个抽取插件，旧书可能打不开。

所以切分点是固定的：

| 留在内核 | 出成插件 |
|---|---|
| 批次规划、并发、暂停/续跑、发布 | `probe`：怎么探页数/目录/文字层 |
| 章节合并、id 分配、索引重建 | `chapterMap`：怎么识别目录 |
| 事件流水、掌握度 | `extractBatch`：怎么从一批输入抽出条目 |

抽取器只负责**产出符合内核 schema 的条目**，别的都不管。

## 目标接口

```js
// plugins/ingest-epub/host.js
export default {
  id: "ingest-epub",
  apiVersion: 1,
  kind: "ingest",
  name: "EPUB 抽取器",
  ingest: {
    // 决定这本书能不能用它；返回 null 表示不支持
    probe(ctx, source) { /* → { pageCount, hasTextLayer, sourceType: "epub" } | null */ },

    // 章节地图：直接给结构化结果最好，给不出就让模型读目录页
    chapterMap(ctx, book) { /* → { chapters: [...], tocFound: boolean } | null */ },

    // 一批：输入由内核决定（页图路径 / 文本片段），输出必须是这个形状
    async extractBatch(ctx, book, batch, signal) {
      return { items: [{
        section: "2.1.3",
        title: "...",
        claim: "...",
        evidence: "...",
        badCode: "", goodCode: "", language: "",
        tags: [], pitfalls: [],
        pdfPage: 32,
      }], problems: [] };
    },
  },
};
```

## 要改的地方（实现时）

1. **`book.json` 增加 `sourceType`**（`pdf-scan | pdf-text | epub | md`），默认 `pdf-text`，旧书按现有字段推断。
2. **注册表支持 `kind`**：`createRegistry()` 目前只校验 `mode`；加 `ingest` 的校验与互斥（同一 `sourceType` 只允许一个抽取器）。
3. **`runJob` 改为按 `sourceType` 分发**，而不是直接调 `runBatch`。
4. **`planBatches` 要抽象**：现在按“章 + 页数”切；EPUB 按“章 + 字数”切。批次结构体保持 `{ id, chapterNo, first, last }`，含义由抽取器解释。
5. **补合约测试**：一个假的 ingest 包跑完整 `runJob`，断言暂停/续跑/发布仍然成立。

## 不该做的事

- 不要让抽取器决定 id。id 由 `makeKpId` 统一生成，否则同一条知识点在不同抽取器下 id 不同。
- 不要让抽取器直接写 `kp/*.md`。它只返回 `items`，合并与渲染由内核做。
- 不要为了一种格式复制一份 `job.js`。

## 验收标准

一个 EPUB 包落地时，下面全部成立才算完成：

- [ ] 不装该包，PDF 建库完全不受影响（`packs.failed` 里也不会出现它）
- [ ] 装了之后，`book.json.sourceType` 正确
- [ ] 暂停/续跑/重新建库对 EPUB 同样有效
- [ ] 知识点 id 与 PDF 路径同一套规则
- [ ] `npm run smoke` 覆盖两种 `sourceType`
