import { $createTextNode, $getNodeByKey, $getSelection, $isRangeSelection, HISTORIC_TAG, type TextFormatType } from 'lexical'
import type { MutableRefObject } from 'react'
import type { LexicalEditor, LexicalNode } from './editorTypes'
import type { EditorStoreHandle } from './storeHandle'
import { insertRefTrigger } from '../domain/refOps'
import { $createInlineFragmentNode, $findBlockNode, $isBlockNode, applyMarks } from './blockNode'
import { $caretOffsetInBlock, $selectOffsetInBlock } from './caret'

/** 行内格式的统一入口：折叠光标作用在「接下来输入的字」，有选区作用在选区。 */
export function toggleInlineFormatInEditor(editor: LexicalEditor, format: TextFormatType) {
  editor.update(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection)) return
    selection.formatText(format)
  }, { discrete: true })
}

/**
 * `[[` 意图：领域先行，再按领域内容重建这一块；光标停在触发词 + 选中文字之后。
 * 返回 true 表示已写入（调用方据此决定是否落盘）。
 */
export function convertSelectionToLinkInEditor(
  editor: LexicalEditor,
  store: EditorStoreHandle,
  linkConvertBlockRef: MutableRefObject<string | null>,
): string | null {
  let target: { blockId: string; start: number; length: number } | null = null
  editor.getEditorState().read(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection) || selection.anchor.key === 'root') return
    let node: LexicalNode | null = $getNodeByKey(selection.anchor.key)
    while (node && !$isBlockNode(node)) node = node.getParent()
    if (!$isBlockNode(node)) return
    const anchor = $caretOffsetInBlock(node, selection.anchor.key, selection.anchor.offset)
    const focus = $caretOffsetInBlock(node, selection.focus.key, selection.focus.offset)
    if (anchor === null || focus === null) return
    target = { blockId: node.getEntityId(), start: Math.min(anchor, focus), length: Math.abs(anchor - focus) }
  })
  if (!target) return null
  const current: { blockId: string; start: number; length: number } = target
  const block = store.get(current.blockId)
  if (!block) return null
  const content = insertRefTrigger(block.content, current.start, current.length, '[[')
  if (!content) return null
  linkConvertBlockRef.current = current.length > 0 ? current.blockId : null
  store.applyMirror({
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    source: 'user',
    operations: [{ type: 'update', opId: crypto.randomUUID(), blockId: current.blockId, changes: { content }, previous: { content: block.content } }],
  })
  editor.update(() => {
    const node = $findBlockNode(current.blockId)
    if (!node) return
    for (const child of node.getChildren()) if (!$isBlockNode(child)) child.remove()
    for (const fragment of content) {
      const textNode = fragment.t === 'text' ? $createTextNode(fragment.v) : $createInlineFragmentNode(fragment)
      applyMarks(textNode, fragment.marks)
      node.append(textNode)
    }
    $selectOffsetInBlock(node, current.start + 2 + current.length)
  }, { tag: [HISTORIC_TAG, 'moqi-ref'], discrete: true })
  return current.blockId
}
