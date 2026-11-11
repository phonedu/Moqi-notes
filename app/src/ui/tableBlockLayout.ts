import { useCallback, type RefObject } from 'react'
import type { TablePayload } from '@moqi/editor'
import { blockElementById, rectOf, type BlockRect } from './blockAnchor'

export type TableAction = {
  id: string
  rectTop: number
  rectLeft: number
  width: number
  height: number
  text: string
  payload: TablePayload | null
}

type MeasureFrame = { rect: (rect: BlockRect) => BlockRect; inView: (rect: BlockRect) => boolean }

/**
 * 表格块的**纯文本**（含换行）：Lexical 把换行渲染成 `<br>`，`textContent` 会把它们吃掉。
 * 网格按这段 Markdown 解析；代码块的镜像着色层也用同一份读法。
 */
export function codeTextOf(root: Node): string {
  let out = ''
  root.childNodes.forEach((node) => {
    if (node.nodeType === Node.TEXT_NODE) out += node.textContent ?? ''
    else if (node.nodeName === 'BR') out += '\n'
    else out += codeTextOf(node)
  })
  return out
}

/** 表格块的网格落位（同一坐标系；文本用于解析成网格，payload 是持久化真相）。 */
export function measureTableActions(content: HTMLElement, frame: MeasureFrame, payloadOf?: (id: string) => TablePayload | null): TableAction[] {
  const actions: TableAction[] = []
  for (const element of content.querySelectorAll<HTMLElement>('.moqi-block[data-block-type="table"][data-entity-id]')) {
    const id = element.dataset.entityId
    if (!id) continue
    const rect = rectOf(element)
    if (!frame.inView(rect)) continue
    const localRect = frame.rect(rect)
    actions.push({ id, rectTop: localRect.top, rectLeft: localRect.left, width: localRect.width, height: localRect.height, text: codeTextOf(element), payload: payloadOf?.(id) ?? null })
  }
  return actions
}

/**
 * 表格装饰层 ↔ 块的高度桥（2026-11-11 表格块修复）。
 *
 * 网格是装饰层里的绝对定位层，块只按 Markdown 文本高度占位：网格比文本高时就会
 * **盖住下面的块**。这里把网格内容高写回块的 `min-height`，让块自己占住这段高度；
 * 块的句柄 / ＋ / 选中框因此与网格同高（不再"不属于一个块"）。
 *
 * 清高度的时机：切到源码视图（`TableDecorations` 的 effect）与块不再是表格
 * （`TableOverlay` 卸载时按 `data-block-type` 判断）。**滚出视口不清**——装饰层按
 * 视口范围渲染，清了会让下文跳动。
 */
export function useTableBlockHeight(contentRef: RefObject<HTMLElement | null>) {
  return useCallback((id: string, height: number | null) => {
    const element = blockElementById(contentRef.current, id)
    if (!element) return
    if (height === null) {
      element.style.removeProperty('min-height')
      return
    }
    const next = `${Math.ceil(height)}px`
    if (element.style.minHeight !== next) element.style.minHeight = next
  }, [contentRef])
}

/** 指针落在表格装饰层上时，也算悬停它所属的块（否则把手不出现）。 */
export function tableHoverId(target: EventTarget | null): string | null {
  return target instanceof HTMLElement ? target.closest<HTMLElement>('[data-table-for]')?.dataset.tableFor ?? null : null
}
