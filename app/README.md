# 项目 B 应用工程

这是项目 B 的可运行应用目录。产品说明、功能边界和验收规则统一维护在上一级 [`docs/`](../docs/README.md)，本文件只解释代码如何启动和分层。

## 分层

- `src/domain/`：Block、树操作、引用、属性、选择和 AI 规则。不能依赖 React、Lexical、Tauri 或 SQLite。
- `src/application/`：Store、事务、撤销/重做、持久化队列和 AI 用例。
- `src/adapters/`：浏览器存储、Tauri Port 和 OpenAI 兼容 AI 适配器。
- `src/editor/`：Lexical BlockNode 与 Block JSON 的双向映射。
- `src/ui/`：编辑器外壳、菜单、侧栏、属性、反向链接、回收站和 AI 设置。
- `src-tauri/`：桌面壳、SQLite 和 Tauri command。
- `tests/`：领域 A 类、用户行为 D 类、AI 逻辑 L 类测试。

## 常用命令

```powershell
pnpm install
pnpm dev
pnpm typecheck
pnpm test
pnpm build
pnpm lint
```

桌面层命令在 `src-tauri/` 执行：

```powershell
cargo fmt --check
cargo check
cargo clippy --all-targets -- -D warnings
cargo test
```

## 当前状态

交付版本与阶段状态只看上一级 `docs/05-版本状态与计划.md`（当前：`0.5.0` 已交付、`0.6` 在办）；验收是否关闭看 `docs/07-验收记录.md`。本文件只管「代码如何启动和分层」，不复制状态。
