import { useEffect, useRef, useState } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $getNodeByKey, $getSelection, $isRangeSelection, COMMAND_PRIORITY_CRITICAL,
  KEY_ARROW_DOWN_COMMAND, KEY_ARROW_UP_COMMAND, KEY_ENTER_COMMAND, KEY_ESCAPE_COMMAND,
} from 'lexical'
import type { LexicalEditor, LexicalNode } from './editorTypes'
import type { RefKind } from '../domain/block'
import type { RefCandidate, RefTrigger } from '../domain/refOps'
import type { Suggestion } from '../domain/suggest'
import { $isBlockNode, type BlockNode } from './blockNode'
import { menuRows, type MenuRow, type RefMenuState } from './refMenu'

/**
 * `[[` / `((` 候选菜单的编辑器侧（模块化 M2）：触发识别、键盘选择、Esc 抑制与建议数据。
 * UI 只按返回的状态画菜单。
 */
export function useReferenceMenu({
  enabled, findTargets, suggestFor, convertIntent, clearConvertIntent, onInsert,
}: {
  enabled: boolean
  convertIntent?: (blockId: string) => boolean
  clearConvertIntent?: () => void
  findTargets: (kind: RefKind, query: string, fromId: string) => RefCandidate[]
  suggestFor: (kind: RefKind, query: string, fromId: string) => Suggestion[]
  onInsert: (editor: LexicalEditor, state: RefMenuState, row: MenuRow) => void
}) {
  const [editor] = useLexicalComposerContext()
  const [state, setState] = useState<RefMenuState | null>(null)
  const [index, setIndex] = useState(0)
  const stateRef = useRef<RefMenuState | null>(null)
  const indexRef = useRef(index)
  const findTargetsRef = useRef(findTargets)
  const suggestForRef = useRef(suggestFor)
  const onInsertRef = useRef(onInsert)
  const signatureRef = useRef('')
  const dismissedRef = useRef<string | null>(null)
  const convertIntentRef = useRef(convertIntent)
  const clearConvertIntentRef = useRef(clearConvertIntent)

  useEffect(() => { stateRef.current = state }, [state])
  useEffect(() => { indexRef.current = index }, [index])
  useEffect(() => { findTargetsRef.current = findTargets }, [findTargets])
  useEffect(() => { suggestForRef.current = suggestFor }, [suggestFor])
  useEffect(() => { onInsertRef.current = onInsert }, [onInsert])
  useEffect(() => { convertIntentRef.current = convertIntent }, [convertIntent])
  useEffect(() => { clearConvertIntentRef.current = clearConvertIntent }, [clearConvertIntent])

  useEffect(() => {
    if (!enabled) return
    return editor.registerUpdateListener(({ editorState }) => {
      const found: { pending: RefMenuState | null } = { pending: null }
      editorState.read(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return
        const node = blockForSelection(selection.anchor.key)
        if (!node) return
        const prefix = inlineTextBefore(node, selection.anchor.key, selection.anchor.offset)
        if (prefix === null) return
        const match = /(\[\[|\(\()([^[\]()\n]*)$/.exec(prefix)
        if (!match) return
        const trigger = match[1] as RefTrigger
        const typed = match[2]
        const converting = convertIntentRef.current ? convertIntentRef.current(node.getEntityId()) : false
        const query = converting ? '' : typed
        const kind: RefKind = trigger === '[[' ? 'object' : 'block'
        if (!editor.getElementByKey(node.getKey())) return
        found.pending = {
          blockId: node.getEntityId(),
          offset: prefix.length - (trigger.length + typed.length),
          displayText: converting ? typed : null,
          typed,
          kind,
          trigger,
          query,
          results: findTargetsRef.current(kind, query, node.getEntityId()),
          suggestions: kind === 'object' ? suggestForRef.current(kind, query, node.getEntityId()) : [],
        }
      })
      const pending = found.pending
      if (!pending) {
        clearConvertIntentRef.current?.()
        signatureRef.current = ''
        dismissedRef.current = null
        setState(null)
        return
      }
      const signature = `${pending.blockId}:${pending.kind}:${pending.query}`
      if (dismissedRef.current === signature) {
        setState(null)
        return
      }
      if (signatureRef.current !== signature) {
        signatureRef.current = signature
        setIndex(0)
      }
      setState(pending)
    })
  }, [editor, enabled])

  useEffect(() => {
    if (!enabled) return
    const choose = (event: KeyboardEvent | null): boolean => {
      if (event?.isComposing || editor.isComposing()) return false
      const current = stateRef.current
      if (!current) return false
      const candidate = menuRows(current)[indexRef.current]
      if (!candidate) { clearConvertIntentRef.current?.(); setState(null); return false }
      onInsertRef.current(editor, current, candidate)
      clearConvertIntentRef.current?.()
      setState(null)
      return true
    }
    const unregister = [
      editor.registerCommand(KEY_ENTER_COMMAND, choose, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_ESCAPE_COMMAND, (event: KeyboardEvent) => {
        if (event.isComposing || editor.isComposing()) return false
        const current = stateRef.current
        if (!current) return false
        dismissedRef.current = `${current.blockId}:${current.kind}:${current.query}`
        setState(null)
        return true
      }, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_ARROW_DOWN_COMMAND, (event: KeyboardEvent) => {
        if (event.isComposing || editor.isComposing()) return false
        const current = stateRef.current
        if (!current || menuRows(current).length === 0) return false
        event.preventDefault()
        setIndex((value) => (value + 1) % menuRows(current).length)
        return true
      }, COMMAND_PRIORITY_CRITICAL),
      editor.registerCommand(KEY_ARROW_UP_COMMAND, (event: KeyboardEvent) => {
        if (event.isComposing || editor.isComposing()) return false
        const current = stateRef.current
        if (!current || menuRows(current).length === 0) return false
        event.preventDefault()
        setIndex((value) => (value - 1 + menuRows(current).length) % menuRows(current).length)
        return true
      }, COMMAND_PRIORITY_CRITICAL),
    ]
    return () => { for (const unregisterCommand of unregister) unregisterCommand() }
  }, [editor, enabled])

  return {
    editor, state, index, setIndex,
    choose: (rowIndex: number) => {
      const current = stateRef.current
      if (!current) return
      const row = menuRows(current)[rowIndex]
      if (!row) return
      onInsertRef.current(editor, current, row)
      clearConvertIntentRef.current?.()
      setState(null)
    },
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
