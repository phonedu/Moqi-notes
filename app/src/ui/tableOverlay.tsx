import { useEffect, useLayoutEffect, useRef } from 'react'
import type { TablePayload } from '@moqi/editor'
import { blockElementById } from './blockAnchor'
import { TableGrid } from './TableGrid'
import type { TableAction } from './tableBlockLayout'

/**
 * 表格块的装饰层：绝对定位在正文列里，网格视图 + 「表格/源码」切换。
 *
 * 网格高度经 `onMeasure` 回写给块（`tableBlockLayout`）：块自己占住这段高度，
 * 句柄 / ＋ / 选中框与网格同高，且不再盖住下面的块。
 */
export function TableDecorations({ actions, selectedIds, sourceViewIds, onToggleSourceView, onSetPayload, onExitTable, onMeasure }: {
  actions: TableAction[]
  selectedIds: string[]
  sourceViewIds: Set<string>
  onToggleSourceView: (blockId: string) => void
  onSetPayload?: (blockId: string, payload: TablePayload) => void
  onExitTable?: (blockId: string, where: 'before' | 'after') => void
  /** 网格内容高（含装饰层内距）→ 块的 min-height；null = 清掉。 */
  onMeasure?: (blockId: string, height: number | null) => void
}) {
  // 源码视图没有网格：块回到文本高度。滚出视口的清理由 TableOverlay 的卸载不做——
  // 那会让下文跳动；这里只处理明确的「切到源码」。
  useEffect(() => {
    for (const id of sourceViewIds) onMeasure?.(id, null)
  }, [sourceViewIds, onMeasure])

  return (
    <>
      {actions.map((action) => (
        sourceViewIds.has(action.id) ? null : (
          <TableOverlay
            key={`table-view-${action.id}`}
            action={action}
            selected={selectedIds.includes(action.id)}
            onMeasure={onMeasure}
            onSetPayload={onSetPayload}
            onExitTable={onExitTable}
          />
        )
      ))}
      {actions.map((action) => (
        <button
          key={`table-toggle-${action.id}`}
          type="button"
          className="b-table-toggle"
          data-table-for={action.id}
          style={{ top: action.rectTop - 24, left: action.rectLeft + action.width - 64 }}
          aria-label={sourceViewIds.has(action.id) ? '切到表格视图' : '切到源码视图'}
          title={sourceViewIds.has(action.id) ? '切到表格视图' : '切到源码视图（Markdown 原文）'}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => { event.stopPropagation(); onToggleSourceView(action.id) }}
        >
          {sourceViewIds.has(action.id) ? '表格' : '源码'}
        </button>
      ))}
    </>
  )
}

function TableOverlay({ action, selected, onMeasure, onSetPayload, onExitTable }: {
  action: TableAction
  selected: boolean
  onMeasure?: (blockId: string, height: number | null) => void
  onSetPayload?: (blockId: string, payload: TablePayload) => void
  onExitTable?: (blockId: string, where: 'before' | 'after') => void
}) {
  const wrapRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const wrap = wrapRef.current
    const grid = wrap?.querySelector<HTMLElement>('.b-table')
    if (!wrap || !grid || !onMeasure) return
    const report = () => {
      const style = getComputedStyle(wrap)
      const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
      onMeasure(action.id, grid.getBoundingClientRect().height + padding)
    }
    report()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(report)
    observer.observe(grid)
    return () => {
      observer.disconnect()
      // 只有「块不再是表格」才清高度；滚出视口的卸载保持块高，否则下文会跳。
      const block = blockElementById(document.body, action.id)
      if (block && block.dataset.blockType !== 'table') onMeasure(action.id, null)
    }
  }, [action.id, onMeasure])

  return (
    <div
      ref={wrapRef}
      className={`b-table-wrap${selected ? ' is-selected' : ''}`}
      data-table-for={action.id}
      style={{ top: action.rectTop, left: action.rectLeft, width: action.width, minHeight: action.height }}
    >
      <TableGrid
        text={action.text}
        payload={action.payload}
        onChange={(next) => onSetPayload?.(action.id, next)}
        onExitTable={(where) => onExitTable?.(action.id, where)}
      />
    </div>
  )
}
