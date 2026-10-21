# dsh-ailearn · 设计交接文档

> 生成时间:2026-10-21
> 用途:换工作区 / 换人接手时的完整上下文。本文档自包含,不需要回看聊天记录。

---

## 0. 一句话

把一本 PDF 课本编译成知识点库,然后用一个**严格的教学对话**把这本书学完。建库走 DSH 自己的 LLM 账户,插件配置里没有任何密钥。

---

## 1. 问题从哪来

原始诉求(用户):

> 面对课本时,AI 辅助学习变得很难。课本 PDF 内容量大、读起来难。
> 希望把 PDF 转成 AI 能快速理解的文件,建立知识库,AI 据此讲解;
> 学员理解后 AI 出题(选择/填空)、记录回答、追踪理解程度。

**关键修正**:用户最初的担心是「一本书塞不进上下文,AI 会忘」。这个担心是真的,但正确解法不是「转格式」,而是:

| 错误解法 | 正确解法 |
|---|---|
| 找一个 AI 能读的格式 | 别让 AI 读书,让 AI 读**编译产物** |
| 让 AI 记住全书 | 进度**存在文件里**,每轮只注入 1% |
| 一次把书喂进去 | 一次性编译 → 8 万 token 的知识点集 |

三个数字支撑这个结论(实测):

| 对象 | 体量 |
|---|---|
| 全书(412 页扫描件) | 约 62 万 token,**永远不进上下文** |
| 知识点全集(约 180–266 条) | 约 8 万 token,可完整容纳 |
| 单轮对话注入 | 8–12k token,**只用全书的 1%** |

---

## 2. 已定型的核心决策

### 2.1 建库不是 agent 干的

```
❌ 对话 agent 自己读 PDF 抽知识点
✅ Host 后台流水线,固定 prompt + 固定 schema
```

理由(按重要性):

1. **上下文必崩**:28 批塞进一个会话,compaction 会把前面的输出揉烂。
2. **断点续跑**:跑到第 25 批崩了,agent 方案只能重来(重烧 55 万 token)。流水线每批独立落盘。
3. **成本差 3–5 倍**:agent 会读不该读的、试探工具、自我反思。输出 token 才是贵的那一头。
4. **格式会漂**:agent 每次自由发挥,第 3 批和第 20 批字段就不一样了,索引就废了。

**例外**:修补单个知识点用 subagent(`ctx.subagents.startActivation`),因为那需要判断力。

### 2.2 数据格式:Markdown 是唯一事实来源

**第一性理由**:AI 抽知识点**一定会出错**。整套系统的生死线是「你能否在 30 秒内改掉一条错的」。

- 数据库/向量库 → 改不了 → 错的会一直喂给 AI → 越学越歪
- Markdown → 打开编辑器改一行即可

**不上向量库**:全书只有约 180 个知识点,目录树 + 关键词检索够用。向量库会引入「召回错误」这个新故障模式。

三层结构:

| 文件 | 格式 | 职责 | 谁写 |
|---|---|---|---|
| `kp/*.md` | Markdown,每章一个 | **知识点正文,唯一事实来源** | 建库生成,可手改 |
| `kp/index.json` | JSON | 索引:id、标题、页码、前置关系 | 从 md 派生,**可重建** |
| `progress/events.jsonl` | JSONL 追加写 | 每次答题一行,**永不修改** | 运行时追加 |

### 2.3 一本书 = 一个目录 = 一个会话

DSH 的 Workspace 按路径唯一。两本书放同一目录会变同一个 workspace,学习档案串台。所以插件必须校验:一个目录只能有一本教材。

### 2.4 教的会话里没有 shell、没有写文件

「AI 教材导师」预设只挂:

```yaml
- persona            (教学铁律)
- tool-fs            (read: true, readImage: true, write: false, edit: false)
- compaction         (长会话必需)
+ 本插件的 5 个 learn_* 工具
```

**没有 bash、没有 pwsh、没有写权限。** 模型物理上改不了知识库。这比在提示词里写「请不要乱改文件」可靠一万倍。

### 2.5 自评「懂了」不是信号

原设想是「AI 讲长段理论 → 学员回答理解 → AI 出题」。这个门禁是假的(流畅性错觉)。

改成:一个知识点讲 200–300 字封顶 → **立刻**出一道探测题 → 按 rubric 判分 → 记录。

