/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useEffect, useRef, useState } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'

export type PeekTarget<T> = {
  targetId: string
  content: T
  rect: { top: number; bottom: number; left: number }
}

/** 速览卡的打开 / 关闭延迟（docs/09 §五）。 */
export const PEEK_OPEN_DELAY = 500
export const PEEK_CLOSE_DELAY = 150

/**
 * 速览卡的编辑器侧（模块化 M2）：悬停目标、计时、滚动关闭，以及别名链接的 title 同步。
 * UI 只负责把返回的 `target` 画成卡片；不再直接碰 Lexical。
 */
export function usePeekEditor<T>({
  enabled, resolve, resolveTitle,
}: {
  enabled: boolean
  resolve: (targetId: string, displayText: string) => T | null
  resolveTitle: (targetId: string, displayText: string) => string | null
}) {
  const [editor] = useLexicalComposerContext()
  const [target, setTarget] = useState<PeekTarget<T> | null>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const resolveRef = useRef(resolve)
  const resolveTitleRef = useRef(resolveTitle)

  useEffect(() => { resolveRef.current = resolve }, [resolve])
  useEffect(() => { resolveTitleRef.current = resolveTitle }, [resolveTitle])

  const clearOpen = () => { if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null } }
  const clearClose = () => { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null } }
  const hide = () => { clearOpen(); clearClose(); setTarget(null) }

  useEffect(() => {
    if (!enabled) return
    const onMouseOver = (event: MouseEvent) => {
      const element = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-ref-target]') : null
      const targetId = element?.dataset.refTarget
      if (!element || !targetId) return
      clearOpen()
      clearClose()
      const rect = element.getBoundingClientRect()
      const displayText = element.textContent ?? ''
      openTimer.current = setTimeout(() => {
        const content = resolveRef.current(targetId, displayText)
        if (content) setTarget({ targetId, content, rect: { top: rect.top, bottom: rect.bottom, left: rect.left } })
      }, PEEK_OPEN_DELAY)
    }
    const onMouseOut = (event: MouseEvent) => {
      const element = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-ref-target]') : null
      if (!element) return
      clearOpen()
      clearClose()
      closeTimer.current = setTimeout(() => setTarget(null), PEEK_CLOSE_DELAY)
    }
    const onScroll = () => hide()
    const attach = (root: HTMLElement) => {
      root.addEventListener('mouseover', onMouseOver)
      root.addEventListener('mouseout', onMouseOut)
      window.addEventListener('scroll', onScroll, true)
    }
    const detach = (root: HTMLElement) => {
      root.removeEventListener('mouseover', onMouseOver)
      root.removeEventListener('mouseout', onMouseOut)
      window.removeEventListener('scroll', onScroll, true)
    }
    return editor.registerRootListener((root, previous) => {
      if (previous) detach(previous)
      if (root) attach(root)
    })
    // 计时器与关闭路径通过 ref 共享；此 effect 只负责订阅编辑器根节点。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, enabled])

  // 别名链接的原生 title（`R09-ALIAS-3`）：每次编辑器更新后同步一次，只在字面变了才写 DOM。
  useEffect(() => {
    if (!enabled) return
    const sync = () => {
      const root = editor.getRootElement()
      if (!root) return
      for (const element of root.querySelectorAll<HTMLElement>('[data-ref-target]')) {
        const targetId = element.dataset.refTarget
        if (!targetId) continue
        const title = resolveTitleRef.current(targetId, element.textContent ?? '')
        if (title === null) { if (element.hasAttribute('title')) element.removeAttribute('title'); continue }
        if (element.title !== title) element.title = title
      }
    }
    sync()
    return editor.registerUpdateListener(sync)
  }, [editor, enabled])

  const keepOpen = () => { clearOpen(); clearClose() }
  const closeSoon = () => { clearOpen(); clearClose(); closeTimer.current = setTimeout(() => setTarget(null), PEEK_CLOSE_DELAY) }
  return { target, hide, keepOpen, closeSoon }
}
