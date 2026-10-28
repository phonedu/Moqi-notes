# app — 墨契产品壳

墨契（Moqi）的 Tauri 产品应用：桌面（Windows）+ Android 的 UI 装配、平台适配器与 Rust 侧存储 / 备份 / 同步文件交换。

编辑器内核在 [`packages/editor`](../packages/editor)（workspace 包 `@moqi/editor`）；**构建与门禁请一律从仓库根目录跑**：

```bash
pnpm install
pnpm -C app dev        # 浏览器预览（最快）
pnpm -C app check      # 全部门禁
pnpm -C app tauri dev  # 真桌面窗口
```

详细文档见仓库根 [README](../README.md) 与 [docs/](../docs/)。
