# 发布与回滚

## 现状

- 仓库：`github.com/123zzy5522/dsh-aiLearning`（public）
- 分支：`main` 受 ruleset 保护，必须 PR + `verify`
- 合并：auto-merge（CI 绿后自动 squash）
- 版本：`package.json` 的 `0.1.0`，尚未打 tag

## 一次正常发布

```powershell
# 1. 在分支上开发
git checkout -b feat/whatever

# 2. 本地全绿（和 CI 同一套）
npm run check
npm run test
npm run smoke
npm run build:client      # 改了 client/src 才需要；CI 会校验产物

# 3. 提交 + 开 PR + 自动合并
git add -A
git commit -m "feat: ..."
git push -u origin feat/whatever
gh pr create --fill
gh pr merge --auto --squash

# 4. 等 CI
gh pr checks <N> --watch
```

CI 通过后 GitHub 自己合并，不需要人点。

## 打 tag（版本发布时）

```powershell
git checkout main
git pull --ff-only
git tag -a v0.2.0 -m "v0.2.0: plugin packs, stable ids"
git push origin v0.2.0
```

目前没有自动发布到 npm。别人安装走：

```
DSH → 设置 → 插件 → 安装第三方插件 → github:123zzy5522/dsh-aiLearning
```

## 回滚

**首选：revert 一个合并提交**（保留历史，CI 照跑）

```powershell
git checkout -b revert/bad-change
git revert <merge-commit-sha> -m 1
git push -u origin revert/bad-change
gh pr create --fill
gh pr merge --auto --squash
```

**不要**直接推 `main`——规则会拒绝（`protected branch`），并且那正是保护存在的意义。

**急停 auto-merge**：在 PR 页面右侧点掉 `Auto-merge`；已经合并的只能 revert。

## 发布前检查

- [ ] `npm run check` 绿，插件包数对
- [ ] `npm run test` 全过
- [ ] `npm run smoke` 全过
- [ ] `client.js` 是最新构建产物（CI 会拦）
- [ ] 没有 `sk-`、没有私人端点、没有 `.aiLearn/` 数据
- [ ] `docs/` 里描述的行为与实际一致（改行为就要改文档）

## 密钥与凭据

插件配置里**永远不该有 key**：建库走 DSH 账户的 `ctx.llm`。

`baseURL` / `apiKeyRef` / `model` 是给特殊部署的显式覆盖，默认全空。往仓库里提交任何凭据都算事故。
