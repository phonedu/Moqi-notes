# 贡献指南

感谢你愿意为墨契（Moqi）贡献！这是一个**维护模式**的项目：优先修 bug 与安全问题，功能冻结，不承诺路线图（见 ROADMAP）。

## 环境

- Node.js 22（CI 同版本）

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
5. 代码注释写自包含的说明：为什么这样做、约束是什么；不要引用本仓库之外的编号或文档。`pnpm -C app check:public-face` 会拦住新增的追溯编号和外部流程词。

### 评审约定

1. **开 PR 前自跑全部门禁**（`pnpm -C app check`）；涉及编辑器或数据层的改动，再单独做一轮针对性验证。
2. **按风险定介入**：数据 / 同步 / 发布相关改动需要维护者对照真实窗口或真机确认；样式 / 文案 / 注释类改动附截图或探针结果即可。
3. **同类问题一次改完**：评审指出一类问题，同一 PR 内所有同类位置一并修改。
4. **文档同步**：行为或契约变了，同一提交里更新 `docs/` 下的对应文档。

## 贡献条款（提交 PR 前请读）

1. 你提交的贡献按**贡献所在部分的许可证**授权进入本项目：产品应用部分 **AGPL-3.0-or-later**（见 `app/LICENSE`），编辑器包部分 **MPL-2.0**（见 `packages/editor/LICENSE`）。
2. 同时，你授予项目维护者将这些贡献随本项目以其他许可证（包括后续的开源版本或商业许可）再分发的权利。此授权不转移版权，只为保持项目未来的分发灵活性；项目当前没有、也不计划有商业版。
3. 如不同意以上条款，请不要提交 PR——欢迎开 Issue 讨论。

## 沟通

- Bug 与功能建议：GitHub Issues（先读 ROADMAP 的「不做」）。
- 安全问题：请通过 GitHub Security Advisories 私密报告，不要开公开 Issue。
- 语言：中文优先。
