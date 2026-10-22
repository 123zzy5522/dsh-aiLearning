# 怎么加一种学习模式

**目标**：加一个目录，面板里多一个选项，`learn_status` 会把它那套规则喂给模型。不改内核、不改预设。

## 1. 建目录

```powershell
mkdir plugins/exam
```

## 2. 写 `plugin.json`

```json
{
  "id": "exam",
  "apiVersion": 1,
  "name": "考前冲刺",
  "description": "只覆盖指定章节，先测后讲。",
  "entry": "./host.js",
  "provides": { "mode": "exam" },
  "consumes": ["books", "progress"]
}
```

校验规则（`scripts/check-plugins.mjs`）：

- `id` 匹配 `[a-z0-9][a-z0-9-]*`，全仓库唯一；
- `apiVersion` 必须等于 `sdk/protocol.js` 的 `API_VERSION`（现在是 1）；
- `entry` 文件必须存在；
- `consumes` 只允许 `books | progress | llm | storage | ui | sessions`。

## 3. 写 `host.js`

```js
export default {
  id: "exam",
  apiVersion: 1,
  name: "考前冲刺",
  mode: {
    label: "考前冲刺",
    summary: "先测后讲，只补错的。",
    tools: ["learn_status", "learn_kp", "learn_record", "learn_report"],
    rules: [
      "先出题，不要先讲。",
      "答对：一句话确认，跳到下一个知识点。",
      "答错：300 字以内补讲，然后出一道同类型新题。",
      "不要问「要不要继续」，直接继续。",
    ].join("\n"),
  },
};
```

`rules` 会**原样**进入模型上下文，所以：

- 用短句、祈使句，一条一行；
- 不要把格式说明、JSON schema 写进去（那是工具的职责）；
- 700 字以内，超了就没人遵守。

## 4. 本地验证

```powershell
npm run check     # manifest + 导入边界 + 语法
npm run test      # 会加载全部插件包
npm run smoke
```

`npm run check` 会输出 `plugins: 4 pack(s) ok`。

想单独看加载结果：跑一次 DSH，`GET /dsh-ailearn/api/build?dir=<书>`，看 `modes` 里有没有你，`packs.failed` 里有没有报错。

## 5. 让它生效

- 面板下拉框会自动出现（`/build` 的 `modes` 来自注册表）。
- 已经选过模式的会话：切到新模式，**下一轮 `learn_status` 生效**。
- 模型也可以调 `learn_mode`（列/切）。

## 6. 提交

```powershell
git checkout -b feat/mode-exam
git add plugins/exam
git commit -m "feat(plugins): exam mode"
git push -u origin feat/mode-exam
gh pr create --fill
gh pr merge --auto --squash
```

CI 绿后自动合并。

## 常见错误

| 现象 | 原因 |
|---|---|
| 面板没有新模式 | manifest 没被读到，或 `packs.failed` 里有它 |
| `learn_status` 不返回 modeRules | 该书 `session.json` 的 `mode` 指向一个不存在的 id → 回退到第一个已注册模式 |
| 加载报 `apiVersion` | `API_VERSION` 已经升版，改插件而不是改内核 |
| 模式规则被忽略 | `rules` 太长或太抽象；模型对“先出题”这种祈使句遵守度最高 |