额外收集一个信号:**答题前的自评信心(1–5)**。高信心 + 答错 = **幻觉点**,这是整个系统最有价值的单一数据。

---

## 3. 技术架构

### 3.1 目录

```
D:\dsh-plugin\
├─ package.json           dsh-ailearn, MIT, 可发布
├─ cordis.patch.yml       Host 行 + 「AI 教材导师」预设,无任何密钥
├─ index.js               Host 入口:HTTP API、建库调度、会话创建、Config(Standard Schema)
├─ client.js              客户端 UI:📚 悬浮球(可拖)+ 面板
├─ cli.js                 本地验证工具(只走直连,需显式配端点)
├─ scripts/pdfkit.py      PDF 探针 + 页面渲染(PyMuPDF)
├─ host/
│  ├─ config.js           路径解析、Python 探测
│  ├─ pdf.js              PDF 子进程封装
│  ├─ llm.js              两条传输:ctx.llm(默认)/ 直连(覆盖)
│  ├─ ingest.js           目录识别、页码标定、分批抽取、章节合并
│  ├─ job.js              并发批调度 + 断点续跑
│  ├─ store.js            KP Markdown 编解码 + 索引重建
│  ├─ progress.js         事件流水 + 掌握度折叠
│  ├─ toolkit.js          本地版 defineTool(避开 file: 安装的模块解析问题)
│  └─ tools.js            5 个 agent 工具
├─ locale/{zh,en}.json
├─ icon.svg
├─ LICENSE (MIT)
└─ docs/DESIGN.md         本文档
```

### 3.2 用户书目录

```
<书目录>/
├─ book.pdf
└─ .aiLearn/
   ├─ book.json            页数、页码偏移、章节地图
   ├─ pages/               按需渲染的 JPEG
   ├─ kp/
   │  ├─ index.json        索引(派生)
   │  ├─ .partial/         每批抽取结果(断点续跑依据)
   │  └─ 01-第1章 xxx.md   知识点正文
   ├─ progress/
   │  ├─ events.jsonl      答题流水(追加写)
   │  └─ mastery.json      派生掌握度
   └─ jobs/                建库任务记录
```

### 3.3 知识点格式

```markdown
## KP-0204 using 声明简化嵌套并自动释放资源

- 节: 2.1.3
- 印刷页: 16
- PDF 页: 32
- 标签: #using声明 #资源释放

### 一句话
C# 8.0 using 声明在变量声明前加 using,变量离开作用域时自动调用 Dispose,避免多层嵌套。

### 书中依据
> (原文摘录)

### 坏例子
```csharp
...
```

### 好例子
```csharp
...
```

### 常见误解
1. 以为 using 声明可以像传统 using 块那样由开发者任意指定资源释放时机
```

### 3.4 五个 agent 工具

| 工具 | 用途 |
|---|---|
| `learn_status` | 当前进度 + 今天该讲哪个(按信息增益排序) |
| `learn_kp` | 读一个知识点的完整内容。**所有讲解必须来自这里** |
| `learn_record` | 记录一次判分。**唯一推进掌握度的入口** |
| `learn_report` | 掌握度表 + 覆盖缺口 + 幻觉点 |
| `learn_build` | start / resume / status 建库 |

设计原则(官方要求):**一个操作,两个调用方**。UI 和工具调同一份实现,不能各写一套。

### 3.5 掌握度模型

每个知识点三个维度:**认得 / 说得出 / 用得上**(`recognize` / `recall` / `apply`)。

```
attempts, scoreSum, correct
dims: { recognize: {n,c}, recall: {n,c}, apply: {n,c} }
ease (2.5 起,±0.1/0.2)
intervalDays (答对翻倍,上限 60;答错归零)
dueAt, lastAt
illusions (高信心答错的次数)
```

`mastery.json` 完全从 `events.jsonl` 折叠而来,可随时重建。

### 3.6 建库状态机与交互

任务状态:`running`(有 worker 在跑)→ `paused`(用户暂停,或进程死掉)→ `partial`(跑完但有失败批)→ `done`;另有 `failed`(一批都没成)。

