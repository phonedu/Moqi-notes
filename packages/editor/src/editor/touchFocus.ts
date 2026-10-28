/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { $findBlockNode } from './blockNode'
import { $selectBlockEnd } from './caret'
import { selectNameRow } from './nameLine'

/**
 * 触控双击进编辑的**光标落位**（`10` §6.3 第一件）：容器 = 名字行，其余 = 内容末尾，并滚进可视区。
 * 住 `editor/` 的理由：`ui/useTouchEdit` 不直连内核（边界门 ③）——`focusBlockEnd` 的入参收成
 * **结构型句柄**（只用到 focus / update 两个口），`ui/` 侧的窄引用直接可传。
 */

/** `focusBlockEnd` 用得到的那几个口（真实 `LexicalEditor` 结构上超集，直接可传）。 */
export type TouchFocusTarget = {
  focus: () => void
  update: (updateFn: () => void) => void
}

export function focusBlockEnd(editor: TouchFocusTarget, blockId: string): void {
  requestAnimationFrame(() => {
    editor.focus()
    editor.update(() => {
      const node = $findBlockNode(blockId)
      if (node) $selectBlockEnd(node)
    })
    document.querySelector<HTMLElement>(`.moqi-block[data-entity-id="${blockId}"]`)?.scrollIntoView({ block: 'nearest' })
    ensureCaretVisible()
  })
}

/**
 * `#8` **焦点不被遮挡（硬保证）**（`10` 二册 §6.3，）：按**光标矩形**把「正在写的那一行」
 * 顶进键盘上方的可视区。
 *
 * 为什么不用 `block:'nearest'` 就够：它只保证**块**的边缘可见——**块比可视区还高**（长文块 / 大代码块）
 * 时，块尾可见而光标仍埋在键盘下。这里改量光标矩形，滚动**唯一滚动容器 `.doc-col`**。
 *
 * 键盘高度读**运行时变量 `--kb-h`**（与 CSS 同一读数源）；宿主 resize 生效时它是 0、不 resize 时是真实高度，
 * 两种宿主档同一套代码。
 */
export function ensureCaretVisible(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return
  const caret = selection.getRangeAt(0).getBoundingClientRect()
  if (caret.width === 0 && caret.height === 0) return
  const scroller = document.querySelector<HTMLElement>('.doc-col')
  if (!scroller) return
  const kb = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--kb-h')) || 0
  const margin = 12
  const bottomLimit = window.innerHeight - kb - margin
  const topLimit = margin
  if (caret.bottom > bottomLimit) scroller.scrollTop += caret.bottom - bottomLimit
  else if (caret.top < topLimit) scroller.scrollTop -= Math.min(topLimit - caret.top, scroller.scrollTop)
}

/** 容器块（名字行）的落位（`04` §3.1 那套名字行语义，调用方先用 `store` 判 isObject）。
 *  与 `focusBlockEnd` 同口径：落位后把该块滚进可视区（`10` §6.3「焦点不被遮挡」）。 */
export function focusNameRow(editor: Parameters<typeof selectNameRow>[0], containerId: string): void {
  selectNameRow(editor, containerId)
  editor.focus()
  document.querySelector<HTMLElement>(`.moqi-block[data-entity-id="${containerId}"]`)?.scrollIntoView({ block: 'nearest' })
  ensureCaretVisible()
}
