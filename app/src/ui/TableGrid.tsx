import { useState } from 'react'
import {
  deleteColumn, deleteRow, insertColumn, insertRow, isMergeAnchor, mergeAt, mergeCells, parseTable,
  rowCount, serializeTable, setCell, setColumnAlign, setColumnWidth, unmergeCells,
  type TableAlign, type TableModel,
} from '@moqi/editor'

/**
 * 富表格视图（表格块的两态之一；另一态是源码文本）。
 *
 * 真相永远是块的正文文本（Markdown 管道表）：这里每次改动都 `serializeTable` 回文本、交给宿主
 * `replaceBlockText` 落库——所以导出/导入语义、撤销栈、同步全都沿用既有通道，表格视图只是编辑器。
 *
 * 合并单元格与列宽在 Markdown 里没有表示法：它们随文本一起走**旁注**（`%% moqi-table: … %%`），
 * 见 `domain/tableModel`。这里只负责画与操作。
 */

const ALIGN_CYCLE: TableAlign[] = [null, 'left', 'center', 'right']

const alignLabel = (align: TableAlign): string => (align === 'center' ? '居中' : align === 'right' ? '右对齐' : align === 'left' ? '左对齐' : '默认')

type Selection = { row: number; col: number; row2: number; col2: number }

export function TableGrid({ text, onChange }: {
  /** 块的正文（Markdown 管道表）。 */
  text: string
  /** 写回文本（宿主负责 replaceBlockText 落库）。 */
  onChange: (next: string) => void
}) {
  // 渲染期按 props 调整 state（React 官方「随 props 调整」写法）：外部文本变了才重灌模型；
  // 自己写出去的那一份序列化后与 text 等值，不会把输入框光标重置。
  const [state, setState] = useState<{ text: string; model: TableModel | null }>(() => ({ text, model: parseTable(text) }))
  if (state.text !== text) {
    const parsed = parseTable(text)
    setState({ text, model: state.model && parsed && serializeTable(state.model) === text ? state.model : parsed })
  }
  const model = state.text === text ? state.model : parseTable(text)

  const [selection, setSelection] = useState<Selection | null>(null)
  const [drag, setDrag] = useState<{ column: number; width: number } | null>(null)

  if (!model) return null

  const commit = (next: TableModel) => {
    const nextText = serializeTable(next)
    // 写回要经过编辑器镜像，那一步会把焦点抢回正文根（实测：连续打字只有第一个字进得来）。
    // 这里记住当前格子与光标，写完立刻还回去。
    const active = typeof document !== 'undefined' ? (document.activeElement as HTMLInputElement | null) : null
    const cellKey = active?.dataset?.cell ?? null
    const caret = active && typeof active.selectionStart === 'number' ? active.selectionStart : null
    setState({ text: nextText, model: next })
    onChange(nextText)
    if (cellKey) {
      const again = document.querySelector<HTMLInputElement>(`.b-table-inp[data-cell="${cellKey}"]`)
      again?.focus()
      if (again && caret !== null) again.setSelectionRange(caret, caret)
    }
  }

  const cycleAlign = (column: number) => {
    const current = model.align[column] ?? null
    commit(setColumnAlign(model, column, ALIGN_CYCLE[(ALIGN_CYCLE.indexOf(current) + 1) % ALIGN_CYCLE.length]))
  }

  const selectCell = (row: number, column: number, extend: boolean) => {
    setSelection((current) => (extend && current ? { ...current, row2: row, col2: column } : { row, col: row, row2: row, col2: column }))
  }

  const bounds = (() => {
    if (!selection) return null
    return {
      top: Math.min(selection.row, selection.row2), bottom: Math.max(selection.row, selection.row2),
      left: Math.min(selection.col, selection.col2), right: Math.max(selection.col, selection.col2),
    }
  })()
  const selectionCells = bounds ? (bounds.bottom - bounds.top + 1) * (bounds.right - bounds.left + 1) : 0
  const selectionInMerge = (() => {
    if (!bounds) return false
    for (let row = bounds.top; row <= bounds.bottom; row += 1) {
      for (let column = bounds.left; column <= bounds.right; column += 1) {
        if (mergeAt(model, row, column)) return true
      }
    }
    return false
  })()

  const mergeSelection = () => {
    if (!bounds) return
    commit(mergeCells(model, bounds.top, bounds.left, bounds.bottom, bounds.right))
    setSelection(null)
  }
  const unmergeSelection = () => {
    if (!bounds) return
    let next = model
    for (let row = bounds.top; row <= bounds.bottom; row += 1) {
      for (let column = bounds.left; column <= bounds.right; column += 1) {
        next = unmergeCells(next, row, column)
      }
    }
    commit(next)
    setSelection(null)
  }

  /** 被别的合并块覆盖的格子（不渲染）。 */
  const covered = new Set<string>()
  for (let row = 0; row < rowCount(model); row += 1) {
    for (let column = 0; column < model.header.length; column += 1) {
      const merge = mergeAt(model, row, column)
      if (merge && !isMergeAnchor(model, row, column)) covered.add(`${row}:${column}`)
    }
  }

  const spanOf = (row: number, column: number) => {
    const merge = mergeAt(model, row, column)
    return merge ? { rowSpan: merge.rowSpan, colSpan: merge.colSpan } : {}
  }

  const cellClass = (row: number, column: number) => {
    if (!bounds) return ''
    const inside = row >= bounds.top && row <= bounds.bottom && column >= bounds.left && column <= bounds.right
    return inside ? 'is-selected' : ''
  }

  const cellInput = (value: string, onInput: (next: string) => void, column: number, cellKey: string) => (
    <input
      className="b-table-inp"
      data-cell={cellKey}
      style={{ textAlign: model.align[column] ?? undefined }}
      value={value}
      onChange={(event) => onInput(event.target.value)}
      onKeyDown={(event) => { if (event.key === 'Enter') event.preventDefault() }}
    />
  )

  const startResize = (event: React.MouseEvent<HTMLElement>, column: number) => {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startWidth = model.widths[column] || event.currentTarget.parentElement?.getBoundingClientRect().width || 80
    const move = (moveEvent: MouseEvent) => setDrag({ column, width: Math.max(48, Math.round(startWidth + (moveEvent.clientX - startX))) })
    const up = (upEvent: MouseEvent) => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      const width = Math.max(48, Math.round(startWidth + (upEvent.clientX - startX)))
      setDrag(null)
      commit(setColumnWidth(model, column, width))
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const widthOf = (column: number) => (drag?.column === column ? drag.width : model.widths[column] || 0)

  return (
    <div className="b-table" onMouseDown={(event) => event.stopPropagation()}>
      <div className="b-table-bar">
        <button type="button" onClick={() => commit(insertRow(model, model.rows.length))}>＋ 行</button>
        <button type="button" onClick={() => commit(insertColumn(model, model.header.length))}>＋ 列</button>
        <button type="button" disabled={selectionCells < 2} onClick={mergeSelection}>合并</button>
        <button type="button" disabled={!selectionInMerge} onClick={unmergeSelection}>拆分</button>
        <span className="b-table-hint">{selectionCells > 1 ? `已选 ${selectionCells} 格` : 'Markdown 管道表'}</span>
      </div>
      <div className="b-table-scroll">
        <table>
          <colgroup>
            {model.header.map((_, column) => {
              const width = widthOf(column)
              return <col key={column} style={width ? { width } : undefined} />
            })}
            <col style={{ width: 24 }} />
          </colgroup>
          <thead>
            <tr>
              {model.header.map((cell, column) => {
                if (covered.has(`0:${column}`)) return null
                return (
                  <th key={column} {...spanOf(0, column)} className={cellClass(0, column).trim()}>
                    <div className="b-table-head" onMouseDown={(event) => selectCell(0, column, event.shiftKey)}>
                      {cellInput(cell, (next) => commit(setCell(model, 0, column, next)), column, `0:${column}`)}
                      <button
                        type="button"
                        className="b-table-tool"
                        title={`列对齐：${alignLabel(model.align[column] ?? null)}（点击切换）`}
                        aria-label="列对齐"
                        onClick={() => cycleAlign(column)}
                      >
                        {model.align[column] === 'center' ? '↔' : model.align[column] === 'right' ? '→' : model.align[column] === 'left' ? '←' : '·'}
                      </button>
                      {model.header.length > 1 ? (
                        <button type="button" className="b-table-tool is-danger" title="删除该列" aria-label="删除列" onClick={() => commit(deleteColumn(model, column))}>×</button>
                      ) : null}
                      <span className="b-table-resize" role="separator" aria-label="拖动调列宽" onMouseDown={(event) => startResize(event, column)} />
                    </div>
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, column) => {
                  if (covered.has(`${rowIndex + 1}:${column}`)) return null
                  return (
                    <td key={column} {...spanOf(rowIndex + 1, column)} className={cellClass(rowIndex + 1, column).trim()}>
                      <div onMouseDown={(event) => selectCell(rowIndex + 1, column, event.shiftKey)}>
                        {cellInput(cell, (next) => commit(setCell(model, rowIndex + 1, column, next)), column, `${rowIndex + 1}:${column}`)}
                      </div>
                    </td>
                  )
                })}
                <td className="b-table-rowdel">
                  <button type="button" className="b-table-tool is-danger" title="删除该行" aria-label="删除行" onClick={() => commit(deleteRow(model, rowIndex))}>×</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** 表格块的装饰层（绝对定位在正文列里）：网格视图 + 「表格/源码」切换按钮。 */
export function TableDecorations({ actions, sourceViewIds, onToggleSourceView, onSetText }: {
  actions: Array<{ id: string; rectTop: number; rectLeft: number; width: number; height: number; text: string }>
  sourceViewIds: Set<string>
  onToggleSourceView: (blockId: string) => void
  onSetText?: (blockId: string, text: string) => void
}) {
  return (
    <>
      {actions.map((action) => (
        sourceViewIds.has(action.id) ? null : (
          <div
            key={`table-view-${action.id}`}
            className="b-table-wrap"
            style={{ top: action.rectTop, left: action.rectLeft, width: action.width, minHeight: action.height }}
          >
            <TableGrid text={action.text} onChange={(next) => onSetText?.(action.id, next)} />
          </div>
        )
      ))}
      {actions.map((action) => (
        <button
          key={`table-toggle-${action.id}`}
          type="button"
          className="b-table-toggle"
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
