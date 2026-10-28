/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useRef, useState } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $getNodeByKey, $getSelection, $isRangeSelection, COMMAND_PRIORITY_CRITICAL,
  KEY_ARROW_DOWN_COMMAND, KEY_ARROW_UP_COMMAND, KEY_ENTER_COMMAND, KEY_ESCAPE_COMMAND,
} from 'lexical'
import type { LexicalEditor, LexicalNode } from './editorTypes'
import { $isBlockNode, type BlockNode } from './blockNode'

export type SlashMenuState = { blockId: string; query: string }

/**
 * 斜杠菜单的编辑器侧（模块化 M2）：触发识别、键盘选择、Esc 后的块内抑制。
 * UI 只按返回的 `state` / `index` 画菜单，不再直接碰 Lexical。
 */
export function useSlashMenu({
  enabled, count, onChoose,
}: {
  enabled: boolean
  count: (query: string) => number
  onChoose: (editor: LexicalEditor, blockId: string, index: number, query: string) => void
}) {
  const [editor] = useLexicalComposerContext()
  const [state, setState] = useState<SlashMenuState | null>(null)
  const [index, setIndex] = useState(0)
  const stateRef = useRef<SlashMenuState | null>(null)
  const indexRef = useRef(index)
  const onChooseRef = useRef(onChoose)
  const countRef = useRef(count)
  const dismissedRef = useRef<string | null>(null)

  useEffect(() => { stateRef.current = state }, [state])
  useEffect(() => { indexRef.current = index }, [index])
  useEffect(() => { onChooseRef.current = onChoose }, [onChoose])
  useEffect(() => { countRef.current = count }, [count])

  useEffect(() => {
    if (!enabled) return
    return editor.registerUpdateListener(({ editorState }) => {
      const found: { pending: SlashMenuState | null } = { pending: null }
      editorState.read(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return
        const node = blockForSelection(selection.anchor.key)
        if (!node) return
        const prefix = inlineTextBefore(node, selection.anchor.key, selection.anchor.offset)
        if (prefix === null) return
        const match = /(?:^|\s)\/([^\s/]*)$/.exec(prefix)
        if (!match) return
        if (!editor.getElementByKey(node.getKey())) return
        found.pending = { blockId: node.getEntityId(), query: match[1] }
      })
      const pending = found.pending
      if (!pending) {
        setState(null)
        return
      }
      if (dismissedRef.current === pending.blockId) {
        setState(null)
        return
      }
      if (stateRef.current?.blockId !== pending.blockId || stateRef.current?.query !== pending.query) setIndex(0)
      setState(pending)
    })
  }, [editor, enabled])

  useEffect(() => {
    if (!enabled) return
    const choose = (event: KeyboardEvent | null): boolean => {
      if (event?.isComposing || editor.isComposing()) return false
      const current = stateRef.current
      if (!current) return false
      const total = countRef.current(current.query)
      if (total === 0) { setState(null); return false }
      onChooseRef.current(editor, current.blockId, indexRef.current, current.query)
      setState(null)
      return true
    }
    const unregister = [
      editor.registerCommand(KEY_ENTER_COMMAND, choose, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_ESCAPE_COMMAND, (event: KeyboardEvent) => {
        if (event.isComposing || editor.isComposing()) return false
        const current = stateRef.current
        if (!current) return false
        dismissedRef.current = current.blockId
        setState(null)
        return true
      }, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_ARROW_DOWN_COMMAND, (event: KeyboardEvent) => {
        if (event.isComposing || editor.isComposing()) return false
        if (!stateRef.current) return false
        event.preventDefault()
        const current = stateRef.current
        if (!current) return false
        setIndex((value) => (value + 1) % Math.max(1, countRef.current(current.query)))
        return true
      }, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_ARROW_UP_COMMAND, (event: KeyboardEvent) => {
        if (event.isComposing || editor.isComposing()) return false
        if (!stateRef.current) return false
        event.preventDefault()
        const current = stateRef.current
        if (!current) return false
        const total = Math.max(1, countRef.current(current.query))
        setIndex((value) => (value - 1 + total) % total)
        return true
      }, COMMAND_PRIORITY_CRITICAL),
    ]
    return () => { for (const unregisterCommand of unregister) unregisterCommand() }
  }, [editor, enabled])

  return {
    editor, state, index, setIndex,
    choose: (flatIndex: number) => {
      const current = stateRef.current
      if (!current) return
      onChooseRef.current(editor, current.blockId, flatIndex, current.query)
      setState(null)
    },
    close: () => setState(null),
  }
}

function blockForSelection(anchorKey: string): BlockNode | null {
  if (anchorKey === 'root') return null
  let node: LexicalNode | null = $getNodeByKey(anchorKey)
  while (node && !$isBlockNode(node)) node = node.getParent()
  return $isBlockNode(node) ? node : null
}

function inlineTextBefore(blockNode: BlockNode, anchorKey: string, anchorOffset: number): string | null {
  const children = blockNode.getChildren()
  let prefix = ''
  let reached = false
  for (const child of children) {
    if ($isBlockNode(child)) continue
    if (!reached) {
      if (child.getKey() === anchorKey) {
        prefix += child.getTextContent().slice(0, anchorOffset)
        reached = true
      } else {
        prefix += child.getTextContent()
      }
    }
  }
  if (!reached) return null
  return prefix
}
