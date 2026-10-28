# @moqi/editor

墨契的块编辑器内核：`domain`（Block 模型与事务）+ `editor`（Lexical 适配、输入规则、
光标、名字行、宿主契约）。离开墨契壳也能编辑并保存——宿主通过 `EditorHost` 供数据。

> 状态：workspace 内部包（`pnpm-workspace.yaml` 成员，源码直连消费）。发布到外部
> registry 前还有一轮发布打磨（LICENSE 全文随包、发布配置、CSS 全量切分），见仓库
> `docs/13-编辑器模块化.md`。完整可跑示例：`app/examples/editor-demo`（`cd app && pnpm demo`）。

## 快速开始

```tsx
import { MoqiEditor, createMemoryEditorHost } from '@moqi/editor'
import '@moqi/editor/src/editor.css'

const host = createMemoryEditorHost(seedBlocks)

<MoqiEditor
  host={host}                                  // 唯一必需：storage 读 / save 写
  toolbar={<MyToolbar />}                       // 可选：工具栏插槽（Lexical 命令可达）
  onChange={(blocks) => { /* 快照回调 */ }}
  placeholder="开始写…"
/>
```

真实宿主把 `createMemoryEditorHost` 换成自己的 `DocumentStoragePort`（SQLite、
localStorage、远端均可）；编辑器只发快照，不直接写库。

## API

| 导出 | 说明 |
|---|---|
| `MoqiEditor` | 最小可复用编辑器（`host` / `documentId` / `toolbar` / `onChange` / `onSave` / `onError` / `emptyPageName` / `contentClassName` / `placeholder`） |
| `documentId` 语义 | 变化 = 换文档 ⇒ 重新载入并**重挂载**（Lexical 只在挂载时消费初始内容；`host` 变化同理——宿主应保持 host 引用稳定） |
| 保存口径 | 200ms 防抖 ＋ **串行队列**（前一次落盘未完成时后一次排队，旧快照不会覆盖新快照）＋ 页面隐藏 / 关闭时尽力冲刷（best-effort） ＋ 渲染错误走 `onError` ＋ 兜底 UI（不裸抛） |
| `EditorHost` | 宿主契约：`storage`（必需）＋ 可选 `clipboard` / `assets` / `navigate` / `theme`（无消费者的端口不进契约） |
| `DocumentStoragePort` | `load(): Promise<Block[] \| null>` ＋ `save(blocks): Promise<void>` |
| `createMemoryEditorHost` | 浏览器内存宿主（demo / 单测用），带 `read()` / `writes` / `reset()` |
| `EditorBody` / `EditorComposer` | 正文宿主与 Lexical Composer 包装（自定义外壳时用） |
| `resolveFeatures` / `EditorFeatures` | 可选能力判据（ai / media / backlinks / properties），缺省全关——关闭时对应入口不出现 |
| `Block` / `BlockMap` / `BlockType` | 数据模型类型（沿用墨契单一 Block 模型） |

墨契壳内部接线用深路径 `@moqi/editor/src/domain/*`、`@moqi/editor/src/editor/*`
（不用 `exports` 子路径映射：tsc 不补扩展名而 tsx / vite 各有补全，深路径三种
解析器行为一致；正式导出表随发布批定）。

## 样式

`src/editor.css` 是裸编辑器的最小样式：全部经 `--moqi-ed-*` 自定义属性带回退值，
宿主不供令牌也能用，给了令牌即可换肤。块标记、浮层、触控层等完整观感仍在墨契壳
（`app/src/ui/app.css`），随「切编辑器 CSS」后续批搬入。

## 边界（`app/tests/logic/import-boundaries.test.ts`）

- `domain/` 不碰编辑内核，不向上引用 `editor/` / `ui/`，不依赖宿主层
- `editor/` 不反向引用 `ui/`；整个包不依赖 `composition` / `adapters` / 平台 API
- `ui/` 与 Lexical 零直连（内核只从 `editor/` 端口层取）

## 开发

```bash
cd packages/editor
pnpm typecheck   # tsc --noEmit
pnpm build       # 产物 dist/index.mjs + dist/types（react / react-dom / lexical external）
```

许可：AGPL-3.0-or-later（见 `LICENSE`）。
