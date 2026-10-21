# dsh-ailearn

把一本 PDF 课本编译成知识点库,然后用一个严格的教学对话把这本书学完。

- **一本书 = 一个项目目录 = 一个学习会话。**
- 建库**不是 agent 在聊**,是一条可断点续跑的后台流水线。
- 学习状态存在文件里,不靠上下文记,换会话不丢进度。
- **建库用的是你当前登录的 DSH 账户**,插件配置里没有任何密钥。

---

## 它做什么

```
PDF 课本  ──(建库流水线)──►  .aiLearn/kp/*.md
                             每个知识点:一句话 + 书中原文 + 坏例子/好例子 + 常见误解
                                  │
                                  ▼
                        「AI 教材导师」预设
                        短讲解 → 立即探测 → 按 rubric 判卷 → 写流水
                                  │
                                  ▼
                        .aiLearn/progress/events.jsonl
                              →  掌握度 / 覆盖台账 / 幻觉点
```

---

## 安装

```
DSH → 设置 → 插件 → 安装第三方插件
  → 填 GitHub 地址:  github:<你的账号>/dsh-ailearn
```

或者本地开发:

```
  → 填绝对路径:  D:\dsh-plugin
```

装完会得到:

| 名称 | 用途 |
|---|---|
| `dsh-ailearn` 插件 | 建库流水线 + 5 个 agent 工具 |
| 「AI 教材导师」预设 | 新建会话时可选,没有 shell、没有写权限 |
| 📚 悬浮按钮 | 选目录 / 建库 / 看进度 / 进学习 |

---

## 依赖

**Python 3 + PyMuPDF**,用于把 PDF 页面渲染成图片。插件会按这个顺序找:

1. 插件配置里的 `pythonPath`
2. 环境变量 `$env:DSH_PYTHON`
3. DSH 自带 Python(`load_workspace_dependencies` 报告的那个)
4. `python` / `python3`

找不到 PyMuPDF 时会尝试 `pip install pymupdf`(可通过 `autoInstallRenderer: false` 关闭)。

---

## 使用

### 1. 建库

```
📚 按钮 → 选择目录 → 建立知识库
```

- 目录里**没有知识点**:直接开建。
- 目录里**已经有知识点**:弹窗让你选「继续建库」(只补没跑完的批次)或「重新建库」(旧库移到 `.aiLearn/backup/`,再从 PDF 抽一遍)。
- 建库中可以**暂停**。暂停后已完成的批次立刻合并成知识点,可以马上开始学。
- 建库是后台任务,39 批并发 3 路,约 15–20 分钟。每批独立落盘,失败只损失一批。
- 库里有知识点时,面板上会出现**开始学习**;旁边会写清楚「多少条没学过、多少条到期复习」。

也可以直接在对话里说 **「把 D:\books\aspnet 这本书建完」**。

### 2. 学习

```
新建会话 → 预设选「AI 教材导师」→ 工作区选书目录 → 说「开始」
```

它会走这个循环:

```
learn_status  → 今天该讲哪个(按信息增益排序)
learn_kp      → 拿完整内容
讲 200-300 字 + 坏例子/好例子
出**一道**探测题
按 rubric 判分,指出命中/漏掉哪几条
learn_record  → 写进流水
答错 → 换讲法重讲 → 再出题(最多两次)
```

### 3. 查进度

```
「我学得怎么样」
```

返回:覆盖了多少 / 哪些从没考过 / 哪些均分最低 / **哪些是高信心答错的幻觉点**。

---

## 配置

全部在插件设置里,默认值即可用。

| 字段 | 默认 | 说明 |
|---|---|---|
| `ingestModel` | `''` | 建库专用模型,形如 `provider/model`。**留空 = 跟随当前账户** |
| `batchPages` | `12` | 每批页数。DSH 单条消息上限 20 张图,别超过 |
| `concurrency` | `3` | 并发批数 |
| `reasoningEffort` | `low` | 抽取不需要深度推理,low 能省 2/3 输出 token |
| `dpi` / `jpegQuality` | `150` / `85` | 页面渲染质量 |
| `pythonPath` | `''` | 指定 Python 解释器 |
| `baseURL` / `apiKeyRef` / `model` | `''` | **显式覆盖**,只在特殊部署时用 |

