# Contributing

## 本地检查

提交前跑一遍，和 CI 完全一致（无依赖、无网络、不调模型）：

```powershell
npm run check   # 语法 + 导入边界 + 插件 manifest
npm run test    # 单元测试
npm run smoke   # 端到端冒烟：建库 → 合并 → 索引 → HTTP
```

## 提 PR

1. Fork，从 `main` 切分支，分支名 `feat/…`、`fix/…`、`docs/…`。
2. 只改一件事。重构和功能不要混在一个 PR 里。
3. 新增能力必须放在 `plugins/<id>/`，不要改内核去"顺手支持"它。
4. CI 必须全绿。维护者合并前会看 `git diff` 而不是 PR 描述。
5. 不要提交 `.aiLearn/`、`node_modules/`、任何密钥或私人端点。

## 目录归属

| 目录 | 谁负责 | 说明 |
|---|---|---|
| `host/`、`index.js` | 维护者 | 主线：数据、流水线、工具 |
| `sdk/` | 维护者 | 公共契约；改动等于对所有插件发版 |
| `plugins/` | 插件作者 | 一个目录一个能力，自带测试 |
| `client.js` | 维护者 | UI 外壳与插件面板注册表 |
| `.github/`、`scripts/` | 维护者 | 门禁本身 |

## 插件作者

读 [`plugins/README.md`](plugins/README.md)。两条不可协商：

- 插件不得横向 import 另一个插件。
- 插件不得直接写 `kp/*.md`，也不得持有密钥。

违反这两条的 PR 不会被合，即使功能能跑。
