# 贡献指南

谢谢你想为墨契出力。两页说清法律面与工程面。

## 法律面（DCO + 再许可授权）

- 提交请带 `Signed-off-by: 你的名字 <邮箱>`（`git commit -s`）——声明你有权按本项目许可贡献这段代码
- 你 contribution 的版权归你，但按**所在部分的许可证**进入项目（应用 = AGPL-3.0-or-later / 编辑器包 = MPL-2.0），并同时授予维护者**随项目换许可证 / 商业再分发**的权利（不转移版权、不签 CLA）

## 工程面

```bash
# 环境要求：Node 22+ / pnpm 9 / Rust stable /（Android 构建另需 SDK + NDK）
pnpm install                 # workspace 根目录跑
pnpm -C app dev              # 开发模式（浏览器预览，无需 Tauri）
pnpm -C app check            # 全部门禁：主题 / CSS 顺序 / 断点 / 字阶 / 体积 / typecheck / 测试 / 覆盖率
pnpm -C packages/editor test # 编辑器包测试
pnpm -C app tauri dev        # 真桌面窗口
```

## 提交纪律

- 一个 PR 一件事；UI 改动请附截图 / 录屏
- **动过编辑器必须跑 `pnpm -C app check`**，移动端交互改动请跑 `pnpm -C app accept`（需要 `pnpm -C app dev` 在线，214 项浏览器断言）
- 不引入第 6 个核心概念（块 / 页面 / 双链 / 属性 / 标签已满编）——设计提案先读 [ROADMAP](ROADMAP.md) 的「不做」
- 先开 Issue 讨论再写大改动；小修直接 PR

## 不接受

闭源衍生贡献、绕过许可证的商用授权请求（见 [TRADEMARK](../TRADEMARK.md) 与 LICENSE 的再许可条款）。
