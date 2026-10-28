/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { textSelectionRectOf, toolbarPlacement } from './placement'

/**
 * 选区气泡（`10` §6.3 定稿）：触控编辑态里块内选词后浮在选区上方的**文本动作**条（宽 344 · 七格）：
 * 复制 / 剪切 / 粘贴（剪贴板有内容时）/ 全选（本站块内）/ 删除 ｜ `链接`（点开**就地两行**：外部链接 /
 * 页面链接——选区转链接的选区安全通道）｜ `格式 ▸`（关气泡、`Aa` 文字格式面板就位）。
 * **`✦AI` 已撤**（主条 `✦` 一步可达）；粘贴 / 全选自明图标（`clipboard-paste` / `square-dashed`）。
 *
 * 动作全走浏览器编辑管线（`execCommand` / DOM Range）——不 import 内核（边界门 ③），
 * 改动经 input 事件回流到 Lexical → 领域（与打字同一条路）。关闭：执行动作后 / 点选区外
 * （选区塌缩自动隐藏）/ 退出编辑态（随 gate 卸载）。
 */
export function TouchBubble({ editingBlockId, onFormat, onLinkDialog, onConvertLink, clipboard }: {
  editingBlockId: string
  /** `格式 ▸`：关气泡、键盘上方格式栏的 `Aa` 文字格式面板就位（`10` §6.3 定稿）。 */
  onFormat: () => void
  /** `链接` 子菜单两态（选区安全通道；`R09-TXBAR-2` 桌面同批补「外部链接」）。 */
  onLinkDialog: () => void
  onConvertLink: () => void
  /** 剪贴板端口注入（D-104）：气泡的复制 / 粘贴走宿主能力——墨契壳传 `clipboardPort`。 */
  clipboard: { readText(): Promise<string>; writeText(text: string): Promise<void> }
}) {
  const [rect, setRect] = useState<{ top: number; left: number; right: number; bottom: number; width: number; height: number } | null>(null)
  const [dismissed, setDismissed] = useState(false)
  /** 链接子菜单（就地两行）：外部链接 / 页面链接（工具栏线框（已归档） §四）。 */
  const [linkSub, setLinkSub] = useState(false)
  const [canPaste, setCanPaste] = useState(false)
  /** 动作后收起时记下当时的选区文字：选的东西一变（含清空）气泡就复活，同一个选区不反复弹。 */
  const dismissedTextRef = useRef('')

  const measure = useCallback(() => {
    const found = textSelectionRectOf(document.querySelector('.doc-col'), typeof window === 'undefined' ? null : window.getSelection())
    setRect(found)
    const text = typeof window === 'undefined' ? '' : (window.getSelection()?.toString() ?? '')
    if (!found || text !== dismissedTextRef.current) {
      dismissedTextRef.current = ''
      setDismissed(false)
    }
  }, [])

  useEffect(() => {
    const onChange = () => measure()
    // 新手势 = 新语境：编辑区里任何一次按下都让「动作后收起」复位——同一段文字被刻意重选也复活。
    const onPointerDown = (event: Event) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      if (!target?.closest('.doc-col')) return
      dismissedTextRef.current = ''
      setDismissed(false)
    }
    document.addEventListener('selectionchange', onChange)
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('scroll', onChange, true)
    window.addEventListener('resize', onChange)
    measure()
    return () => {
      document.removeEventListener('selectionchange', onChange)
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('scroll', onChange, true)
      window.removeEventListener('resize', onChange)
    }
  }, [measure])

  // 粘贴只在剪贴板真的读得到内容时出现（读不到 = 空剪贴板 / 非文本 / 无授权，如实不摆假按钮）。
  useEffect(() => {
    if (!rect) return
    let alive = true
    clipboard.readText()
      .then((text) => { if (alive) setCanPaste(text.length > 0) })
      .catch(() => { if (alive) setCanPaste(false) })
    return () => { alive = false }
  }, [rect])

  const selectedText = () => window.getSelection()?.toString() ?? ''
  const finish = () => {
    dismissedTextRef.current = selectedText()
    setDismissed(true)
  }
  // 删除 / 粘贴都走 `insertText`（空串 = 删）——经 beforeinput 回流 Lexical → 领域（与打字同一条路）。
 // 为什么不用 `execCommand('delete')`：在 Lexical 树上会被它的 DOM 调协回滚（ 探针实测：
  // 返回 true、文字原样）；`Range.deleteContents` 同样被回滚。空白 insertText 是实测唯一真删路。
  const replaceSelection = (text: string) => {
    document.execCommand('insertText', false, text)
  }
  const copy = async () => {
    const text = selectedText()
    if (!text) return
    try { await clipboard.writeText(text) } catch { /* 剪贴板不可用：静默（与桌面选中工具栏同口径） */ }
    finish()
  }
  const cut = async () => {
    const text = selectedText()
    if (!text) return
    try { await clipboard.writeText(text) } catch { /* 同上 */ }
    replaceSelection('')
    finish()
  }
  const remove = () => {
    if (!selectedText()) return
    replaceSelection('')
    finish()
  }
  const paste = async () => {
    try {
      const text = await clipboard.readText()
      if (!text) return
      replaceSelection(text)
      finish()
    } catch { /* 读不到剪贴板就什么都不做（按钮本就不该出现） */ }
  }
  const selectAll = () => {
    const block = document.querySelector<HTMLElement>(`.moqi-block[data-entity-id="${editingBlockId}"]`)
    if (!block) return
    const range = document.createRange()
    range.selectNodeContents(block)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    // 不关气泡：选区被这次动作放大，气泡跟着重锚——接着点「格式 ▸」是常见路径。
  }

  if (!rect || dismissed) return null
  const width = 344
 // 定位入参用**视觉视口**（`#4` 遗留收口项，）：键盘弹起时 `visualViewport.width` 才是可用的那一块
  // （`10` 二册 §6.3「键盘上方格式栏与选区气泡按视觉视口坐标锚定」）；无 `visualViewport` 的桌面/测试环境
  // 回落到 `innerWidth`。气泡不按 `bottom` 锚（它是 `top/left` 由本函数算的），所以不加 `--kb-h`。
  const viewportWidth = typeof window === 'undefined'
    ? 1200
    : Math.round(window.visualViewport?.width ?? window.innerWidth)
  const { top, left } = toolbarPlacement('text', rect, { width, viewportWidth })
  const prevent = (event: { preventDefault: () => void }) => event.preventDefault()

  return (
    <div className="tbox" role="toolbar" aria-label="选区操作" style={{ top, left, width }}>
      {/* 图标 + 中文标签（`05` 视觉批「正形」）：图标为单色 Icon、标签文本不变（验收按文本匹配）。 */}
      <button type="button" onMouseDown={prevent} aria-label="复制" title="复制" onClick={() => void copy()}><Icon name="copy" size={20} decorative /></button>
      <button type="button" onMouseDown={prevent} aria-label="剪切" title="剪切" onClick={() => void cut()}><Icon name="scissors" size={20} decorative /></button>
      {canPaste ? <button type="button" onMouseDown={prevent} aria-label="粘贴" title="粘贴" onClick={() => void paste()}><Icon name="clipboard-paste" size={20} decorative /></button> : null}
      <button type="button" onMouseDown={prevent} aria-label="全选" title="全选" onClick={selectAll}><Icon name="square-dashed" size={20} decorative /></button>
      <button type="button" className="is-danger" onMouseDown={prevent} aria-label="删除" title="删除" onClick={remove}><Icon name="trash" size={20} decorative /></button>
      <span className="div" />
      <button type="button" className={linkSub ? 'is-on' : ''} aria-expanded={linkSub} aria-label="链接" title="链接（外部链接 / 页面链接）" onMouseDown={prevent} onClick={() => setLinkSub((value) => !value)}><Icon name="link" size={20} decorative /></button>
      <button type="button" onMouseDown={prevent} onClick={() => { finish(); onFormat() }}>格式 ▸</button>
      {linkSub ? (
        <div className="tbox-sub" role="menu" aria-label="链接">
          <button type="button" onMouseDown={prevent} role="menuitem" onClick={() => { finish(); onLinkDialog() }}>
            <span className="mi"><Icon name="external-link" size={20} decorative /></span><span>外部链接</span>
          </button>
          <button type="button" onMouseDown={prevent} role="menuitem" onClick={() => { finish(); onConvertLink() }}>
            <span className="mi"><Icon name="brackets" size={20} decorative /></span><span>页面链接</span>
          </button>
        </div>
      ) : null}
    </div>
  )
}
