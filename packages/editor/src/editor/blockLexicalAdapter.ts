import {
  $createLineBreakNode,
  $createTextNode,
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  $isTextNode,
  CLEAR_HISTORY_COMMAND,
  createEditor,
  HISTORIC_TAG,
  type EditorState,
  type LexicalEditor,
  type LexicalNode,
  type TextNode,
} from 'lexical'
import { cloneBlock, orderedRootIds, type Block, type BlockMap, type ContentFragment } from '../domain/block'
import { $selectBlockStart } from './caret'
import { $ensureNameLineHolder } from './nameLine'
import {
  $createBlockNode,
  $createInlineFragmentNode,
  $ensureNameLineAnchor,
  $isBlockNode,
  $isInlineFragmentNode,
  applyMarks,
  BlockNode,
  InlineFragmentNode,
  marksFromTextNode,
  NameLineAnchorNode,
} from './blockNode'

export const editorNodes = [BlockNode, InlineFragmentNode, NameLineAnchorNode]

export function createMoqiEditor(): LexicalEditor {
  return createEditor({ nodes: editorNodes })
}

/** Rebuilds the editable tree from active Blocks. Lexical keys are intentionally discarded. */
export function loadBlocksIntoEditor(editor: LexicalEditor, blocks: BlockMap): void {
  editor.update(() => {
    const root = $getRoot()
    root.clear()
    const roots = orderedRootIds(blocks)
    for (const id of roots) root.append(blockToNode(blocks.get(id)!, blocks))
    // 打开页面后光标落在**页面容器自己的那一行**（页面名 = 正文首行，docs/04 §3.1）：
    // 用户打开/新建页面就能直接写名字；写出的内容属于容器块本身，不会变成根级段落。
    // 落点用 $selectBlockStart（不是 selectStart）：换文档必须**行内格式归零**，
    // 否则上一页光标处的加粗 / 高亮会跟着进新页面（见 caret.ts 的注释）。
    const container = roots.length > 0 ? root.getFirstChild() : null
    if ($isBlockNode(container)) $selectBlockStart(container)
    // T20: a full reload replaces the document, so it must never become an
    // undoable history entry (domain transactions own large-op undo).
  }, { tag: [HISTORIC_TAG, 'moqi-load'], discrete: true })
  // 整篇重建之后，Lexical 历史里那些指向旧节点的条目必须清掉：否则 ⌘Z 会把重建前的
  // 整篇文档恢复回来，再被同步写回领域——两套历史就串了（docs/04 §5）。
  // 重建后的文档由领域事务负责撤销（见 ui/undoRouting.ts）。
  editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined)
}

/**
 * 根级内容收编：编辑器一次只承载一个页面子树，根上只允许放**页面容器**。
 *
 * 但 Lexical 允许根上出现普通段落（打开页面时 selection 在根上并直接输入、点在容器内边距、
 * 粘贴或拖放都可能），这些段落活在块模型之外：没有块装饰（把手/折叠/复选框），
 * 刷新之后也不属于任何页面。所以每次更新后把根上除容器以外的内容**原地移动**进容器末尾，
 * 变成真正的 Block——移动而非复制，行内格式与引用一并保留。
 *
 * 调用方负责把返回的 identity 写进领域层（与 Enter 建块同一条通路），
 * 因此这里不自己生成 id，也不自己写存储。
 */
export function $adoptRootContent(container: BlockNode, makeBlock: () => { entityId: string; blockUid: string }): { entityId: string; blockUid: string; node: BlockNode }[] {
  const root = $getRoot()
  const adopted: { entityId: string; blockUid: string; node: BlockNode }[] = []
  for (const stray of root.getChildren()) {
    if (stray === container) continue
    if ($isBlockNode(stray)) {
      // 根上出现了别的 Block（历史数据或外部写入留下）：身份不变，只搬进容器。
      container.append(stray)
      adopted.push({ entityId: stray.getEntityId(), blockUid: stray.getBlockUid(), node: stray })
      continue
    }
    const ids = makeBlock()
    const block = new BlockNode(ids.entityId, ids.blockUid, 'text')
    if ($isElementNode(stray)) for (const child of stray.getChildren()) block.append(child)
    stray.remove()
    container.append(block)
    adopted.push({ ...ids, node: block })
  }
  return adopted
}

export function editorStateFromBlocks(editor: LexicalEditor, blocks: BlockMap): EditorState {
  loadBlocksIntoEditor(editor, blocks)
  return editor.getEditorState()
}

