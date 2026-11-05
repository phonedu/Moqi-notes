/**
 * 富表格的**数据模型**（纯函数）：Markdown 管道表 ⇄ 网格。
 *
 * 真相仍是块的正文文本（Markdown 管道表）——富表格视图是它的编辑器，每次改动都重新序列化回文本。
 * 这样做的三个好处：① 导出/导入仍走同一条逐字节通道（不新增块类型、不改存储）；② 源码视图永远可用；
 * ③ 合并单元格/列宽这类 Markdown 表达不了的属性，后续以**旁注注释**存在表外，不污染表格本体。
 *
 * 边界：GFM 口径——表头行 + 分隔行必有（GFM 规定如此，所以不做「有无表头」开关），
 * 列对齐支持 `:--` / `:-:` / `--:`；单元格内的 `|` 用 `\|` 写入、读回时还原。
 */

export type TableAlign = 'left' | 'center' | 'right' | null

export type TableModel = {
  /** 表头（第一行）。 */
  header: string[]
  /** 数据行；每行长度与 `header` 对齐（读入时按需补空 / 截断）。 */
  rows: string[][]
  /** 每列的对齐方式（长度与 `header` 一致）。 */
  align: TableAlign[]
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

/** 文本 → 网格。不是合法管道表（缺分隔行 / 空表）时返回 null。 */
export function parseTable(text: string): TableModel | null {
  const lines = text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
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
  return { header, rows, align }
}

/** 网格 → 文本（规范形态：单元格两侧各一空格、分隔行按对齐写）。 */
export function serializeTable(model: TableModel): string {
  const escape = (cell: string) => cell.replaceAll('|', '\\|')
  const line = (cells: string[]) => `| ${cells.map(escape).join(' | ')} |`
  const separator = `| ${model.align.map(separatorOf).join(' | ')} |`
  return [line(model.header), separator, ...model.rows.map(line)].join('\n')
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
    next[column] = value
    return next
  })
  return { ...model, rows }
}

/** 在 `index` 处插入一个空行（`index` 以数据行计；0 = 表头之下第一行）。 */
export function insertRow(model: TableModel, index: number): TableModel {
  const rows = [...model.rows]
  const at = Math.max(0, Math.min(rows.length, index))
  rows.splice(at, 0, model.header.map(() => ''))
  return { ...model, rows }
}

/** 删一行数据行；只剩最后一行时删除后保留空表（`|  |` 形态由序列化补）。 */
export function deleteRow(model: TableModel, index: number): TableModel {
  if (index < 0 || index >= model.rows.length) return model
  const rows = model.rows.filter((_, rowIndex) => rowIndex !== index)
  return { ...model, rows }
}

/** 在 `column` 处插入一列（表头与每行同步补空；对齐默认继承左邻）。 */
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
  return { header, rows, align }
}

/** 删一列；最后一列不允许删（表格至少一列）。 */
export function deleteColumn(model: TableModel, column: number): TableModel {
  if (model.header.length <= 1) return model
  if (column < 0 || column >= model.header.length) return model
  return {
    header: model.header.filter((_, index) => index !== column),
    rows: model.rows.map((cells) => cells.filter((_, index) => index !== column)),
    align: model.align.filter((_, index) => index !== column),
  }
}

/** 设列对齐（GFM 的 `:--` / `:-:` / `--:`）。 */
export function setColumnAlign(model: TableModel, column: number, align: TableAlign): TableModel {
  if (column < 0 || column >= model.header.length) return model
  const next = [...model.align]
  next[column] = align
  return { ...model, align: next }
}