- **一个入口**:面板只有「建立知识库」。目录里已有知识点时弹窗二选一,不让按钮标签替用户猜。
- **暂停**:abort 在飞的批次,把它们退回 `pending`;已完成的批次立刻合并并重建索引。暂停不消耗重试预算,也不会被记成模型失败。
- **发布**:每完成一批就 `mergeChapter` + `rebuildIndex`,所以库里随时有可学内容,不必等 39 批全完。
- **孤儿任务**:job 文件写 `running`、内存里却没有 worker(DSH 重启),读取时按 `paused` 处理。
- **重新建库**:`kp/` 与 `jobs/` 移到 `.aiLearn/backup/<stamp>/`;保留 `book.json` 与已渲染页面(重算要再花一遍模型钱)。

---

## 4. 实测数据(都是跑出来的,不是估的)

### 4.1 PDF 与视觉能力

| 项 | 值 |
|---|---|
| 测试书 | 《ASP.NET Core 技术内幕与项目实战》杨中科,412 页 |
| 文字层 | **完全没有**(412 页 0 页可提取文字) |
| 每页结构 | 1 张 JPEG 2016×2688(约 243 DPI) |
| 渲染后识别 | 150 DPI(1241×1754)足够,代码行号/缩进/泛型尖括号全对 |
| 页码偏移 | 正文 **+16**(印刷页 + 16 = PDF 页),由 3 页采样取中位数自动标定 |

### 4.2 成本

| 项 | 实测 |
|---|---|
| 单页图像 token | **约 1,062**(1090×1540 JPEG q85) |
| 单批(12–15 页) | 输入 ~15k / 输出 ~6–8k token |
| 全书 39 批 | 约 45 万输入 + 21 万输出 |
| prompt 缓存 | **已生效**(cached_tokens ≈ 输入量的 98%) |
| 并发 3 | 约 15–20 分钟 |

### 4.3 reasoning_effort 的影响

| 参数 | 推理 token | 耗时 |
|---|---|---|
| 默认 | 1849 | 25.1s |
| **`low`** | **651** | **11.8s** |

内容完全一致。**建库全程用 low**;教学对话用 high。

### 4.4 稳定性

| 项 | 值 |
|---|---|
| provider 请求失败率 | **约 2/5**(503 / 连接中断) |
| 结论 | 28 批全成功概率≈0,**断点续跑是刚需不是加分项** |

---

## 5. 踩过的坑(每一条都是真金白银)

### 5.1 `file:` 链接安装 → 裸导入全部失效

**现象**:`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'`