function blockToNode(block: Block, blocks: BlockMap): BlockNode {
  const node = $createBlockNode(block)
  // **代码块**的正文把 `\n` 拆成 `LineBreakNode`（渲染 `<br>`）：只有这样，结尾换行才看得见、
  // 光标才走得过去（Chromium 对 contenteditable 里结尾的 `\n` 做悬挂处理）；适配器读回时再
  // 序列化回 `\n`——数据形态不变（`R04-ENTER-6`，2026-10-10 裁决机制 A）。
  const withBreaks = block.type === 'code'
  for (const fragment of block.content) {
    if (withBreaks && fragment.t === 'text') {
      for (const child of inlineTextNodes(fragment.v, true)) {
        if ($isTextNode(child)) applyMarks(child, fragment.marks)
        node.append(child)
      }
      continue
    }
    node.append(fragmentToNode(fragment))
  }
  // 名字行锚点（docs/04 §3.1 R04-NAME-11）：页面容器空着的时候也要有**真实存在**的名字行，
  // 否则 Lexical 的归一化会把指向它的光标压进第一个子块（见 blockNode.ts 的注释）。
  // 在子块挂上来之前就先补好，锚点自然排在最前。
  $ensureNameLineAnchor(node)
  // 行盒持有者（台账 `D-072`）：空名字行要有可编辑行盒，Android WebView 才画得出光标。
  $ensureNameLineHolder(node)
  for (const childId of block.children) {
    const child = blocks.get(childId)
    if (child && !child.deleted && child.parent === block.entityId) node.append(blockToNode(child, blocks))
  }
  return node
}

/**
 * 块正文 → 行内节点：`withBreaks` 为真（代码块）且文本含 `\n` 时，把换行拆成 `LineBreakNode`；
 * 其余一律一个文本节点（今天的常态）。空文本给空数组（不产生空文本节点——`textNodeToFragment`
 * 那边也会把空片段丢掉，两边口径一致）。
 */
export function inlineTextNodes(text: string, withBreaks: boolean): (TextNode | ReturnType<typeof $createLineBreakNode>)[] {
  if (text.length === 0) return []
  if (!withBreaks || !text.includes('\n')) return [$createTextNode(text)]
  const nodes: (TextNode | ReturnType<typeof $createLineBreakNode>)[] = []
  const segments = text.split('\n')
  segments.forEach((segment, index) => {
    if (segment.length > 0) nodes.push($createTextNode(segment))
    if (index < segments.length - 1) nodes.push($createLineBreakNode())
  })
  return nodes
}

function fragmentToNode(fragment: ContentFragment): TextNode {
  // 行内 `#标签` 已裁决不做，`mention` 属于历史数据：按纯文本加载，不丢字也不做任何标记。
  const node = fragment.t === 'text' || fragment.t === 'mention'
    ? $createTextNode(fragment.v)
    : $createInlineFragmentNode(fragment)
  applyMarks(node, fragment.marks)
  return node
}

/** Converts the current Lexical tree back into Block JSON while retaining non-editor fields. */
export function blocksFromEditorState(state: EditorState, baseBlocks: BlockMap): BlockMap {
  const output = new Map([...baseBlocks].map(([id, block]) => [id, cloneBlock(block)]))
  state.read(() => {
    const root = $getRoot()
    for (const child of root.getChildren()) {
      if ($isBlockNode(child)) readBlockNode(child, null, output)
    }
  })
  return output
}

/**
 * 编辑器当前**真正承载**的块 id（对照 `blocksFromEditorState`：那个函数会把 base 里没进编辑器的块原样带回来，
 * 所以只能用它算「有什么」，算不出「少了什么」）。
 * 用途：同步时找出编辑器里已经被删掉的块，把它们镜像成领域删除——否则块在数据里活着、界面上不存在。
 */
export function editorBlockIds(state: EditorState): Set<string> {
  const ids = new Set<string>()
  const visit = (node: LexicalNode): void => {
    if ($isBlockNode(node)) ids.add(node.getEntityId())
    if ('getChildren' in node && typeof node.getChildren === 'function') {
      for (const child of (node as { getChildren: () => LexicalNode[] }).getChildren()) visit(child)
    }
  }
  state.read(() => {
    for (const child of $getRoot().getChildren()) visit(child)
  })
  return ids
}

