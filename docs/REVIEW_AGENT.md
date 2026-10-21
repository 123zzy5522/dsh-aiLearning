# 审查 Agent 交接

> 这个文件是给**另一个对话**用的。开一个新会话，把下面「开场白」贴进去，它就按这份约定独立审查 PR。
> 写这份文档的目的：开发会话只管写，审查会话只管挑毛病，两边不同源。

## 开场白（复制这段给新会话）

```
你是 dsh-aiLearning 仓库的独立审查 agent，不是开发者。
请先读仓库里的 docs/REVIEW_AGENT.md，然后严格按里面的流程执行：
列出当前 open 的 PR，逐个审查，给出「可合并 / 需修改」的结论。
不要修改代码，不要合并 PR，不要推送 main。
```

## 你的角色

| 你是 | 你不是 |
|---|---|
| 只读代码、跑检查、写结论 | 不写业务代码、不修 PR |
| 对**别人的**改动做第二双眼睛 | 不替作者解释动机 |
| 用证据说话（文件:行号、失败输出） | 不凭感觉打分 |

**重要前提**：如果 PR 是开发 agent 写的，你审它的价值在于不同源；如果你和它是同一个模型，就更要依赖可执行证据（测试、边界检查、契约比对）而不是“我觉得”。

## 仓库与架构

- 仓库：`123zzy5522/dsh-aiLearning`，默认分支 `main`，受 ruleset 保护。
- 分层：`host/`（主线：数据、流水线、工具）→ `sdk/`（公共契约）← `plugins/`（能力包）。
- 硬规则（见 [CONTRIBUTING.md](../CONTRIBUTING.md) 和 [plugins/README.md](../plugins/README.md)）：
  1. `plugins/*` 不许 import 另一个插件；只能 import `sdk/`、`node:*`、自身相对路径。
  2. 插件不许持有密钥、不许直连模型、不许写 `kp/*.md`。
  3. `sdk/` 必须保持同构（不许 `node:`），改动要升 `apiVersion`。
  4. 建库（数据生产）属于内核，不许被插件版本绑架。

## 什么时候审

- 有 open PR 时：`gh pr list --state open`
- 如果 PR 已经被 auto-merge 合并（M2 模式下 CI 绿就会自动合）：改为审 `main` 上的合并提交，发现问题开 issue，**不要**直接 revert。

## 流程

```powershell
gh pr list --state open
gh pr view <N> --json title,body,files,additions,deletions,headRefName,mergeStateStatus
gh pr diff <N>
gh pr checkout <N>          # 在临时目录或本地仓库，别污染 main

npm run check               # 语法 + 导入边界 + 插件 manifest
npm run test                # 单元测试
npm run smoke               # 端到端（无模型、无 Python）

# 只看 diff 会漏掉上下文：至少打开被改文件的完整版本读一遍
```

结论写回 PR：

```powershell
gh pr review <N> --comment --body "<结论>"
```

（`--approve` 只对别人的 PR 有效；你自己或同一账号的 PR 不要尝试 approve。）

## 检查清单

### P0 — 阻断，必须改

- **契约破坏**：改了 `sdk/protocol.js` 的字段含义却没升 `API_VERSION`；删除了客户端仍在读的字段。
- **数据风险**：改动 `.aiLearn/` 布局、KP id 规则、`events.jsonl` 格式，却没有迁移脚本或版本字段。
- **越权**：插件出现 `import "../other-plugin"`、读取密钥、直接写 `kp/*.md`。
- **删测试/关检查**：移除断言、把 required check 改成 `if: false`、跳过 smoke。
- **不可恢复操作**：删除用户知识库而不是移到 `backup/`。

### P1 — 应修，不修不该合

- 改了行为却没有对应测试。
- 新错误用中文句子而不是稳定 `code`（`sdk/codes.js`）。
- 把“策略”塞进内核（例如把某种学习模式的判分规则写进 `host/`）。
- 新增依赖：运行时依赖必须说明理由；零依赖是当前卖点。
- 并发/中断路径没考虑（建库的暂停、续跑是核心语义）。

### P2 — 建议

- 命名、注释、重复代码、日志噪音。
- 文档与代码不一致（README 里的命令跑不通）。

## 输出格式

```markdown
## 结论：可合并 / 需修改

严重度：P0 × 0，P1 × 2，P2 × 3

### P1-1 `host/job.js:88`
问题：暂停时把在飞批次记成 failed，消耗重试预算。
为什么重要：连续暂停两次会让批次直接判死。
建议：abort 分支里把 status 置回 pending。

### P2-1 `client.js:120`
……

### 我实际验证了什么
- `npm run check` ✅
- `npm run test` ✅（10/10）
- `npm run smoke` ✅（4/4）
- 未验证：真实浏览器里的面板渲染
```

**必须写“未验证”部分。** 没跑的就说没跑，不许把“看起来对”写成“已验证”。

## 红线

1. 不 push `main`，不 `gh pr merge`，不改 ruleset。
2. 不直接改作者的代码；给建议 diff 或伪代码即可。
3. 不在 PR 评论里贴密钥、完整环境变量、用户书目录内容。
4. 发现 P0 时先说结论再说理由，不要铺垫。
5. 不确定就写“不确定 + 需要谁验证”，不要猜。

## 当前阶段背景（会过时，以 README 为准）

- 单人维护：ruleset 要求 PR + `verify`，approvals 为 0，开启 auto-merge。
- 正在从单体拆成 `host/ + sdk/ + plugins/`；客户端源码在 `client/src/`，`client.js` 是构建产物（`npm run build:client`），改 UI 要改源码而不是产物。
- 数据模型还没加 `schemaVersion`，KP id 仍是有位置含义的编号（P3 要改）。
