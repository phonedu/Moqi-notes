# Domain 层

Domain 层是项目 B 的稳定核心。它保存 Block 规则和用户操作语义，不依赖 React、Lexical、Tauri API 或 SQLite。

## 主要模块

- `block.ts`：Block 类型、正文片段、todo、AI 元数据和默认值。
- `treeOps.ts`：插入、移动、缩进、反缩进、折叠、删除和恢复。
- `typeOps.ts`：`/` 类型转换和 divider 原文处理。
- `refOps.ts`、`refs.ts`、`backlinks.ts`：对象/块双链、反向引用和来源查询。
- `properties.ts`：类型化属性、标签和 metadata 注册表。
- `selectionOps.ts`：父级优先去重、复制、批量删除和 identity 重建。
- `aiOps.ts`：AI 结果插入、来源绑定和状态降级。
- `operation.ts`、`validation.ts`、`serialization.ts`：事务、校验和 JSON 往返。

## 规则

所有结构修改都必须经过 operation/transaction；无效操作返回 no-op。Block JSON 是长期真相源，任何 UI 或编辑器都不能绕过这些规则直接改数据。
