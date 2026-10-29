import type { LibraryCard, PropertyDef, PropertyValue } from './types'

/**
 * 页面库筛选与排序的**纯规则**（`docs/09` §4.2 `R09-FILT-3/4/8`）。
 *
 * 为什么单独成模块：筛选面板是「界面 + 一堆并发条件」，而**判据只有一份**——
 * 「这篇页面算不算命中」必须是可测的纯函数，不是散在 JSX 里的 if。面板只负责把条件画出来、
 * 把结果数说出来（`查看 N 条`），命中与排序在这里。
 *
 * 口径上的三处**明确决定**（规范没写死的地方，写在这里免得两边各猜一套）：
 * ① **标签多选是「或」**：含所选 = 命中其中**任一**（排除 = 一个都不含）。
 *    理由：标签 chips 是随手选的收窄/放宽手势，侧栏点一个标签也是同一套；要求「全含」会让
 *    多选几乎必然空结果（`R09-FILT-3` 只写了「模式：不限 / 含所选 / 排除所选」，没说合并方式）。
 * ② **属性之间是「与」、同一属性内多个选项是「或」**：选了「状态=进行中|草稿」和「优先级=高」
 *    就是「状态属于其一 且 优先级是 高」。这是属性筛选的常规语义。
 * ③ **关键词是「全部包含」**（`R09-FILT-4` 明文），大小写不敏感（中文无关、拉丁词友好）。
 *
 * 排序的默认值是 **null = 库的固有顺序**（`orderedRootIds`：置顶优先）。规范里那句
 * 「⇅ 编辑时间：从新到旧」是示例文案，不是默认值——页面库现在的默认顺序是 V2b 已验收过的行为，
 * 不能因为加了排序下拉就悄悄改掉（改默认顺序要单独裁决）。
 */
export type StarFilter = 'any' | 'starred' | 'unstarred'
export type TagMode = 'any' | 'include' | 'exclude'
export type TimeField = 'modified' | 'created'
export type TimeRange = 'any' | 'today' | 'week' | 'month' | 'thisMonth' | 'thisYear'
export type BacklinkFilter = 'any' | 'has' | 'none'
/** 排序档：三个固有字段 ＋ **按某个属性**（`属性区重规划（已归档）` §7.1-A4「排序扩一档」）。 */
export type SortField = 'modified' | 'created' | 'title' | 'property'
export type SortDirection = 'desc' | 'asc'

export type LibraryFilter = {
  star: StarFilter
  tagMode: TagMode
  tagIds: string[]
  timeField: TimeField
  timeRange: TimeRange
  /**
   * 高级筛选：每个属性一组条件；属性之间「与」、组内「或」。
   * `unset: true` = **未设置**（§A4「哪些页还没定状态」）：这一组要求该属性**没有值条目**
   * （口径与 `03-技术说明（数据与存储）`「值缺失表示未设置，与 `checkbox false` 不同」一致）。
   */
  propertyOptions: { defId: string; optionIds: string[]; unset?: boolean }[]
  /** 高级筛选：关键词（全部包含，大小写不敏感）。 */
  keywords: string[]
  backlinks: BacklinkFilter
  /** null = 库的固有顺序（置顶优先）；选定字段后按它排（`field: 'property'` 时看 `defId`）。 */
  sort: { field: SortField; defId?: string; direction: SortDirection } | null
}

export function emptyFilter(): LibraryFilter {
  return {
    star: 'any',
    tagMode: 'any',
    tagIds: [],
    timeField: 'modified',
    timeRange: 'any',
    propertyOptions: [],
    keywords: [],
    backlinks: 'any',
    sort: null,
  }
}

/** 有条件的项数——按钮上的徽章读它（`R09-FILT-7`）。排序不算「条件」。 */
export function activeFilterCount(filter: LibraryFilter): number {
  let count = filter.star !== 'any' ? 1 : 0
  if (filter.tagMode !== 'any' && filter.tagIds.length > 0) count += 1
  if (filter.timeRange !== 'any') count += 1
  count += filter.propertyOptions.filter((group) => group.optionIds.length > 0 || group.unset === true).length
  count += filter.keywords.length
  if (filter.backlinks !== 'any') count += 1
  return count
}

/** 时间窗口 `[from, to)`；不限时返回 null。`to` 取「现在」，未来的时间戳不算命中。 */
export function timeWindow(range: TimeRange, now: number): { from: number; to: number } | null {
  if (range === 'any') return null
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const midnight = start.getTime()
  const day = 24 * 60 * 60 * 1000
  switch (range) {
    case 'today': return { from: midnight, to: now }
    // 「近 7 天」按日历日算：今天零点往前推 6 天（含今天共 7 个日历日）——比滚动 168 小时更好解释、也更稳。
    case 'week': return { from: midnight - 6 * day, to: now }
    case 'month': return { from: midnight - 29 * day, to: now }
    case 'thisMonth': return { from: new Date(start.getFullYear(), start.getMonth(), 1).getTime(), to: now }
    case 'thisYear': return { from: new Date(start.getFullYear(), 0, 1).getTime(), to: now }
    default: return null
  }
}

