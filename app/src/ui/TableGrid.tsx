import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  deleteColumn, deleteRow, insertColumn, insertRow, isMergeAnchor, mergeAt, mergeCells, parseTable,
  rowCount, serializeTable, setCell, setColumnAlign, setColumnWidth, unmergeCells,
  tablePayloadAfterEdit, tablePayloadToModel, tablePayloadToText,
  type TableAlign, type TableModel, type TablePayload,
} from '@moqi/editor'

/**
 * 富表格视图（表格块的两态之一；另一态是源码文本）。
 *
 * 试点：网格的真相是块上的 `table` payload（`domain/tablePayload`），Markdown 文本是它的投影。
 * 交互按三态焦点模型走：
 *   table（整表选中）──Enter/F2/直接打字──► cell（单元格选中）──Enter/F2/直接打字──► editing（格内编辑）
 *   反向：editing --Esc--> cell --Esc--> table --Esc/Tab--> 退出到表后（或表前）。
 * 单元格文字在**一次编辑会话**结束时才写回（失焦 / Enter / Tab / Esc / 卸载），
 * 所以一次格编辑 = 一个事务；打字期间不惊动宿主，不会因为重铺节点丢字。
 */

const ALIGN_CYCLE: TableAlign[] = [null, 'left', 'center', 'right']

const alignLabel = (align: TableAlign): string => (align === 'center' ? '居中' : align === 'right' ? '右对齐' : align === 'left' ? '左对齐' : '默认')

type Mode = 'table' | 'cell' | 'editing'
type CellPos = { row: number; column: number }
type Selection = { row: number; col: number; row2: number; col2: number }

