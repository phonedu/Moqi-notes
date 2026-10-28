/** 时间与文本格式化：页面卡片头部、属性日期行、回收站剩余天数共用。 */

import { TRASH_RETENTION_DAYS } from '@moqi/editor'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 创建日期短标：09-21。 */
export function formatDayMonth(timestamp: number): string {
  const date = new Date(timestamp)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 完整日期：。 */
export function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** 完整日期时间： 14:30。 */
export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp)
  return `${formatDate(timestamp)} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 斜杠「插入」组的日期文本（`13-功能缺口总账` `G-E06`，）：`today` = ``、
 * `now` = ` 14:30`——插入一个**装着日期的普通文本块**（不加新块类型，`09` `R09-FMT-5` 组内）。
 */
export function insertDateText(kind: 'today' | 'now', now = Date.now()): string {
  return kind === 'today' ? formatDate(now) : formatDateTime(now)
}

/** 相对更新时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 9 月 18 日。 */
export function formatRelative(timestamp: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < MINUTE) return '刚刚'
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} 分钟前`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} 小时前`
  const days = Math.floor(elapsed / DAY)
  if (days === 1) return '昨天'
  if (days < 7) return `${days} 天前`
  const date = new Date(timestamp)
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

/** 回收站：删除于 N 天前的表述。 */
export function formatDeletedAgo(timestamp: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < HOUR) return '刚刚'
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} 小时前`
  return `${Math.floor(elapsed / DAY)} 天前`
}

/** 回收站：剩余保留天数（30 天自动彻底删除）。 */
export function remainingDays(timestamp: number, now = Date.now()): number {
  const used = Math.floor(Math.max(0, now - timestamp) / DAY)
  return Math.max(0, TRASH_RETENTION_DAYS - used)
}

export { TRASH_RETENTION_DAYS }

/** 卡片摘要：把一段文本压缩为适合卡片展示的单行文本。 */
export function clampText(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized
}

/** 字节数 → 「1.2 MB」这种显示（附件卡与灯箱共用）。 */
export function formatAssetSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}
