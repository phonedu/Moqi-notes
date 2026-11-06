/**
 * 富表格的**数据模型**（纯函数）：Markdown 管道表 ⇄ 网格。
 *
 * 真相仍是块的正文文本（Markdown 管道表）——富表格视图是它的编辑器，每次改动都重新序列化回文本。
 * 这样做的三个好处：① 导出/导入仍走同一条逐字节通道（不新增块类型、不改存储）；② 源码视图永远可用；
 * ③ 合并单元格/列宽这类 Markdown 表达不了的属性以**旁注注释**存在表外，不污染表格本体。
 *
 * 边界：GFM 口径——表头行 + 分隔行必有（GFM 规定如此，所以不做「有无表头」开关），
 * 列对齐支持 `:--` / `:-:` / `--:`；单元格内的 `|` 用 `\|` 写入、读回时还原。
 */

export type TableAlign = 'left' | 'center' | 'right' | null

/**
 * 新建表格的默认形态：两列表头 ＋ 一行空行。
 * 表格块插入后**直接出网格**（`parseTable` 认得出），不要求用户先写 Markdown——否则「插入表格」
 * 只会得到一块空文本，手机端尤其无从下手。
 */
export const DEFAULT_TABLE_MARKDOWN = '| 列1 | 列2 |\n| --- | --- |\n|  |  |'

/**
 * 合并块：`row` / `col` 是**左上角**（0 = 表头行），跨 `rowSpan` 行、`colSpan` 列。
 * 被覆盖的格子在网格里不渲染；它们的文本仍留在表格本体里（拆分后原样回来）。
 */
export type TableMerge = { row: number; col: number; rowSpan: number; colSpan: number }

export type TableModel = {
  /** 表头（第一行）。 */
  header: string[]
  /** 数据行；每行长度与 `header` 对齐（读入时按需补空 / 截断）。 */
  rows: string[][]
  /** 每列的对齐方式（长度与 `header` 一致）。 */
  align: TableAlign[]
  /** 合并单元格（Markdown 表达不了 ⇒ 存旁注）。 */
  merges: TableMerge[]
  /** 每列宽度（px；0 = 自适应）。同样存旁注。 */
  widths: number[]
}

/** 按未转义的 `|` 切分一行，去掉首尾空段（外层管道符不算单元格）。 */
function splitRow(line: string): string[] {
  const cells: string[] = []
  let current = ''
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '\\' && line[index + 1] === '|') { current += '|'; index += 1; continue }
    if (char === '|') { cells.push(current); current = ''; continue }
    current += char
  }
  cells.push(current)
  // 外层管道符：`| a | b |` 切出来是 ['', ' a ', ' b ', ''] ⇒ 去掉首尾各一个空段
  if (cells.length > 0 && cells[0].trim() === '') cells.shift()
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop()
  return cells.map((cell) => cell.trim())
}

function alignOf(separator: string): TableAlign {
  const trimmed = separator.trim()
  const left = trimmed.startsWith(':')
  const right = trimmed.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return null
}

function separatorOf(align: TableAlign): string {
  if (align === 'center') return ':---:'
  if (align === 'right') return '---:'
  if (align === 'left') return ':---'
  return '---'
}

/**
 * 旁注：合并单元格与列宽在标准 Markdown 里没有表示法（GFM 只有对齐），所以存在紧邻表格的一行
 * Obsidian 注释里——`%% moqi-table: {"merges":[[r,c,rs,cs]],"widths":[120,80]} %%`。
 * Obsidian 预览里注释不可见、表格照常渲染；我们进出都无损，降级清单不动。
 */
const META_RE = /^%%\s*moqi-table:\s*(\{.*\})\s*%%$/

type TableMeta = { merges: TableMerge[]; widths: number[] }

function parseMeta(line: string): TableMeta | null {
  const match = META_RE.exec(line.trim())
  if (!match) return null
  try {
    const raw = JSON.parse(match[1]) as { merges?: unknown; widths?: unknown }
    const merges: TableMerge[] = Array.isArray(raw.merges)
      ? raw.merges
        .filter((item): item is number[] => Array.isArray(item) && item.length === 4 && item.every((n) => typeof n === 'number'))
        .map(([row, col, rowSpan, colSpan]) => ({ row, col, rowSpan, colSpan }))
        .filter((merge) => merge.rowSpan >= 1 && merge.colSpan >= 1 && merge.row >= 0 && merge.col >= 0)
      : []
    const widths: number[] = Array.isArray(raw.widths)
      ? raw.widths.map((n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0))
      : []
    return { merges, widths }
  } catch {
    return null
  }
}

