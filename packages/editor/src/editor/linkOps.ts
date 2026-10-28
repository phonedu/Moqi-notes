/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { $createRangeSelection, $createTextNode, $setSelection, HISTORIC_TAG } from 'lexical'
import type { LexicalEditor, LexicalNode } from './editorTypes'
import type { Block } from '../domain/block'
import type { EditorStoreHandle } from './storeHandle'
import { $createInlineFragmentNode, $isBlockNode, $findBlockNode, applyMarks } from './blockNode'
import { collapsedAncestors } from '../domain/treeOps'

/** 外部链接写入后的编辑器重建：光标停在刚写入的链接之后。 */
export function applyExternalLinkInEditor(editor: LexicalEditor, block: Block, url: string) {
  editor.update(() => {
    const node = $findBlockNode(block.entityId)
    if (!node) return
    for (const child of node.getChildren()) if (!$isBlockNode(child)) child.remove()
    let caret: LexicalNode | null = null
    for (const fragment of block.content) {
      const textNode = fragment.t === 'text' ? $createTextNode(fragment.v) : $createInlineFragmentNode(fragment)
      applyMarks(textNode, fragment.marks)
      node.append(textNode)
      if (fragment.t === 'link' && fragment.url === url) caret = textNode
    }
    if (caret) {
      const size = caret.getTextContentSize()
      const selection = $createRangeSelection()
      selection.anchor.set(caret.getKey(), size, 'text')
      selection.focus.set(caret.getKey(), size, 'text')
      $setSelection(selection)
    }
  }, { tag: [HISTORIC_TAG, 'moqi-link'], discrete: true })
}

/** 行内引用写入后的编辑器重建：光标停在刚插入的 `inline-ref` 之后。 */
export function insertReferenceInEditor(editor: LexicalEditor, block: Block) {
  editor.update(() => {
    const node = $findBlockNode(block.entityId)
    if (!node) return
    for (const child of node.getChildren()) if (!$isBlockNode(child)) child.remove()
    let caretNode: LexicalNode | null = null
    for (const fragment of block.content) {
      const textNode = fragment.t === 'text' ? $createTextNode(fragment.v) : $createInlineFragmentNode(fragment)
      applyMarks(textNode, fragment.marks)
      node.append(textNode)
      if (fragment.t === 'inline-ref') caretNode = textNode
    }
    if (caretNode) {
      const size = caretNode.getTextContentSize()
      const selection = $createRangeSelection()
      selection.anchor.set(caretNode.getKey(), size, 'text')
      selection.focus.set(caretNode.getKey(), size, 'text')
      $setSelection(selection)
    } else {
      node.selectEnd()
    }
  }, { tag: [HISTORIC_TAG, 'moqi-ref'], discrete: true })
}

export function focusBlockInEditor(editor: LexicalEditor, blockId: string, store: EditorStoreHandle, persist: (ids: Iterable<string>) => void) {
  const ancestors = collapsedAncestors(store.read(), blockId)
  if (ancestors.length > 0) {
    store.apply({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      source: 'user',
      operations: ancestors.map((id) => ({ type: 'collapse', opId: crypto.randomUUID(), blockId: id, collapsed: false })),
    })
    editor.update(() => {
      for (const id of ancestors) {
        const node = $findBlockNode(id)
        if (node) node.setCollapsed(false)
      }
    }, { tag: [HISTORIC_TAG, 'moqi-jump'], discrete: true })
    persist(ancestors)
  }
  let key: string | null = null
  editor.update(() => {
    const node = $findBlockNode(blockId)
    if (!node) return
    node.selectStart()
    key = node.getKey()
  }, { tag: [HISTORIC_TAG, 'moqi-jump'], discrete: true })
  if (!key) return
  const element = editor.getElementByKey(key)
  element?.scrollIntoView({ block: 'center' })
  element?.classList.add('is-flash')
  setTimeout(() => element?.classList.remove('is-flash'), 1700)
}
