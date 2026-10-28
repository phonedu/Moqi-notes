import { $getNodeByKey, $getSelection, $isRangeSelection, HISTORIC_TAG } from 'lexical'
import type { EditorState, LexicalEditor, LexicalNode } from './editorTypes'
import { deleteBlocks } from '../domain/selectionOps'
import type { Block, BlockMap } from '../domain/block'
import type { Operation } from '../domain/operation'
import type { EditorStoreHandle } from './storeHandle'
import { blocksFromEditorState, editorBlockIds, loadBlocksIntoEditor } from './blockLexicalAdapter'
import { $findBlockNode, $isBlockNode } from './blockNode'
import { $caretOffsetInBlock, $selectOffsetInBlock } from './caret'
import type { MutableRefObject } from 'react'

export type PersistenceOpsDeps = {
  store: EditorStoreHandle
  activePageId: string | null
  persist: (changedIds: Iterable<string>) => void
  pendingEnterRef: MutableRefObject<Map<string, Block>>
}

/** 编辑器基线：当前页面子树（含 Enter 新块），避免每次按键比较整库。 */
export function editorBaseOf(store: EditorStoreHandle, activePageId: string | null): BlockMap {
  if (!activePageId) return new Map()
  return store.subtree(activePageId)
}

/** 编辑器 → 领域的镜像（打字归 Lexical、结构归领域；见 docs/04 §5）。 */
export function syncEditorChanges(editor: LexicalEditor, editorState: EditorState, deps: PersistenceOpsDeps) {
  const { store, activePageId, persist, pendingEnterRef } = deps
  const base = editorBaseOf(store, activePageId)
  const pendingEnters = pendingEnterRef.current
  for (const [id, block] of pendingEnters) base.set(id, structuredClone(block))
  const next = blocksFromEditorState(editorState, base)

  // Enter 的离散更新可能还没提交，旧树不能覆盖领域。
  for (const id of pendingEnters.keys()) if (!next.has(id)) return

  const presentInEditor = editorBlockIds(editorState)
  const removed = [...base.keys()].filter((id) => !presentInEditor.has(id) && !pendingEnters.has(id))
  const deletion = removed.length > 0 ? deleteBlocks(store.snapshot(), removed) : null
  if (deletion) {
    store.applyMirror({ ...deletion.transaction, source: 'user' })
  }

  const operations: Operation[] = []
  for (const [id, nextBlock] of next) {
    const previous = store.get(id)
    if (!previous) {
      const parent = nextBlock.parent ? next.get(nextBlock.parent) : undefined
      operations.push({
        type: 'insert',
        opId: crypto.randomUUID(),
        block: nextBlock,
        parentId: nextBlock.parent,
        index: parent ? Math.max(0, parent.children.indexOf(id)) : 0,
      })
      continue
    }
    if (JSON.stringify(previous) === JSON.stringify(nextBlock)) continue
    operations.push({
      type: 'update',
      opId: crypto.randomUUID(),
      blockId: id,
      changes: {
        content: nextBlock.content,
        type: nextBlock.type,
        collapsed: nextBlock.collapsed,
        checked: nextBlock.checked,
      },
      previous: {
        content: previous.content,
        type: previous.type,
        collapsed: previous.collapsed,
        checked: previous.checked,
      },
    })
  }
  if (operations.length > 0) {
    store.applyMirror({ id: crypto.randomUUID(), operations, timestamp: Date.now(), source: 'user' })
    const changedIds = new Set<string>()
    for (const operation of operations) {
      if (operation.type === 'update') changedIds.add(operation.blockId)
      if (operation.type === 'insert') {
        changedIds.add(operation.block.entityId)
        if (operation.parentId) changedIds.add(operation.parentId)
      }
    }
    persist(changedIds)
  }
  pendingEnterRef.current.clear()
}

/** 读当前光标：所在块的 entityId + 块内字符偏移（领域重建前调用）。 */
export function readCaretAnchor(editor: LexicalEditor | null): { blockId: string; offset: number } | null {
  if (!editor) return null
  let anchor: { blockId: string; offset: number } | null = null
  editor.getEditorState().read(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection) || selection.anchor.key === 'root') return
    let node: LexicalNode | null = $getNodeByKey(selection.anchor.key)
    while (node && !$isBlockNode(node)) node = node.getParent()
    if (!$isBlockNode(node)) return
    const offset = $caretOffsetInBlock(node, selection.anchor.key, selection.anchor.offset)
    if (offset === null) return
    anchor = { blockId: node.getEntityId(), offset }
  })
  return anchor
}

/** 领域重建：保留光标所在块与块内偏移；`persistAll=false` 用于彻底删除后的重建。 */
export function reloadEditorFromStore(editor: LexicalEditor | null, pageId: string | null, deps: PersistenceOpsDeps & { undoOwnerRef: MutableRefObject<'typing' | 'domain'> }) {
  if (!editor) return
  deps.undoOwnerRef.current = 'domain'
  const keep = readCaretAnchor(editor)
  if (pageId) loadBlocksIntoEditor(editor, deps.store.subtree(pageId))
  if (keep && deps.store.get(keep.blockId)) {
    editor.update(() => {
      const target = $findBlockNode(keep.blockId)
      if (target) $selectOffsetInBlock(target, keep.offset)
    }, { tag: [HISTORIC_TAG, 'moqi-reload'], discrete: true })
  }
}