function serializeMeta(model: TableModel): string | null {
  const merges = model.merges ?? []
  const widths = model.widths ?? []
  if (merges.length === 0 && widths.every((width) => !width)) return null
  const payload: Record<string, unknown> = {}
  if (merges.length > 0) payload.merges = merges.map((merge) => [merge.row, merge.col, merge.rowSpan, merge.colSpan])
  if (widths.some((width) => width > 0)) payload.widths = widths.map((width) => width || 0)
  return `%% moqi-table: ${JSON.stringify(payload)} %%`
}

/** 文本 → 网格。不是合法管道表（缺分隔行 / 空表）时返回 null。 */
export function parseTable(text: string): TableModel | null {
  const allLines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  // 旁注行（表格之后的一行注释）先从表格行里摘出去
  const metaLine = allLines.find((line) => META_RE.test(line))
  const meta = metaLine ? parseMeta(metaLine) : null
  const lines = metaLine ? allLines.filter((line) => line !== metaLine) : allLines
  if (lines.length < 2) return null
  const header = splitRow(lines[0])
  const separators = splitRow(lines[1])
  if (header.length === 0) return null
  if (separators.length !== header.length) return null
  if (!separators.every((cell) => /^:?-{2,}:?$/.test(cell))) return null
  const align = separators.map(alignOf)
  const rows = lines.slice(2).map((line) => {
    const cells = splitRow(line)
    const normalized = header.map((_, column) => cells[column] ?? '')
    return normalized
  })
  return {
    header,
    rows,
    align,
    merges: (meta?.merges ?? []).filter((merge) => merge.row <= rows.length && merge.col < header.length),
    widths: header.map((_, column) => meta?.widths[column] ?? 0),
  }
}

/** 网格 → 文本（规范形态：单元格两侧各一空格、分隔行按对齐写；有合并/列宽时追加旁注行）。 */
export function serializeTable(model: TableModel): string {
  const escape = (cell: string) => cell.replaceAll('|', '\\|')
  const line = (cells: string[]) => `| ${cells.map(escape).join(' | ')} |`
  const separator = `| ${model.align.map(separatorOf).join(' | ')} |`
  const table = [line(model.header), separator, ...model.rows.map(line)].join('\n')
  const meta = serializeMeta(model)
  return meta ? `${table}\n${meta}` : table
}

/** 单元格取值（`row` 0 = 表头）。越界返回空串。 */
export function cellOf(model: TableModel, row: number, column: number): string {
  if (row === 0) return model.header[column] ?? ''
  return model.rows[row - 1]?.[column] ?? ''
}

/** 改一个单元格（`row` 0 = 表头）。 */
export function setCell(model: TableModel, row: number, column: number, value: string): TableModel {
  if (row === 0) {
    const header = [...model.header]
    if (column < 0 || column >= header.length) return model
    header[column] = value
    return { ...model, header }
  }
  const rows = model.rows.map((cells, index) => {
    if (index !== row - 1) return cells
    const next = [...cells]
    if (column < 0 || column >= next.length) return cells
    next[column] = value
    return next
  })
  return { ...model, rows }
}

/** 行数（含表头行）。 */
export function rowCount(model: TableModel): number {
  return model.rows.length + 1
}

/** 覆盖 `(row, column)` 的合并块（左上角格子上有，被覆盖的格子上也有——用来判「这格能不能编辑」）。 */
export function mergeAt(model: TableModel, row: number, column: number): TableMerge | null {
  return (model.merges ?? []).find((merge) => row >= merge.row && row < merge.row + merge.rowSpan
    && column >= merge.col && column < merge.col + merge.colSpan) ?? null
}

/** 这格是不是合并块的**左上角**（只有它的输入框可编辑）。 */
export function isMergeAnchor(model: TableModel, row: number, column: number): boolean {
  const merge = mergeAt(model, row, column)
  return merge !== null && merge.row === row && merge.col === column
}

/** 合并一个矩形区域（左上 / 右下都含）。越过边界自动夹紧；单格不成合并。 */
export function mergeCells(model: TableModel, top: number, left: number, bottom: number, right: number): TableModel {
  const rowStart = Math.max(0, Math.min(top, bottom))
  const rowEnd = Math.min(rowCount(model) - 1, Math.max(top, bottom))
  const colStart = Math.max(0, Math.min(left, right))
  const colEnd = Math.min(model.header.length - 1, Math.max(left, right))
  const rowSpan = rowEnd - rowStart + 1
  const colSpan = colEnd - colStart + 1
  if (rowSpan === 1 && colSpan === 1) return model
  // 与既有合并块相交的先拆掉（合并语义里不做嵌套）
  const kept = (model.merges ?? []).filter((merge) => {
    const intersects = merge.row <= rowEnd && merge.row + merge.rowSpan - 1 >= rowStart
      && merge.col <= colEnd && merge.col + merge.colSpan - 1 >= colStart
    return !intersects
  })
  return { ...model, merges: [...kept, { row: rowStart, col: colStart, rowSpan, colSpan }] }
}

