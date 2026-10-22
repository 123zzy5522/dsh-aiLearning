# 文档

这个目录放三样东西，**按“会不会过时”分开**，因为它们的维护方式完全不同：

| 目录 | 放什么 | 多久过期 | 谁改 |
|---|---|---|---|
| [architecture/](architecture/) | 系统怎么分层、模块干嘛、数据长什么样 | 慢（结构变了才改） | 改结构的人 |
| [decisions/](decisions/) | 为什么这样选、推翻过什么（ADR） | **永不过期**，只追加 | 做决定的人 |
| [guides/](guides/) | 具体怎么做一件事（加模式、加抽取器、发布） | 快 | 做那件事的人 |

还有两篇不在上面三类里：

- [DESIGN.md](DESIGN.md) —— 2026-10-21 的交接稿，保留作为历史快照。**它描述的 `client.js`、按钮、id 格式已经过时**，现行事实以 `architecture/` 为准。
- [REVIEW_AGENT.md](REVIEW_AGENT.md) —— 独立审查会话的作业规程。

## 从哪里开始

| 你想…… | 读 |
|---|---|
| 30 秒搞懂这个项目 | [architecture/overview.md](architecture/overview.md) |
| 改后端 | [architecture/host.md](architecture/host.md) |
| 改面板/界面 | [architecture/client.md](architecture/client.md) |
| 写一个插件 | [architecture/plugin-model.md](architecture/plugin-model.md) + [guides/add-a-mode.md](guides/add-a-mode.md) |
| 动数据结构 | [architecture/data-model.md](architecture/data-model.md) |
| 知道为什么这么设计 | [decisions/](decisions/) |

## 写文档的规矩

1. **写现状，不写愿望。** 没实现的东西放 `路线图`，不要混进架构章节。读者拿文档当事实用。
2. **给路径和命令，不给形容词。** “可扩展”没有信息量；“插件通过 `plugin.json` 声明 `consumes`，由 `scripts/check-plugins.mjs` 校验”有。
3. **过时就改或删。** 一份说错话的文档比没有文档更贵——它会让人按错的做。
4. **决定写成 ADR。** 改了主意不要改写旧 ADR，新写一篇、在旧的上面标注 `Superseded by NNNN`。这样“为什么当初那样”不会丢。
5. **文档改动和代码改动同一个 PR。** 分开提交的结果是文档永远落后一个版本。

## 新增一篇文档

- 架构变化 → 改 `architecture/` 下对应文件，不新建。
- 做了有争议的选择 → 在 `decisions/` 加 `NNNN-短横线标题.md`，编号递增。
- 教别人做一件事 → 在 `guides/` 加文件，并在上面“从哪里开始”表里加一行。

ADR 模板见 [decisions/0000-template.md](decisions/0000-template.md)。