> ⚠️ `baseURL` / `apiKeyRef` 留空是有意的。填了就会绕过 DSH 账户、改用自己的端点——**不要把密钥写进配置文件并提交**。

---

## 数据格式

```
你的书目录/
├─ book.pdf
└─ .aiLearn/
   ├─ book.json              教材元信息:页数、页码偏移、章节地图
   ├─ pages/                 按需渲染的页面 JPEG
   ├─ kp/
   │  ├─ index.json          知识点索引(派生,可重建)
   │  ├─ .partial/           每批抽取结果(断点续跑的依据)
   │  └─ 01-第1章 xxx.md     知识点正文
   ├─ progress/
   │  ├─ events.jsonl        答题流水,追加写,永不修改
   │  └─ mastery.json        派生掌握度
   └─ jobs/                  建库任务记录
```

**`kp/*.md` 是唯一事实来源。** `index.json` 和 `mastery.json` 都可以从它重建。

格式选 Markdown 的理由只有一条:AI 抽错了一定会发生,而你必须能在 30 秒内改掉一条错的。

---

## 命令行验证

不装插件也能跑,用来验证流水线或做回归:

```powershell
node cli.js probe   "D:\books\aspnet"
node cli.js prepare "D:\books\aspnet"        # 建章节地图 + 标定页码偏移
node cli.js batch   "D:\books\aspnet" 1 1    # 第 1 章第 1 批
node cli.js status  "D:\books\aspnet"
```

---

## 开发与检查

提交前跑这三条，和 GitHub Actions 完全一致，全程不需要模型、Python 或网络：

```powershell
npm run check   # 语法 + 导入边界 + 插件 manifest
npm run test    # 单元测试（node:test）
npm run smoke   # 端到端：建库 → 合并 → 索引 → HTTP
```

`npm run check` 里的导入边界检查是硬约束：`plugins/` 里的能力包不许 import 另一个能力包，也不许碰 `kp/*.md`。这条规则由 CI 执行，不是靠自觉。

CI 在 `.github/workflows/ci.yml`，`main` 分支要求 `verify` 通过才能合并。见 [CONTRIBUTING.md](CONTRIBUTING.md)。

### 公共契约

`sdk/` 是内核、客户端、第三方插件三方共用的唯一契约（`apiVersion`、错误码、Snapshot 形状）。改它等于对所有插件发版，规则写在文件头。

---

## 设计决定

**1. 建库不用 agent。**
28 批塞进一个会话会撑爆上下文、无法断点续跑、输出 token 贵 3–5 倍,而且每次自由发挥会让字段漂移。固定 prompt + 固定 schema 才能保证 180 个知识点格式一致。

**2. 断点续跑是刚需。**
provider 实测约 2/5 的请求会 503 或断开。每批独立落盘,失败只损失一批。

**3. 走 `ctx.llm`,不走直连。**
凭证由 DSH 运行时注入,配置文件里一个密钥都没有。换人、换机器、换模型都不用改配置。

**4. 教的会话里没有 shell、没有写文件。**
预设只挂 `persona` + 只读 fs + 本插件工具。模型物理上改不了知识库。

**5. 自评「懂了」不是信号。**
讲完立即探测;高信心答错记为「幻觉点」,这是整个系统最有价值的单一信号。

---

## 已知限制

- 建库质量依赖扫描清晰度;深色截图页对比度低,代码可能抽错,需要手改。
- 抽出的知识点**一定会**有个别偏差。`kp/*.md` 可手改,改完不需要重建库。
- 页面引用按「印刷页 + 偏移」计算,偏移由 3 页采样取中位数;异常版式可能偏 1–2 页。
- 代码清单跨页时,`goodCode` 可能只抽到页首那一段。
- 目前只支持扫描版/文字版 PDF;整本渲染走 Python sidecar。

---

## 路线图

- [x] 建库流水线 + 断点续跑
- [x] 走 DSH 账户(`ctx.llm`),零密钥配置
- [ ] 学习模式:从零学 / 复习 / 快速过(三个预设)
- [ ] 复习范围限定(按章 / 按小节)
- [ ] 学科规则(数学、编程等各自的判卷标准)
- [ ] 题库作为出题 few-shot
- [ ] PDF 渲染改纯 JS,去掉 Python 依赖

## License

MIT