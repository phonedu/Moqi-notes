# 贡献指南

感谢你愿意为墨契（Moqi）贡献！这是一个**维护模式**的项目：优先修 bug 与安全问题，功能冻结，不承诺路线图（见 ROADMAP）。

## 环境

- Node.js ≥ 20（开发使用 22）
- pnpm 9（`corepack enable`）
- Rust（stable 工具链）
- Windows（桌面与 Android 构建官方支持的平台；Android 构建另需 Android SDK）

## 构建与验证

```bash
pnpm install --frozen-lockfile

cd app
pnpm check     # 文档 / 主题 / 体量 / 类型 / 测试 / 覆盖率全部门禁
pnpm dev       # 另开终端保持运行，然后：
pnpm accept    # 浏览器验收（本机 Edge 无头，约 14 分钟）

cd src-tauri
cargo test
cargo clippy --all-targets -- -D warnings
```

编辑器独立 demo：`cd app && pnpm demo`（`http://127.0.0.1:5174/`）。

## 提交流程

1. Fork → 建分支 → 小而聚焦的提交。
2. 修复类改动尽量带上测试（`app/tests/`）或验收项（`app/scripts/accept-editor.mjs`）。
3. 提交信息用一行主题写清「改了什么、为什么」。
4. 每个提交需要 DCO 签名：`git commit -s`（生成 `Signed-off-by: 你的名字 <邮箱>`）。

## 贡献条款（提交 PR 前请读）

1. 你提交的贡献按 **AGPL-3.0-or-later**（见 LICENSE）授权进入本项目。
2. 同时，你授予项目维护者将这些贡献随本项目以其他许可证（包括后续的开源版本或商业许可）再分发的权利。此授权不转移版权，只为保持项目未来的分发灵活性；项目当前没有、也不计划有商业版。
3. 如不同意以上条款，请不要提交 PR——欢迎开 Issue 讨论。

## 沟通

- Bug 与功能建议：GitHub Issues（先读 ROADMAP 的「不做」）。
- 安全问题：请通过 GitHub Security Advisories 私密报告，不要开公开 Issue。
- 语言：中文优先。
