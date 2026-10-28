# Changelog

## 0.1.0 — 2026-10-26

首个可独立消费的版本（从墨契壳抽出）。

- 块编辑器内核：`domain/`（Block 模型、事务、引用、属性、校验）+ `editor/`（Lexical 适配、输入规则、光标、名字行、宿主契约）
- 公开面：`MoqiEditor`（最小可复用编辑器）、`EditorHost` / `DocumentStoragePort`、`createMemoryEditorHost`、`EditorBody` / `EditorComposer`、`EditorFeatures` 可选能力判据、`useSlashMenu`（宿主自定义斜杠命令的内核钩子）、`MoqiEditor.plugins` 插槽
- `onPasteMedia` 可选：缺席即不拦截截图粘贴支路（媒体能力关闭时的深关语义）
- 浏览器内存宿主；`examples/editor-demo` 演示「无墨契壳」挂载与快照回写
- 独立构建：`pnpm build` 产出 `dist/index.mjs`（react / react-dom / lexical external）与 `dist/types` 声明
- 最小编辑器样式 `src/editor.css`（`--moqi-ed-*` 自带回退，宿主可换肤）
