# Editor 适配层

Editor 层把 Block JSON 映射到 Lexical，并把用户输入转换成领域层能理解的命令。Lexical EditorState 只属于当前会话，不能作为长期存储格式。

## 主要职责

- `blockNode.ts`：把 Block 类型、identity、折叠和 todo 状态映射为 Lexical 节点。
- `blockLexicalAdapter.ts`：Block 树与 EditorState 的加载和读回。
- Enter：依据当前 selection 拆分正文并创建相邻同级 Block。
- 结构命令：把 Tab、Shift+Tab、拖拽、折叠和跳转交给 domain store。
- 菜单命令：处理 `/`、`[[`、`((` 的临时状态和接受候选。

## 稳定边界

编辑器不能根据 DOM 位置猜测 Block identity，不能在保存完成前阻塞输入，也不能让异步重载覆盖用户当前 selection。行为细则统一见 [`docs/04-编辑器稳定规范.md`](../../../docs/04-编辑器稳定规范.md)。
