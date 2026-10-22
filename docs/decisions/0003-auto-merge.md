# 0003. 单人维护：CI 自动合并，合并权留在仓库所有者

- 状态：已采纳
- 日期：2026-10-21
- 相关：ruleset `main-protection`（GitHub Rules）、`.github/workflows/ci.yml`

## 背景

需求是两条，互相有张力：

1. 别人提交代码时，至少要过冒烟测试/流水线；
2. 合并分支的权限留在所有者手里。

同时这个项目当前只有一个人类维护者 + 一个开发 agent，PR 由 agent 开、CI 十几秒跑完。

## 选项

| 选项 | 好处 | 代价 |
|---|---|---|
| 关闭保护，直接推 main | 最快 | 没有门禁，违背需求 1 |
| PR + 必需检查 + 人工点合并 | 最稳 | 每个 PR 都要人点一次 |
| PR + 必需检查 + auto-merge | 不点；CI 绿即合 | 合并瞬间没人看 diff |
| 双人复核（approvals ≥ 1） | 有人看 | 单人时 GitHub 不允许自己 approve 自己 → 全部卡死 |

## 决定

- `main` 受 ruleset 保护：必须有 PR、必须过 `verify`、禁止 force push、禁止删分支、**bypass 列表为空**。
- `allow_auto_merge = true`：agent 开 PR 时启用 auto-merge，CI 绿后自动合并。
- `required_approving_review_count = 0`，`require_code_owner_review = false`。
- 只有仓库所有者的账号有写权限；外部贡献者给 `Read`，从 fork 提 PR。

## 理由

- 单人环境里 approvals ≥ 1 会把所有 PR 锁死（GitHub 不允许自我 approve），除非再加一个维护者账号或把自己放进 bypass——那等于关掉门禁。
- 门禁的实际价值在 `verify`：语法、导入边界、插件 manifest、单元测试、端到端冒烟、产物新鲜度。这些都是确定性的。
- 合并权仍然在所有者手里：外部贡献者没有写权限，点不了 Merge；所有者可以随时关掉某个 PR 的 auto-merge。

## 后果

- **好**：外部 PR 无法绕过 CI；日常零点击；历史线性（squash）。
- **不好**：
  - CI 绿 ≠ 代码正确。auto-merge 会在没有人看 diff 的情况下合并，只有事后审计。
  - 审查 agent 是**事后**角色：PR 从开到合只有十几秒，它通常审的是已合并的提交。
  - `CODEOWNERS` 目前只是准备工作，规则没开，所以它不产生任何约束。
- **重新考虑的信号**：
  - 出现第二个维护者 → `required_approving_review_count = 1` 并打开 `require_code_owner_review`。
  - 开始接受外部 PR → 对 `sdk/`、`.github/` 关闭该 PR 的 auto-merge，强制人工看。
  - CI 开始出现偶发失败 → 先修 flaky，不要用 bypass 绕过。
