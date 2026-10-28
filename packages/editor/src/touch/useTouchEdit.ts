/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useCallback, useEffect, useState } from 'react'
import type { Block } from '../domain/block'
import { focusBlockEnd, type TouchFocusTarget } from '../editor/touchFocus'

/**
 * 触控编辑态（`10` §6.3，compact 档——**窗口宽度决定交互形态**，与 0.6 第 12 项同一口径）：
 * `null` = 只读态（编辑器整体不可编辑、单击无操作）；非 null = 打字态的焦点块。
 * 「双击进编辑（只读态）/ 点空白退」的事件接线在 `editorPlugins` 的触控效果里，这里管状态与动作；
 * **编辑态内点另一块 = 光标一步到位**（θ6，2026-10-13）；**选中入口只剩「编辑态内左滑 → 选择模式」**
 * （γ1，2026-10-12 用户裁定）——点块**不入选区**。
 */

/** 内核句柄的结构型端口（`ui/` 不直连 `lexical`——边界门 ③；真实编辑器是它的结构超集）。 */
export type TouchEditorHandle = TouchFocusTarget & {
  setEditable: (editable: boolean) => void
  getRootElement: () => HTMLElement | null
}

export function useTouchEdit({ compact, store, revision, editorRef, focusNameRow, exitSelection }: {
  compact: boolean
  /** 结构型最小面（D-104）：触控层只需要「这一块是不是页面对象」——不拖整个领域店进包。 */
  store: { get(id: string): Block | undefined }
  /** 领域修订号：块重建后重挂正文上的编辑块标记（`revision` 一带就重跑）。 */
  revision: number
  editorRef: { readonly current: TouchEditorHandle | null }
  /** 名字行落位（要真编辑器类型，由外壳用 `editor/touchFocus` 接线）——其余动作本模块自己走窄口。 */
  focusNameRow: (containerId: string) => void
  exitSelection: () => void
}) {
  const [touchEditId, setTouchEditId] = useState<string | null>(null)

  // 离开 compact 档 = 回到桌面交互形态（可编辑开关由 editorPlugins 的触控效果接管）。
  useEffect(() => { if (!compact) setTouchEditId(null) }, [compact])

  // 编辑中：底栏（FAB）与属性面暂隐（`10` §6.3；样式 `body.is-touch-editing` 在 app.css）。
  useEffect(() => {
    document.body.classList.toggle('is-touch-editing', compact && touchEditId !== null)
    return () => document.body.classList.remove('is-touch-editing')
  }, [compact, touchEditId])

  // 编辑中的那块挂 `data-touch-edit`（δ 起不再降透明：编辑态全部块正常黑，标记只给 CSS 挂竖线）；
  // `revision` 带上——块重建后重挂。
  // 住在这里而不是装饰层：BlockTools 正吃体量棘轮（只许变短），这是一段独立的 DOM 标注。
  useEffect(() => {
    for (const element of document.querySelectorAll<HTMLElement>('.moqi-block[data-entity-id]')) {
      if (touchEditId && element.dataset.entityId === touchEditId) element.dataset.touchEdit = '1'
      else delete element.dataset.touchEdit
    }
  }, [touchEditId, revision])

  /** 双击块进编辑：编辑器立即可编辑、光标落进那块（容器 = 名字行，其余 = 内容末尾）。 */
  const activateTouchBlock = useCallback((blockId: string) => {
    const editor = editorRef.current
    if (!editor) return
    editor.setEditable(true)
    setTouchEditId(blockId)
    if (store.get(blockId)?.isObject) focusNameRow(blockId)
    else focusBlockEnd(editor, blockId)
  }, [editorRef, store, focusNameRow])

  /** θ6（2026-10-13）：编辑态内点另一块 = **光标一步到位**——光标已由浏览器放在点按处，
   *  这里**只把「编辑块」标记跟过去**（`setTouchEditId`），不 `focus`、不 `focusBlockEnd`
   *  （那会把光标推到块尾，毁掉「点哪儿落哪儿」）。 */
  const followTouchBlock = useCallback((blockId: string) => { setTouchEditId(blockId) }, [])

  /** 退出编辑态：清块选中、清文字选区、收键盘（blur）。 */
  const exitTouchEdit = useCallback(() => {
    setTouchEditId(null)
    exitSelection()
    window.getSelection()?.removeAllRanges()
    editorRef.current?.getRootElement()?.blur()
  }, [editorRef, exitSelection])

  /** 编辑态内点空白（θ13，2026-10-13 用户走查）：**只回打字态，不退编辑**——只读态只在「完成」/ Esc / 返回 /
   *  退出再进来 才出现（旧版「没有块选中就退编辑」被真机上的双击空白误触成两段退 ⇒ 用户：选中态退出也该留在编辑态）。 */
  const touchBlankTap = useCallback(() => {
    exitSelection()
    editorRef.current?.focus()
  }, [exitSelection, editorRef])

  return { touchEditId, activateTouchBlock, followTouchBlock, touchBlankTap, exitTouchEdit }
}
