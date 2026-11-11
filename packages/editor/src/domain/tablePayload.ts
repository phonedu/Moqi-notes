import {
  parseTable,
  serializeTable,
  type TableAlign,
  type TableMerge,
  type TableModel,
} from './tableModel'

/** 表格 payload 的版本；形状变更时按版本迁移。 */
export const TABLE_PAYLOAD_VERSION = 1

/**
 * 表格块的持久化网格（试点）。
 *
 * 与 `tableModel` 的分工：`tableModel` 是纯网格运算；本模块规定**进 Block 的形状**。
 * `source` 保存导入时的原始 Markdown（导出逐字节）；结构化编辑后清空，导出改用规范序列化。
 * 文本视图仍可编辑 —— 改动会重新走 `tablePayloadFromText`，payload 只是同一份数据的网格态。
 */
export type TablePayload = {
  version: typeof TABLE_PAYLOAD_VERSION
  header: string[]
  rows: string[][]
  align: TableAlign[]
  merges: TableMerge[]
  widths: number[]
  /** 导入时的原始 Markdown；结构化编辑后清空。 */
  source?: string
}

/** 文本 → payload：不是合法管道表时 null（旧行为：文本照旧，不建网格）。 */
export function tablePayloadFromText(text: string): TablePayload | null {
  const model = parseTable(text)
  if (!model) return null
  return { version: TABLE_PAYLOAD_VERSION, ...model, source: text }
}

/** 载入校验：形状不对一律当没有（文本仍是真相）。 */
export function isTablePayload(value: unknown): value is TablePayload {
  if (!value || typeof value !== 'object') return false
  const payload = value as Partial<TablePayload>
  if (payload.version !== TABLE_PAYLOAD_VERSION) return false
  if (!Array.isArray(payload.header) || payload.header.length === 0) return false
  if (!payload.header.every((cell) => typeof cell === 'string')) return false
  if (
    !Array.isArray(payload.rows) ||
    !payload.rows.every(
      (row) => Array.isArray(row) && row.every((cell) => typeof cell === 'string'),
    )
  ) {
    return false
  }
  if (
    !Array.isArray(payload.align) ||
    !payload.align.every(
      (align) =>
        align === null || align === 'left' || align === 'center' || align === 'right',
    )
  ) {
    return false
  }
  if (
    !Array.isArray(payload.merges) ||
    !payload.merges.every(
      (merge) =>
        merge !== null &&
        typeof merge === 'object' &&
        typeof merge.row === 'number' &&
        typeof merge.col === 'number' &&
        typeof merge.rowSpan === 'number' &&
        typeof merge.colSpan === 'number',
    )
  ) {
    return false
  }
  if (
    !Array.isArray(payload.widths) ||
    !payload.widths.every((width) => typeof width === 'number' && Number.isFinite(width))
  ) {
    return false
  }
  if (payload.source !== undefined && typeof payload.source !== 'string') return false
  return true
}

/** payload → 内存网格：按表头列数补齐行宽 / 对齐 / 列宽，坏数据不进运算。 */
export function tablePayloadToModel(payload: TablePayload): TableModel {
  const columns = payload.header.length
  const rows = payload.rows.map((row) => {
    const cells = row.slice(0, columns)
    while (cells.length < columns) cells.push('')
    return cells
  })
  const align = payload.align.slice(0, columns)
  while (align.length < columns) align.push(null)
  const widths = payload.widths.slice(0, columns)
  while (widths.length < columns) widths.push(0)
  return {
    header: payload.header.slice(),
    rows,
    align,
    merges: payload.merges.map((merge) => ({ ...merge })),
    widths,
  }
}

/** payload → 文本：有 source 时逐字节原样；编辑后走规范序列化。 */
export function tablePayloadToText(payload: TablePayload): string {
  if (typeof payload.source === 'string') return payload.source
  return serializeTable(tablePayloadToModel(payload))
}

/** 一次结构化编辑之后：清掉 source，文本改由规范序列化投影。 */
export function tablePayloadAfterEdit(model: TableModel): TablePayload {
  return { version: TABLE_PAYLOAD_VERSION, ...model }
}