**原因**:`file:`/`link:` 安装是**链接目录**,Node 从真实路径 `D:\dsh-plugin\host\` 往上找 node_modules,看不到 DSH 安装目录里的包。官方文档说的「DSH 自带包会从安装目录解析」只对 registry 安装成立。

**修法**:写 `host/toolkit.js` 本地实现 `defineTool`。**整个插件现在零裸导入**。

### 5.2 `Config` 必须是 Standard Schema

**现象**:`TypeError: Cannot read properties of undefined (reading 'validate')`

**原因**:Cordis 的 `resolveConfig` 调用 `Config["~standard"].validate(raw)`。普通对象没有 `~standard`。

**修法**:实现 `{"~standard": {version, vendor, validate}}`。同时注意工具 schema 的三条约束:

- 参数不允许 `required: false`(可选参数必须整个省略)
- 输出 schema 根节点不允许 `required: true`
- 字符串数组的 item 不允许 `required`

### 5.3 `shell.overlay` 层是 `pointer-events: none`

**现象**:按钮看得见、点不到、拖不动、Ctrl+Shift+C 也选不中。

**原因**:`.overlayLayer{ z-index:20; pointer-events:none; position:absolute; inset:0 }`。这是 DSH 的设计——overlay 层默认透明,让鼠标穿透。

**修法**:按钮和面板自己 `pointer-events: auto`。

### 5.4 样式注入位置错误(最容易犯的 UI bug)

**现象**:同上,而且改了默认位置也不生效。

**原因**:`<style>{CSS}</style>` 写在了 `Panel` 组件里,只在面板打开时存在;按钮在 `Launcher` 里,永远拿不到样式。于是 `class="al-fab"` 只是个名字,实际是浏览器默认样式。

**修法**:样式提到 `Launcher` 根节点;**并给按钮加内联兜底样式**——即使样式表挂了,它仍是个可点可拖的 44×44 圆。

### 5.5 `runBatch` 收到的是 runtime,不是 ctx

**现象**:`ailearn: image blocks require ctx.attachments on the LLM transport`

**原因**:同一个对象有两种形态混用。`prepareBook` 手动拼了 `attachments`,而 `job.js` 直接 `runBatch(runtime, ...)`,runtime 上没有 `attachments`。

**修法**:`armRuntime` 里 `runtime.attachments = ctxForAttachments(runtime)`,让 runtime 自己携带所有需要的服务。

### 5.6 JSON 里有裸换行

**现象**:`Expected ':' after property name in JSON`

**原因**:模型把多行代码直接塞进 JSON 字符串(非法)。

**修法**:`parseJsonReply` 里加 `escapeControlChars`,把字符串内的裸 `\n` `\r` `\t` 转义后重试解析。

### 5.7 长章节输出被截断

**现象**:`model reply has unbalanced JSON`

**原因**:`max_tokens` 被推理 token 吃光或内容超长。

**修法**:`complete()` 检测 `finishReason === "length"`,自动用**翻倍预算重试一次**(上限 32000)。

### 5.8 推理 token 吃光输出预算

**现象**:`content` 为空,`completion_tokens` 全花在 `reasoning_tokens`。

**修法**:建库用 `reasoningEffort: "low"`;`maxOutputTokens` 给足(8000 起)。

---

## 6. 当前状态

### 已完成

| 项 | 状态 |
|---|---|
| PDF 探针 / 渲染 | ✅ |
| 目录识别(两级:先定位目录页,再逐页抽小节) | ✅ 10 章 / 266 小节 |
| 页码偏移自动标定 | ✅ 实测 +16,与手算一致 |
| 分批抽取 + 校验 | ✅ |
| 章节合并 + 索引重建 | ✅ |
| 断点续跑 | ✅ |
| 事件流水 + 掌握度 + 幻觉点 | ✅ |
| 5 个 agent 工具 | ✅ 通过 DSH 真实 schema 编译 |
| 「AI 教材导师」预设 | ✅ |
| 客户端 UI(可拖悬浮球 + 面板) | ✅ 已修 pointer-events |
| 建库走 `ctx.llm`(零密钥) | ✅ 链路验证通过 |
| 发布元数据(MIT / 非 private / README / .gitignore) | ✅ |

### 正在验证

**建库全量跑通**。最近一次:23/39 批完成、16 批失败,失败集中在 JSON 换行与截断;修复已在源码里,但运行中的进程加载的是旧模块(文件修改时间晚于 DSH 启动),需要重启后再 resume。

**索引 bug(已修)**:`rebuildIndex` 原先只被 `cli.js` 调用,建库路径从不重建 `index.json`——磁盘上 169 条,索引里只有 23 条(只有第 1、2 章)。现在每完成一批就合并章节并重建索引,暂停时也发布,`learn_status` 的口径随之恢复。

**建库交互(已改)**:单一「建立知识库」入口;已有知识点时弹窗选「继续建库 / 重新建库」(重新会把 `kp/` 与 `jobs/` 移到 `.aiLearn/backup/`);运行中可暂停;库里有知识点即出现「开始学习」。见 3.6。

### 未验证 / 风险

| 项 | 说明 |
|---|---|
| `ctx.attachments` 在真实部署是否可见 | ✅ health 返回 `attachments: true`,建库已实际送图 |
| `resolveLlmRoute` 拿到的 provider 名是否有效 | ✅ health 报 `deepseek-account`,23 批真实抽取成功 |
| `/open` 自动建会话 | 用 `ctx.get("sessionController").create()`,失败会降级提示 |
| 真实浏览器里的拖动手感 | 只能在界面验证 |
| 视觉模型抽取质量 | 已抽查 23 条,质量可接受;代码缩进正确 |

---

## 7. 路线图(用户提的四个方向)

### ① 学习模式:从零学 / 复习 / 快速过

**最划算的功能**,只是换 persona 和出题策略,不动数据层。

```
从零学    讲解 300 字 + 代码对照 + 每题必判 → 一个知识点吃透再走
复习      不讲解,直接混合出题,错了才补讲
快速过    只讲一句话 + 常见误解,不判分,只标记"看过"
```

做法:一套代码,**三个预设**:`ailearn-beginner` / `ailearn-review` / `ailearn-sprint`。

### ② 学科规则(数学 / 编程 …)

**方向对,但实现位置要换**。不该做成「选一个知识库」,而该做成**预设 persona**:

```yaml
# ailearn-math
prefix: |
  你教大学数学。判卷规则和编程不同:
  - 证明题按步骤给分,不按结论
  - 计算题答案对但过程跳步 → 最多给一半
  - 编程题按能否运行,数学题按推导是否严谨
