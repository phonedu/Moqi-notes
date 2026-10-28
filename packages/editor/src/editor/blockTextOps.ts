/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * 块级**键盘写入**的编排（2026-10-10 从外壳搬出——`06` §6「外壳新代码免入」；**住 `editor/` 是因为它直接碰内核**：
 * `ui/` 不许直接 import `lexical`（`tests/logic/import-boundaries.test.ts` ③ 的冻结名单只许变短），
 * 而「内核可替换」的方向是 `ui → editor → domain`；store 只按结构化端口取）。
 *
 * 两件事：**代码块内的回车**（`R04-ENTER-6`，机制 A：换行落 `LineBreakNode`、适配器往返成 `\n`；
 * 空行再按 = 退出代码块）与**列表项行首 Backspace 的退出口**（`R04-ENTER-4` 的另一半）。
 * 判据仍在输入规则层（`editor/inputRules.ts` 的 `decideCodeEnter` / `decideLeaveListOnBackspace`）；
 * 本模块不认识 React，依赖按 `deps` 注入（store / persist / 几个既有通路），外壳只做转发。
 */
import { $getNodeByKey, $getSelection, $isRangeSelection, HISTORIC_TAG, type LexicalEditor, type LexicalNode } from 'lexical'
import { $createBlockNode, $findBlockNode, $isBlockNode } from '../editor/blockNode'
import { $contentOffset, currentBlockId } from '../editor/caret'
import { inlineTextNodes } from '../editor/blockLexicalAdapter'
import { decideCodeEnter, decideLeaveListOnBackspace } from '../editor/inputRules'
import { createTextBlock, isListType, orderedRootIds, textContent, type Block, type BlockMap, type BlockType } from '../domain/block'
import type { Transaction } from '../domain/operation'

/** 外壳要递的 store 面（**结构化端口**：不 import `application/`，`DomainStore` 天然满足）。 */
export type BlockTextOpsStore = {
  get(id: string): Block | undefined
  read(): BlockMap
  apply(transaction: Omit<Transaction, 'inverse'>): void
}

export type BlockTextOpsDeps = {
  store: BlockTextOpsStore
  persist: (changedIds: Iterable<string>) => void
  convertCurrentBlock: (editor: LexicalEditor, blockId: string, type: BlockType) => void
  flushPendingEnter: (editor: LexicalEditor, targetId: string) => boolean
  syncEditorChanges: (editor: LexicalEditor) => void
}

/**
 * 代码块里的回车（`R04-ENTER-6`，W6 2026-10-10 裁决；机制 A）：**Enter = 换行**——插
 * `LineBreakNode`（渲染 `<br>`，光标/点击/打字都是浏览器标准行为），适配器序列化成 `\n` 落库；
 * **空行上再按 = 退出代码块**（空块转 text；非空块收掉尾随换行后新建 text 块）。
 * 光标不在块级代码块里 → 返回 false（交给外壳走既有链路）。
 */
export function handleCodeBlockEnter(editor: LexicalEditor, deps: BlockTextOpsDeps): boolean {
  const caretId = currentBlockId(editor)
  const caret = caretId ? deps.store.get(caretId) : null
  if (!caret || caret.type !== 'code') return false
  // 正文从**编辑器状态**读（不是领域）：刚敲的字还没进领域，判「尾空行」要用最新的。
  let text = ''
  let offset = 0
  editor.getEditorState().read(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection) || selection.anchor.key === 'root') return
    let node: LexicalNode | null = $getNodeByKey(selection.anchor.key)
    while (node && !$isBlockNode(node)) node = node.getParent()
    if ($isBlockNode(node) && node.getEntityId() === caret.entityId) {
      text = node.getTextContent()
      offset = $contentOffset(node, selection.anchor.key, selection.anchor.offset)
    }
  })
  const action = decideCodeEnter({ isEmptyBlock: text.length === 0, atEmptyLine: text.endsWith('\n') && offset >= text.length })
  if (action === 'newline') {
    // **不带 `HISTORIC_TAG`**：这是一次用户编辑，按全应用的分工（`04` §5）编辑器侧改动归
    // Lexical 的撤销历史（镜像只落领域、不占撤销栈）——带上 HISTORIC 会两边都不进撤销。
    editor.update(() => {
      const selection = $getSelection()
      if ($isRangeSelection(selection)) selection.insertLineBreak()
    }, { discrete: true })
    return true
  }
  if (text.length === 0) deps.convertCurrentBlock(editor, caret.entityId, 'text')
  else exitCodeBlock(editor, caret, text.replace(/\n+$/, ''), deps)
  return true
}