function readBlockNode(node: BlockNode, parentId: string | null, output: BlockMap): void {
  const existing = output.get(node.getEntityId())
  const block: Block = existing ?? materializeBlock(node, parentId, output.size)
  if (!existing) output.set(block.entityId, block)
  const content: ContentFragment[] = []
  const children: string[] = []
  for (const child of node.getChildren()) {
    if ($isBlockNode(child)) {
      children.push(child.getEntityId())
        readBlockNode(child, node.getEntityId(), output)
    } else if ($isLineBreakNode(child)) {
      // 名字行的**行盒持有者**（台账 `D-072`）：页面容器里不该有换行内容（名字是单行），
      // 这个 br 只是「空名字行要有一行」的绘制支撑——序列化时丢掉（留下的话 objectName 会多出 `\n`）。
      if (node.isPageObject()) continue
      // 代码块的换行（`R04-ENTER-6` 往返的另一半）：序列化成 `\n`，并进**相邻文本片段**——
      // 与直接写 `\n` 的正文落成同一形态，不然「重载一次」就会让 content 的片段切分变样。
      const last = content[content.length - 1]
      if (last && last.t === 'text') last.v += '\n'
      else content.push({ t: 'text', v: '\n' })
    } else if ($isTextNode(child) || $isInlineFragmentNode(child)) {
      const fragment = textNodeToFragment(child)
      if (fragment) {
        const last = content[content.length - 1]
        // 相邻且 marks 相同的两个文本片段合并（LineBreakNode 夹在中间时会被切成两段）。
        if (fragment.t === 'text' && last && last.t === 'text'
          && JSON.stringify(last.marks ?? []) === JSON.stringify(fragment.marks ?? [])) {
          last.v += fragment.v
        } else {
          content.push(fragment)
        }
      }
    }
  }
  block.parent = parentId
  block.children = children
  block.content = content
  block.type = node.getBlockType()
  block.collapsed = node.isCollapsed()
  block.checked = node.isChecked()
}

/**
 * 编辑器里有、领域里没有 → **按编辑器现状补建**，不再抛异常（2026-09-28 修）。
 *
 * 这条差异是真实存在的：编辑器里删掉一块（Backspace 合并）会被镜像成领域删除，而用户随后按 ⌘Z
 * 时 Lexical 会把块**带回编辑器**、领域那边却没有撤销记录——两边就此分家。以前这里直接抛
 * `Lexical BlockNode 找不到对应 Block`，**恰好把唯一能收敛差异的同步路径也堵死了**：之后每次
 * 结构性操作（Enter / Tab / 转类型）都在同一个地方抛异常，表现成「回车没反应、什么都动不了」。
 * 现在改成补建：同步的 insert 分支会把缺的块写进领域（把误删的块恢复成活跃），差异自愈。
 */
function materializeBlock(node: BlockNode, parentId: string | null, position: number): Block {
  return {
    entityId: node.getEntityId(),
    blockUid: node.getBlockUid(),
    type: node.getBlockType(),
    content: [],
    parent: parentId,
    children: [],
    position,
    collapsed: node.isCollapsed(),
    checked: node.isChecked(),
    deleted: false,
    deletedAt: null,
    prevParent: null,
    prevIndex: null,
    isObject: node.isPageObject(),
    objectName: null,
    // V2b: `pinned` / `starred` are domain-only page fields — the Lexical node does not
    // carry them (the adapter mirrors editor state *into* the domain, not the reverse).
    // This path already rebuilds a lossy block (`content: []`), so a re-materialized page
    // comes back unpinned/unstarred; the user re-pins. Carrying them on the node would
    // duplicate domain state into the editor for a self-heal path that rarely fires.
    pinned: false,
    starred: false,
    properties: [],
    // 属性面板的本页两档同样只住领域（与 pinned / starred / asset 同理）：补建路径重置为空。
    propertyShown: [],
    propertyHidden: [],
    tags: [],
    // 媒体 payload 也不在 Lexical 节点上（与 pinned / starred 同理）：补建路径会丢它，界面从领域读。
    asset: null,
    blockRefs: [],
    blockBackRefs: [],
    objectRefs: [],
    objectBackRefs: [],
    aiMeta: node.getAiMeta(),
    created: Date.now(),
    modified: Date.now(),
  }
}

function textNodeToFragment(node: TextNode): ContentFragment | null {
  // 名字行锚点是编辑器的**落脚点**，不是内容：空文本片段一律不落进领域数据
  // （否则每个空名字的页面都会存下 `[{t:'text',v:''}]` 这种噪声，见 R04-NAME-11）。
  if ($isTextNode(node) && !$isInlineFragmentNode(node) && node.getTextContentSize() === 0) return null
  const marks = marksFromTextNode(node)
  const fragment: ContentFragment = {
    t: $isInlineFragmentNode(node) ? node.getFragmentType() : 'text',
    v: node.getTextContent(),
  }
  if (marks.length > 0) fragment.marks = marks
  if ($isInlineFragmentNode(node)) {
    const ref = node.getRef()
    if (ref) fragment.ref = ref
    const url = node.getUrl()
    if (url) fragment.url = url
  }
  return fragment
}

export function blocksFromEditor(editor: LexicalEditor, baseBlocks: BlockMap): BlockMap {
  return blocksFromEditorState(editor.getEditorState(), baseBlocks)
}

export function findBlockNodeByEntityId(editor: LexicalEditor, entityId: string): BlockNode | null {
  let found: BlockNode | null = null
  editor.getEditorState().read(() => {
    const visit = (node: LexicalNode): void => {
      if ($isBlockNode(node) && node.getEntityId() === entityId) { found = node; return }
      if ($isElementNode(node)) for (const child of node.getChildren()) visit(child)
    }
    visit($getRoot())
  })
  return found
}