```

「避免挤爆上下文」这个诉求其实不需要额外机制——**266 个知识点的索引只有 30KB,正文本来就是按需取的**。

### ③ 题库作为出题模范

```
第 1 步:题库库(题面 + 答案 + 解析),独立目录 .aiLearn/bank/
第 2 步:出题时检索相似题型,把 2–3 道当 few-shot 喂给出题器
```

**坑**:直接喂真题会让模型「抄题」而不是「学题型」。要明确喂的是**题型结构**,或者要求「生成同类型新题」。

### ④ 复习范围限定

**优先级最高**(仅次于①),因为这是真实使用中最常见的诉求:「我下周只考第 3–5 章」。

实现:`learn_status({ chapterRange: "3-5" })`,底层 `dueQueue` 已支持过滤。

### 优先级

| 优先级 | 事项 | 工作量 |
|---|---|---|
| **P0** | 建库走 `ctx.llm` + 可分发 | ✅ 完成 |
| **P1** | 复习范围限定 | 半天 |
| **P1** | 三种学习模式 | 1 天 |
| **P2** | 学科规则(预设层) | 半天 |
| **P3** | 题库 few-shot | 2–3 天 |
| **P4** | 发 npm / GitHub | 半天 |

---

## 8. 分发

### 现状

- 包名 `dsh-ailearn`,`private: false`,MIT
- 本地开发用 `link:D:/dsh-plugin` 安装 → **改文件即生效,不用重装重下**
  - `client.js` 改动:`client-hmr` 每 500ms 轮询 mtime,推 `rebuilt` 帧,前端自动 reload
  - Host 侧改动(`index.js`/`host/*`):**必须重启 DSH**
- `plugin_manager` 对已安装包会拒绝重复安装(`already-installed`),那是给 registry 包用的语义

### 发 GitHub

```powershell
cd D:\dsh-plugin
git init -b main
git add .
git commit -m "feat: textbook learning plugin with zero-credential ingest"
git remote add origin https://github.com/123zzy5522/dsh-aiLearning.git
git push -u origin main
```

别人安装:`安装第三方插件 → github:123zzy5522/dsh-aiLearning`

**提交前检查**:已确认无 `sk-` / 私人端点;`repository` 指向 `123zzy5522/dsh-aiLearning`。

### 凭据安全

**插件配置里一个密钥都没有。** 建库走 `ctx.llm`,用当前登录的 DSH 账户。这是发布的硬前提,不能退化。

只有在需要「建库用另一个模型」时才填 `ingestModel`(形如 `provider/model`)。

---

## 9. 协作注意事项

1. **插件是通用工具,知识点是私人数据。** 不要把抽出来的知识点提交进仓库(既是版权内容,也是个人学习记录)。
2. **需要给一个 fixture**:5 页假 PDF + 期望输出,让协作者 10 秒能验证,而不是抽真书 15 分钟。
3. **`.aiLearn/` 的 JSON schema 要写成文档**,否则协作者改坏格式没人知道。
4. 多人共同维护同一知识库时,`events.jsonl` 追加写会冲突,需要改成按人分文件。

---

## 10. 快速上手(接手者)

```powershell
# 1. 依赖
#    Python 3 + PyMuPDF(插件会自动探测 DSH 自带 Python)

# 2. 语法检查
node --check index.js
Get-ChildItem -Recurse -Filter *.js | % { node --check $_.FullName }

# 3. 不装插件也能验证流水线(需自备端点)
$env:AILEARN_BASE_URL="https://your-proxy/v1"
$env:AILEARN_MODEL="deepseek-flash"
$env:DEEPSEEK_API_KEY="sk-..."
node cli.js probe   "D:\books\aspnet"
node cli.js prepare "D:\books\aspnet"
node cli.js batch   "D:\books\aspnet" 1 1
node cli.js status  "D:\books\aspnet"

# 4. 装进 DSH 后查健康状态
#    GET /dsh-ailearn/api/health
#    → { transport: "dsl-llm", provider, model, attachments: true }
```