/**
 * 代码块的空行 Enter（`R04-ENTER-6`）：收掉尾随换行 ＋ 在其后新建 `text` 块，**一步事务**
 * （一次撤销把「本块内容」与「新增块」一起退回），光标落在新块开头。`stripped` 只收尾部，
 * 中间的换行原样保留。
 */
function exitCodeBlock(editor: LexicalEditor, block: Block, stripped: string, deps: BlockTextOpsDeps): void {
  if (!deps.flushPendingEnter(editor, block.entityId)) return
  // 先把编辑器状态镜像进领域再取 `previous`：刚敲的那次换行还在镜像途中，直接读领域会慢一拍
  // ——撤销时会还原成「换行之前」的内容（探针实测：尾换行没回来）。
  deps.syncEditorChanges(editor)
  const fresh = deps.store.get(block.entityId)
  const parentId = block.parent
  const index = parentId === null
    ? orderedRootIds(deps.store.read()).indexOf(block.entityId) + 1
    : (deps.store.get(parentId)?.children.indexOf(block.entityId) ?? -1) + 1
  const nextBlock = createTextBlock({
    entityId: crypto.randomUUID(),
    blockUid: `b${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`,
    parent: parentId,
  })
  deps.store.apply({
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    source: 'user',
    operations: [
      { type: 'update', opId: crypto.randomUUID(), blockId: block.entityId, changes: { content: stripped.length > 0 ? [{ t: 'text', v: stripped }] : [] }, previous: { content: fresh?.content ?? block.content } },
      { type: 'insert', opId: crypto.randomUUID(), block: nextBlock, parentId, index },
    ],
  })
  deps.persist([block.entityId, nextBlock.entityId])
  editor.update(() => {
    const node = $findBlockNode(block.entityId)
    if (!node) return
    for (const child of node.getChildren()) if (!$isBlockNode(child)) child.remove()
    for (const child of inlineTextNodes(stripped, true)) node.append(child)
    const nextNode = $createBlockNode(nextBlock)
    node.insertAfter(nextNode)
    nextNode.selectStart()
  }, { tag: [HISTORIC_TAG, 'moqi-code'], discrete: true })
}

/**
 * 列表的降级出口（`R04-ENTER-4` 的另一半，用户实测 2026-09-30）：光标在**有内容的列表项行首**
 * 按 Backspace → 本项退出列表（变回普通文本块），内容与光标都不动；**再按一次**才轮到原来的
 * 合并 / 跨行逻辑。空项不在这里处理（让给既有的「空块合并」通路，语义更自然）。
 */
export function leaveListOnBackspace(editor: LexicalEditor, event: KeyboardEvent, deps: BlockTextOpsDeps): boolean {
  if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false
  let target: { id: string; leaveList: boolean } | null = null
  editor.getEditorState().read(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection) || !selection.isCollapsed() || selection.anchor.key === 'root') return
    let node: LexicalNode | null = $getNodeByKey(selection.anchor.key)
    while (node && !$isBlockNode(node)) node = node.getParent()
    if (!$isBlockNode(node)) return
    const block = deps.store.get(node.getEntityId())
    if (!block) return
    target = {
      id: block.entityId,
      leaveList: decideLeaveListOnBackspace({
        isList: isListType(block.type),
        hasText: textContent(block).trim().length > 0,
        atStart: $contentOffset(node, selection.anchor.key, selection.anchor.offset) === 0,
      }),
    }
  })
  const pending = target as { id: string; leaveList: boolean } | null
  if (!pending || !pending.leaveList) return false
  event.preventDefault()
  deps.convertCurrentBlock(editor, pending.id, 'text')
  return true
}