/** 这篇卡片是否命中当前条件（不含排序）。 */
export function cardMatches(card: LibraryCard, filter: LibraryFilter, now: number): boolean {
  if (filter.star === 'starred' && !card.starred) return false
  if (filter.star === 'unstarred' && card.starred) return false

  if (filter.tagMode === 'include' && filter.tagIds.length > 0) {
    if (!filter.tagIds.some((tagId) => card.tagIds.includes(tagId))) return false
  }
  if (filter.tagMode === 'exclude' && filter.tagIds.length > 0) {
    if (filter.tagIds.some((tagId) => card.tagIds.includes(tagId))) return false
  }

  const window = timeWindow(filter.timeRange, now)
  if (window) {
    const at = filter.timeField === 'created' ? card.created : card.modified
    if (at < window.from || at > window.to) return false
  }

  for (const group of filter.propertyOptions) {
    const value = card.properties.find((item) => item.defId === group.defId)
    if (group.unset === true) {
      // 「未设置」（§A4）：**没有值条目**才命中——`checkbox false` 算已设置（数据册的口径）。
      if (value) return false
      continue
    }
    if (group.optionIds.length === 0) continue
    const optionId = value && value.type === 'select' ? value.optionId : null
    if (!optionId || !group.optionIds.includes(optionId)) return false
  }

  if (filter.keywords.length > 0) {
    const haystack = `${card.name}\n${card.paragraphs.join('\n')}`.toLowerCase()
    if (!filter.keywords.every((keyword) => haystack.includes(keyword.toLowerCase()))) return false
  }

  if (filter.backlinks === 'has' && card.backlinkCount === 0) return false
  if (filter.backlinks === 'none' && card.backlinkCount > 0) return false

  return true
}

/**
 * 筛选 + 排序。**置顶永远在最前**（V2b 的 `orderedRootIds` 语义）：排序只在组内生效——
 * 否则「我置顶的页面」会因为换个排序就不见了，那是用户没表达过的意图（`R09-FILT-8` 只说排序不改筛选）。
 */
/**
 * 属性排序的键：数字按**数值**、其余按**显示文本**（select 取选项名 / date / text 取原文 /
 * checkbox 已勾选在前）；**没有值时给 null**（排序时统一排最后，见 `applyLibraryFilter`）。
 */
export function propertySortKey(def: PropertyDef | undefined, value: PropertyValue | undefined): string | number | null {
  if (!def || !value) return null
  if (value.type === 'number') return value.value
  if (value.type === 'select') return def.options?.find((option) => option.id === value.optionId)?.label ?? ''
  if (value.type === 'checkbox') return value.value ? '1' : '0'
  return value.value
}

export function applyLibraryFilter(cards: LibraryCard[], filter: LibraryFilter, now = Date.now(), defs: PropertyDef[] = []): LibraryCard[] {
  const hits = cards.filter((card) => cardMatches(card, filter, now))
  const { sort } = filter
  const byPinned = (left: LibraryCard, right: LibraryCard) => Number(right.pinned) - Number(left.pinned)
  if (!sort) return hits.sort(byPinned)
  const direction = sort.direction === 'desc' ? -1 : 1
  const compare = (left: LibraryCard, right: LibraryCard): number => {
    if (sort.field === 'title') return left.name.localeCompare(right.name, 'zh-CN') * direction
    if (sort.field === 'property') {
      // 按属性排（§A4）：「未设置」的页面**不论升降都排最后**——「哪些还没填」扫一眼就在队尾。
      const def = defs.find((item) => item.id === sort.defId)
      const keyOf = (card: LibraryCard) => propertySortKey(def, card.properties.find((item) => item.defId === sort.defId))
      const leftKey = keyOf(left)
      const rightKey = keyOf(right)
      if (leftKey === null && rightKey === null) return left.name.localeCompare(right.name, 'zh-CN')
      if (leftKey === null) return 1
      if (rightKey === null) return -1
      const order = typeof leftKey === 'number' && typeof rightKey === 'number'
        ? leftKey - rightKey
        : String(leftKey).localeCompare(String(rightKey), 'zh-CN')
      return order * direction || left.name.localeCompare(right.name, 'zh-CN')
    }
    const at = (card: LibraryCard) => (sort.field === 'created' ? card.created : card.modified)
    return (at(left) - at(right)) * direction || left.name.localeCompare(right.name, 'zh-CN')
  }
  return hits.sort((left, right) => byPinned(left, right) || compare(left, right))
}

/**
 * 高级筛选区要画的属性行（`属性区重规划（已归档）` §7.1-A4）：**全部属性**——单选型给选项 chips ＋「未设置」，
 * 其余类型（文本 / 数字 / 日期 / 勾选）给「未设置」（原来只列单选型，文本/数字/日期的条件无从表达）。
 */
export function filterableProperties(defs: PropertyDef[]): PropertyDef[] {
  return defs.filter((def) => !def.disabled)
}

/**
 * 「筛这一列」（`属性区重规划（已归档）` §7.1-A3）：值 / 标签 chip 右键菜单拨出的那个条件——把这一组拨到
 * **defId = optionId**；再拨同一个值 = **撤掉整组**（与侧栏点同一个标签 = 取消，同一个做法）。
 */
export function pickPropertyOption(filter: LibraryFilter, defId: string, optionId: string): LibraryFilter {
  const group = filter.propertyOptions.find((item) => item.defId === defId)
  const picked = group?.optionIds.includes(optionId) ?? false
  const groups = filter.propertyOptions.filter((item) => item.defId !== defId)
  return { ...filter, propertyOptions: picked ? groups : [...groups, { defId, optionIds: [optionId] }] }
}
