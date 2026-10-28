import { textContent, type Block } from './block'

export type HeatmapLevel = 0 | 1 | 2 | 3 | 4

export type HeatmapDay = {
  /** 本地日期 `YYYY-MM-DD`（tooltip 与测试用）。 */
  key: string
  /** 当天有改动的页面数；同一页面的多个块只算一次。 */
  count: number
  level: HeatmapLevel
  /** 当前周里今天之后的格子：只占位，不参与统计。 */
  future: boolean
}

export type HeatmapWeek = HeatmapDay[]

export type SidebarStats = {
  pages: number
  tags: number
  chars: number
  weeks: HeatmapWeek[]
  activeDays: number
  peak: number
}

const WEEK_COUNT = 12
const DAYS_PER_WEEK = 7

function startOfDay(timestamp: number): Date {
  const date = new Date(timestamp)
  date.setHours(0, 0, 0, 0)
  return date
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  next.setHours(0, 0, 0, 0)
  return next
}

function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function levelFor(count: number): HeatmapLevel {
  if (count === 0) return 0
  if (count === 1) return 1
  if (count <= 3) return 2
  if (count <= 7) return 3
  return 4
}

/** 页面数 / 标签数 / 正文字符数。只算未删除的块；标签按 id 去重。 */
export function summarizeBlocks(blocks: Iterable<Block>): Pick<SidebarStats, 'pages' | 'tags' | 'chars'> {
  let pages = 0
  let chars = 0
  const tags = new Set<string>()
  for (const block of blocks) {
    if (block.deleted) continue
    if (block.isObject) pages += 1
    for (const tagId of block.tags) tags.add(tagId)
    chars += Array.from(textContent(block)).length
  }
  return { pages, tags: tags.size, chars }
}

/**
 * 近 12 周热力图：一格 = 一天，颜色 = 当天有改动的页面数。
 *
 * 只认 `modified`（新建也算一次修改）；同一页面的多个块当天有改动只算一次。
 * 这是「页面活跃度」，不是完整编辑历史——块只保留最后一次修改时间，无法还原更早的改动。
 */
export function heatmapWeeks(
  blocks: Iterable<Block>,
  now = Date.now(),
  weeks = WEEK_COUNT,
): { weeks: HeatmapWeek[]; activeDays: number; peak: number } {
  const list = [...blocks]
  const byId = new Map(list.map((block) => [block.entityId, block]))
  const pageOf = (block: Block): string | null => {
    let cursor: Block | undefined = block
    const seen = new Set<string>()
    while (cursor) {
      if (cursor.isObject) return cursor.deleted ? null : cursor.entityId
      if (!cursor.parent || seen.has(cursor.entityId)) return null
      seen.add(cursor.entityId)
      cursor = byId.get(cursor.parent)
    }
    return null
  }
  const pagesByDay = new Map<string, Set<string>>()
  for (const block of list) {
    if (block.deleted) continue
    const pageId = pageOf(block)
    if (!pageId) continue
    const key = dayKey(startOfDay(block.modified || block.created))
    const set = pagesByDay.get(key)
    if (set) set.add(pageId)
    else pagesByDay.set(key, new Set([pageId]))
  }

  const today = startOfDay(now)
  const weekday = (today.getDay() + 6) % 7 // 一 = 0 … 日 = 6
  const end = addDays(today, DAYS_PER_WEEK - 1 - weekday)
  const start = addDays(end, -(weeks * DAYS_PER_WEEK - 1))
  let activeDays = 0
  let peak = 0
  const grid: HeatmapWeek[] = []
  for (let week = 0; week < weeks; week += 1) {
    const days: HeatmapDay[] = []
    for (let offset = 0; offset < DAYS_PER_WEEK; offset += 1) {
      const date = addDays(start, week * DAYS_PER_WEEK + offset)
      const future = date.getTime() > today.getTime()
      const key = dayKey(date)
      const count = future ? 0 : (pagesByDay.get(key)?.size ?? 0)
      if (count > 0) activeDays += 1
      peak = Math.max(peak, count)
      days.push({ key, count, level: levelFor(count), future })
    }
    grid.push(days)
  }
  return { weeks: grid, activeDays, peak }
}

export function buildSidebarStats(blocks: Iterable<Block>, now = Date.now()): SidebarStats {
  const list = [...blocks]
  return { ...summarizeBlocks(list), ...heatmapWeeks(list, now) }
}

/** 统计数字简写：<1000 原样；千位 `1.2k`；万位 `1.2万`；亿位 `1.2亿`。 */
export function formatCompactCount(value: number): string {
  const n = Math.max(0, Math.round(value))
  if (n < 1_000) return String(n)
  const compact = (number: number, unit: string) => `${number.toFixed(1).replace(/\.0$/, '')}${unit}`
  if (n < 10_000) return compact(n / 1_000, 'k')
  if (n < 100_000_000) return compact(n / 10_000, '万')
  return compact(n / 100_000_000, '亿')
}