/** 拆掉覆盖该格的合并块。 */
export function unmergeCells(model: TableModel, row: number, column: number): TableModel {
  const merge = mergeAt(model, row, column)
  if (!merge) return model
  return { ...model, merges: (model.merges ?? []).filter((item) => item !== merge) }
}

/** 设列宽（px；≤0 = 自适应）。 */
export function setColumnWidth(model: TableModel, column: number, width: number): TableModel {
  if (column < 0 || column >= model.header.length) return model
  const widths = model.header.map((_, index) => (index === column ? Math.max(0, Math.round(width)) : (model.widths[index] ?? 0)))
  return { ...model, widths }
}

/** 在 `index` 处插入一个空行（`index` 以数据行计；0 = 表头之下第一行）。合并块随之平移 / 长高。 */
export function insertRow(model: TableModel, index: number): TableModel {
  const dataAt = Math.max(0, Math.min(model.rows.length, index))
  const rows = [...model.rows]
  rows.splice(dataAt, 0, model.header.map(() => ''))
  // 合并块的 `row` 是**表行序**（表头 = 0），插入点是 `dataAt + 1`
  const at = dataAt + 1
  const merges = (model.merges ?? []).map((merge) => {
    if (merge.row >= at) return { ...merge, row: merge.row + 1 }
    if (merge.row < at && merge.row + merge.rowSpan > at) return { ...merge, rowSpan: merge.rowSpan + 1 }
    return merge
  })
  return { ...model, rows, merges }
}

/** 删一行数据行（表头行不可删）；覆盖行首的合并块缩一米，跨行的收缩，否则消失。 */
export function deleteRow(model: TableModel, index: number): TableModel {
  if (index < 0 || index >= model.rows.length) return model
  const at = index + 1
  const rows = model.rows.filter((_, rowIndex) => rowIndex !== index)
  const merges = (model.merges ?? []).flatMap((merge) => {
    const start = merge.row
    const end = merge.row + merge.rowSpan - 1
    if (at > end) return [merge]
    if (at < start) return [{ ...merge, row: start - 1 }]
    if (merge.rowSpan <= 1) return []
    if (at === start) return [{ ...merge, row: start - 1, rowSpan: merge.rowSpan - 1 }]
    return [{ ...merge, rowSpan: merge.rowSpan - 1 }]
  })
  return { ...model, rows, merges }
}

/** 在 `column` 处插入一列（表头与每行同步补空；对齐继承左邻、列宽继承左邻）。 */
export function insertColumn(model: TableModel, column: number): TableModel {
  const at = Math.max(0, Math.min(model.header.length, column))
  const header = [...model.header]
  header.splice(at, 0, '')
  const rows = model.rows.map((cells) => {
    const next = [...cells]
    next.splice(at, 0, '')
    return next
  })
  const align = [...model.align]
  align.splice(at, 0, align[at - 1] ?? null)
  const widths = [...model.widths]
  widths.splice(at, 0, widths[at - 1] ?? 0)
  const merges = (model.merges ?? []).map((merge) => {
    if (merge.col >= at) return { ...merge, col: merge.col + 1 }
    if (merge.col < at && merge.col + merge.colSpan > at) return { ...merge, colSpan: merge.colSpan + 1 }
    return merge
  })
  return { header, rows, align, merges, widths }
}

/** 删一列；最后一列不允许删。合并块随之收缩 / 平移。 */
export function deleteColumn(model: TableModel, column: number): TableModel {
  if (model.header.length <= 1) return model
  if (column < 0 || column >= model.header.length) return model
  const merges = (model.merges ?? []).flatMap((merge) => {
    const start = merge.col
    const end = merge.col + merge.colSpan - 1
    if (column > end) return [merge]
    if (column < start) return [{ ...merge, col: start - 1 }]
    if (merge.colSpan <= 1) return []
    if (column === start) return [{ ...merge, col: start - 1, colSpan: merge.colSpan - 1 }]
    return [{ ...merge, colSpan: merge.colSpan - 1 }]
  })
  return {
    header: model.header.filter((_, index) => index !== column),
    rows: model.rows.map((cells) => cells.filter((_, index) => index !== column)),
    align: model.align.filter((_, index) => index !== column),
    widths: model.widths.filter((_, index) => index !== column),
    merges,
  }
}

/** 设列对齐（GFM 的 `:--` / `:-:` / `--:`）。 */
export function setColumnAlign(model: TableModel, column: number, align: TableAlign): TableModel {
  if (column < 0 || column >= model.header.length) return model
  const next = [...model.align]
  next[column] = align
  return { ...model, align: next }
}