export function TableGrid({ text, payload, onChange, onExitTable }: {
  /** 块的正文（Markdown 管道表；payload 的投影或旧数据原文）。 */
  text: string
  /** 块上的网格 payload（缺省 = 旧数据，按文本解析）。 */
  payload?: TablePayload | null
  /** 写回 payload（宿主负责 payload + 投影一次事务落库）。 */
  onChange: (next: TablePayload) => void
  /** 退出表格：把光标放到表后 / 表前（宿主负责）。 */
  onExitTable?: (where: 'before' | 'after') => void
}) {
  const gridOf = (nextText: string, nextPayload: TablePayload | null | undefined): TableModel | null =>
    nextPayload && tablePayloadToText(nextPayload) === nextText
      ? tablePayloadToModel(nextPayload)
      : parseTable(nextText)
  // 渲染期按 props 调整 state（React 官方「随 props 调整」写法）：外部文本变了才重灌模型。
  const [state, setState] = useState<{ text: string; model: TableModel | null }>(() => ({ text, model: gridOf(text, payload) }))
  if (state.text !== text) {
    const parsed = gridOf(text, payload)
    setState({ text, model: state.model && parsed && serializeTable(state.model) === text ? state.model : parsed })
  }
  const model = state.text === text ? state.model : gridOf(text, payload)

  const [mode, setMode] = useState<Mode>('table')
  const [active, setActive] = useState<CellPos>({ row: 0, column: 0 })
  const [selection, setSelection] = useState<Selection | null>(null)
  const [drag, setDrag] = useState<{ column: number; width: number } | null>(null)

  const rootRef = useRef<HTMLDivElement>(null)
  const focusTimer = useRef<number | null>(null)
  const containerTimers = useRef<number[]>([])
  const dirty = useRef(false)
  const modelRef = useRef<TableModel | null>(null)
  const onChangeRef = useRef(onChange)
  const onExitRef = useRef(onExitTable)
  // 最新值在提交后同步（React 19 禁止渲染期写 ref）；用 layout effect 保证
  // 紧跟着的失焦 / Enter / Tab 一定读到本次渲染的模型，不等下一帧。
  useLayoutEffect(() => { modelRef.current = model })
  useLayoutEffect(() => { onChangeRef.current = onChange }, [onChange])
  useLayoutEffect(() => { onExitRef.current = onExitTable }, [onExitTable])

  /** 一次格编辑会话的提交：只在会话结束时写回，一格里敲多少键都算一个事务。 */
  const flush = useCallback(() => {
    if (!dirty.current) return
    dirty.current = false
    const current = modelRef.current
    if (current) onChangeRef.current(tablePayloadAfterEdit(current))
  }, [])
  useEffect(() => () => {
    flush()
    if (focusTimer.current !== null) window.clearTimeout(focusTimer.current)
    for (const id of containerTimers.current) window.clearTimeout(id)
  }, [flush])

  // 焦点按**当前表格**作用域找：`data-cell` 只有行列，同页多张表会撞键。
  const clearContainerFocus = useCallback(() => {
    for (const id of containerTimers.current) window.clearTimeout(id)
    containerTimers.current = []
  }, [])
  const focusCell = useCallback((row: number, column: number) => {
    clearContainerFocus()
    const input = rootRef.current?.querySelector<HTMLInputElement>(`input[data-cell="${row}:${column}"]`)
    input?.focus()
    input?.setSelectionRange(input.value.length, input.value.length)
  }, [clearContainerFocus])
  // 加行 / 结束编辑后宿主会重铺编辑器节点——立刻聚焦会被下一次渲染抢走。
  const scheduleFocus = useCallback((row: number, column: number) => {
    if (focusTimer.current !== null) window.clearTimeout(focusTimer.current)
    let attempts = 0
    const attempt = () => {
      focusCell(row, column)
      attempts += 1
      if (attempts < 3) focusTimer.current = window.setTimeout(attempt, attempts === 1 ? 30 : 120)
    }
    focusTimer.current = window.setTimeout(attempt, 0)
  }, [focusCell])
  const focusContainer = useCallback(() => {
    clearContainerFocus()
    containerTimers.current = [0, 60].map((delay) => window.setTimeout(() => rootRef.current?.focus(), delay))
  }, [clearContainerFocus])

  if (!model) return null

  const rowTotal = rowCount(model)
  const activeCell: CellPos = {
    row: Math.min(active.row, rowTotal - 1),
    column: Math.min(active.column, model.header.length - 1),
  }

  const cellCovered = (table: TableModel, row: number, column: number) => {
    const merge = mergeAt(table, row, column)
    return !!merge && !isMergeAnchor(table, row, column)
  }
  const firstVisibleColumn = (table: TableModel, row: number) => {
    for (let column = 0; column < table.header.length; column += 1) {
      if (!cellCovered(table, row, column)) return column
    }
    return 0
  }
  const visibleCells = (table: TableModel): Array<[number, number]> => {
    const cells: Array<[number, number]> = []
    for (let row = 0; row < rowCount(table); row += 1) {
      for (let column = 0; column < table.header.length; column += 1) {
        if (!cellCovered(table, row, column)) cells.push([row, column])
      }
    }
    return cells
  }

  const setLocalCell = (next: TableModel) => {
    dirty.current = true
    setState((prev) => ({ ...prev, model: next }))
  }
  /** 结构改动（加行/列、合并、对齐、列宽）立即提交；连同未提交的格编辑一起进同一个事务。 */
  const applyStructural = (next: TableModel, focus?: CellPos) => {
    dirty.current = false
    const nextPayload = tablePayloadAfterEdit(next)
    setState({ text: tablePayloadToText(nextPayload), model: next })
    onChangeRef.current(nextPayload)
    if (focus) {
      setActive(focus)
      setMode('editing')
      scheduleFocus(focus.row, focus.column)
    }
  }
  const exitTable = (where: 'before' | 'after') => {
    clearContainerFocus()
    flush()
    setMode('table')
    setSelection(null)
    if (onExitRef.current) onExitRef.current(where)
    else rootRef.current?.blur()
  }
  const enterEditing = (row: number, column: number, initial?: string) => {
    setActive({ row, column })
    setMode('editing')
    setSelection(null)
    if (initial !== undefined) setLocalCell(setCell(model, row, column, initial))
    scheduleFocus(row, column)
  }
  const selectAt = (row: number, column: number, extend: boolean) => {
    setActive({ row, column })
    setMode('cell')
    setSelection((current) => (extend && current ? { ...current, row2: row, col2: column } : null))
    focusContainer()
  }
  const moveSelection = (dRow: number, dColumn: number, extend: boolean) => {
    let row = activeCell.row + dRow
    let column = activeCell.column + dColumn
    while (row >= 0 && row < rowTotal && column >= 0 && column < model.header.length && cellCovered(model, row, column)) {
      row += dRow
      column += dColumn
    }
    if (row < 0 || row >= rowTotal || column < 0 || column >= model.header.length) return
    selectAt(row, column, extend)
  }
  const moveByCells = (delta: number) => {
    const cells = visibleCells(model)
    const index = cells.findIndex(([row, column]) => row === activeCell.row && column === activeCell.column)
    if (index < 0) return
    const target = cells[index + delta]
    if (target) {
      selectAt(target[0], target[1], false)
      return
    }
    exitTable(delta > 0 ? 'after' : 'before')
  }
  /** Enter：下一行同列；最后一行（或空表）加一行再进去；合并格按跨行数跳。 */
  const enterDown = (row: number, column: number) => {
    flush()
    const merge = mergeAt(model, row, column)
    const step = merge && isMergeAnchor(model, row, column) ? merge.rowSpan : 1
    let next = row + step
    while (next < rowTotal && cellCovered(model, next, column)) next += 1
    if (next < rowTotal) {
      setActive({ row: next, column })
      setMode('editing')
      scheduleFocus(next, column)
      return
    }
    const inserted = insertRow(model, model.rows.length)
    const targetRow = inserted.rows.length
    applyStructural(inserted, { row: targetRow, column: firstVisibleColumn(inserted, targetRow) })
  }
  /** 编辑中的 Tab / Shift+Tab：下一格；末格离开表格（不再无限加行）。 */
  const moveEditing = (delta: number) => {
    flush()
    const cells = visibleCells(model)
    const index = cells.findIndex(([row, column]) => row === activeCell.row && column === activeCell.column)
    if (index < 0) return
    const target = cells[index + delta]
    if (target) {
      setActive({ row: target[0], column: target[1] })
      setMode('editing')
      scheduleFocus(target[0], target[1])
      return
    }
    exitTable(delta > 0 ? 'after' : 'before')
  }
  const clearSelected = () => {
    let next = model
    if (selection) {
      const top = Math.min(selection.row, selection.row2)
      const bottom = Math.max(selection.row, selection.row2)
      const left = Math.min(selection.col, selection.col2)
      const right = Math.max(selection.col, selection.col2)
      for (let row = top; row <= bottom; row += 1) {
        for (let column = left; column <= right; column += 1) {
          next = setCell(next, row, column, '')
        }
      }
    } else {
      next = setCell(next, activeCell.row, activeCell.column, '')
    }
    applyStructural(next)
  }

  const onCellKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    // 输入框的键不再冒泡给容器：否则 Enter/Tab 会被「格选中」逻辑再执行一遍，
    // 打字也会被容器当成「替换该格」。
    event.stopPropagation()
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      enterDown(activeCell.row, activeCell.column)
    } else if (event.key === 'Tab') {
      event.preventDefault()
      moveEditing(event.shiftKey ? -1 : 1)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      flush()
      setMode('cell')
      setSelection(null)
      focusContainer()
    }
  }

  const onContainerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // 只处理容器自己持有的焦点；输入框里的事件由 onCellKeyDown 负责。
    if (event.target !== event.currentTarget) return
    if (event.nativeEvent.isComposing) return
    if (mode === 'table') {
      if (event.key === 'Escape') {
        event.preventDefault()
        exitTable('after')
      } else if (event.key === 'Tab') {
        event.preventDefault()
        exitTable(event.shiftKey ? 'before' : 'after')
      } else if (event.key === 'Enter' || event.key === 'F2') {
        event.preventDefault()
        enterEditing(activeCell.row, activeCell.column)
      }
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      setMode('table')
      setSelection(null)
    } else if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault()
      enterEditing(activeCell.row, activeCell.column)
    } else if (event.key === 'Tab') {
      event.preventDefault()
      moveByCells(event.shiftKey ? -1 : 1)
    } else if (event.key.startsWith('Arrow')) {
      event.preventDefault()
      const deltaRow = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
      const deltaColumn = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
      moveSelection(deltaRow, deltaColumn, event.shiftKey)
    } else if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault()
      clearSelected()
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      // Excel 口径：选中格直接打字 = 替换该格并进入编辑。
      event.preventDefault()
      enterEditing(activeCell.row, activeCell.column, event.key)
    }
  }

  const cycleAlign = (column: number) => {
    const current = model.align[column] ?? null
    applyStructural(setColumnAlign(model, column, ALIGN_CYCLE[(ALIGN_CYCLE.indexOf(current) + 1) % ALIGN_CYCLE.length]))
  }

  const selectCell = (row: number, column: number, extend: boolean) => {
    setActive({ row, column })
    setSelection((current) => {
      // Shift 扩选的 anchor：优先现有选区起点；选区为空（焦点竞态清过）时以「上一次活跃格」兜底
      // ——闭包里的 activeCell 是本次点击前的格，正是用户意图的起点。
      const anchor = current ?? { row: activeCell.row, col: activeCell.column }
      return extend ? { row: anchor.row, col: anchor.col, row2: row, col2: column } : { row, col: column, row2: row, col2: column }
    })
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
    applyStructural(mergeCells(model, bounds.top, bounds.left, bounds.bottom, bounds.right))
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
    applyStructural(next)
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
    const classes: string[] = []
    if (bounds) {
      const inside = row >= bounds.top && row <= bounds.bottom && column >= bounds.left && column <= bounds.right
      if (inside) classes.push('is-selected')
    }
    if (mode !== 'table' && activeCell.row === row && activeCell.column === column) classes.push('is-active')
    return classes.join(' ')
  }

  const cellInput = (value: string, row: number, column: number, cellKey: string) => (
    <input
      className="b-table-inp"
      data-cell={cellKey}
      tabIndex={-1}
      readOnly={mode !== 'editing' || activeCell.row !== row || activeCell.column !== column}
      style={{ textAlign: model.align[column] ?? undefined }}
      value={value}
      onChange={(event) => setLocalCell(setCell(model, row, column, event.target.value))}
      onFocus={() => {
        setActive({ row, column })
        setMode('editing')
        // 聚焦格 = 单格选区（焦点格即选区）：此前这里清空选区，Shift 扩选刚建立的区间会被
        // 「浏览器聚焦新格 → onFocus」的时序冲掉，鼠标多选永远只有一格（合并不可达）。
        setSelection({ row, col: column, row2: row, col2: column })
      }}
      onBlur={(event) => {
        flush()
        const next = event.relatedTarget as Node | null
        if (!next || !rootRef.current?.contains(next)) {
          setMode('table')
          setSelection(null)
        }
      }}
      onKeyDown={onCellKeyDown}
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
      applyStructural(setColumnWidth(model, column, width))
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const widthOf = (column: number) => (drag?.column === column ? drag.width : model.widths[column] || 0)

  return (
    <div
      className="b-table"
      ref={rootRef}
      tabIndex={0}
      role="group"
      aria-label="表格"
      data-mode={mode}
      data-active-cell={mode === 'table' ? '' : `${activeCell.row}:${activeCell.column}`}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={onContainerKeyDown}
    >      <div className="b-table-bar">
        <button
          type="button"
          onClick={() => {
            const inserted = insertRow(model, model.rows.length)
            const targetRow = inserted.rows.length
            applyStructural(inserted, { row: targetRow, column: firstVisibleColumn(inserted, targetRow) })
          }}
        >
          ＋ 行
        </button>
        <button type="button" onClick={() => applyStructural(insertColumn(model, model.header.length))}>＋ 列</button>
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
                    <div
                      className="b-table-head"
                      onMouseDown={(event) => {
                        if (event.shiftKey) { event.preventDefault(); selectCell(0, column, true); return }
                        setActive({ row: 0, column })
                        setMode('editing')
                        setSelection({ row: 0, col: column, row2: 0, col2: column })
                        scheduleFocus(0, column)
                      }}
                    >
                      {cellInput(cell, 0, column, `0:${column}`)}
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
                        <button type="button" className="b-table-tool is-danger" title="删除该列" aria-label="删除列" onClick={() => applyStructural(deleteColumn(model, column))}>×</button>
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
                      <div
                        onMouseDown={(event) => {
                          if (event.shiftKey) { event.preventDefault(); selectCell(rowIndex + 1, column, true); return }
                          setActive({ row: rowIndex + 1, column })
                          setMode('editing')
                          setSelection({ row: rowIndex + 1, col: column, row2: rowIndex + 1, col2: column })
                          scheduleFocus(rowIndex + 1, column)
                        }}
                      >
                        {cellInput(cell, rowIndex + 1, column, `${rowIndex + 1}:${column}`)}
                      </div>
                    </td>
                  )
                })}
                <td className="b-table-rowdel">
                  <button
                    type="button"
                    className="b-table-tool is-danger"
                    title={model.rows.length > 1 ? '删除该行' : '至少保留一行'}
                    aria-label="删除行"
                    disabled={model.rows.length <= 1}
                    onClick={() => applyStructural(deleteRow(model, rowIndex))}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
