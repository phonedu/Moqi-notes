import { useState } from 'react'
import {
  deleteColumn, deleteRow, insertColumn, insertRow, parseTable, serializeTable, setCell, setColumnAlign,
  type TableAlign, type TableModel,
} from '@moqi/editor'

/**
 * 富表格视图（表格块的两态之一；另一态是源码文本）。
 *
 * 真相永远是块的正文文本（Markdown 管道表）：这里每次改动都 `serializeTable` 回文本、交给宿主
 * `replaceBlockText` 落库——所以导出/导入语义、撤销栈、同步全都沿用既有通道，表格视图只是编辑器。
 *
 * 受控策略：本地持 `model`，外部 `text` 变化（源码视图改过 / 撤销）时按**序列化等值**判断是否重灌，
 * 避免打字过程中把输入框光标重置。
 */

const ALIGN_CYCLE: TableAlign[] = [null, 'left', 'center', 'right']

const alignLabel = (align: TableAlign): string => (align === 'center' ? '居中' : align === 'right' ? '右对齐' : align === 'left' ? '左对齐' : '默认')

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

  if (!model) return null

  const commit = (next: TableModel) => {
    const nextText = serializeTable(next)
    setState({ text: nextText, model: next })
    onChange(nextText)
  }

  const cycleAlign = (column: number) => {
    const current = model.align[column] ?? null
    const next = ALIGN_CYCLE[(ALIGN_CYCLE.indexOf(current) + 1) % ALIGN_CYCLE.length]
    commit(setColumnAlign(model, column, next))
  }

  const cellInput = (value: string, onInput: (next: string) => void, column = 0) => (
    <input
      className="b-table-inp"
      style={{ textAlign: model.align[column] ?? undefined }}
      value={value}
      onChange={(event) => onInput(event.target.value)}
      onKeyDown={(event) => {
        // 表格里 Tab / Shift+Tab 只走单元格导航（浏览器默认即可）；回车不换行、不拆块
        if (event.key === 'Enter') event.preventDefault()
      }}
    />
  )

  return (
    <div className="b-table" onMouseDown={(event) => event.stopPropagation()}>
      <div className="b-table-bar">
        <button type="button" onClick={() => commit(insertRow(model, model.rows.length))}>＋ 行</button>
        <button type="button" onClick={() => commit(insertColumn(model, model.header.length))}>＋ 列</button>
        <span className="b-table-hint">Markdown 管道表</span>
      </div>
      <div className="b-table-scroll">
        <table>
          <thead>
            <tr>
              {model.header.map((cell, column) => (
                <th key={column}>
                  <div className="b-table-head">
                    {cellInput(cell, (next) => commit(setCell(model, 0, column, next)), column)}
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
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, column) => (
                  <td key={column}>{cellInput(cell, (next) => commit(setCell(model, rowIndex + 1, column, next)), column)}</td>
                ))}
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
