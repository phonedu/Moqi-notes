# 编辑器裸宿主 Demo

这是 `13-编辑器模块化` 的 M3：用 **`EditorHost` + 内存宿主** 把编辑器挂到一个没有墨契壳的 React 页面里。

## 跑

```bash
cd app
pnpm demo
```

打开 `http://127.0.0.1:5174/`。

## 它证明什么

- `MoqiEditor` 只依赖 `EditorHost`：`storage.load()` 读快照、`storage.save()` 回写快照；
- 不依赖 `composition` / `adapters` / Tauri，也不依赖页面库、回收站、同步或设置；
- 宿主实现可以换：这里是 `createMemoryEditorHost`，真实宿主可以换成 SQLite、localStorage 或远端；
- 基础工具栏仍走 Lexical 命令，但编辑器的读写面已经收在宿主契约里；
- 右侧显示宿主收到的块数、变更次数与落盘次数。

## 它不证明什么

- 不是正式 `@moqi/editor` 包（M4）；
- 没有完整桌面工具栏 / 移动触控层 / 选区气泡 / 块胶囊；
- 没有 AI、媒体、反链、页面跳转；
- 这些按 M4/M5 的插槽与可选能力接。

## 扩展点实证（M5 收尾）

`DemoSlashPlugin` 用包导出的 `useSlashMenu` 内核钩子 + `MoqiEditor` 的 `plugins` 插槽，
挂了两条宿主自定义斜杠命令（插入签名 / 插入日期）——在正文块首或空格后打 `/` 试试；
不依赖墨契壳的菜单数据源。

## 样式

编辑器正文样式来自包的 `@moqi/editor/src/editor.css`（M6 导出）：`--moqi-ed-*` 变量
只消费不定义，宿主在任意祖先上定义同名变量即可换肤。本页 `demo.css` 只管页面壳
（头部 / 双栏 / 工具栏按钮 / 宿主面板）。

## 契约入口

- `src/editor/host.ts`：`EditorHost` / `DocumentStoragePort`
- `src/editor/memoryHost.ts`：`createMemoryEditorHost`
- `src/editor/MoqiEditor.tsx`：最小可复用编辑器
