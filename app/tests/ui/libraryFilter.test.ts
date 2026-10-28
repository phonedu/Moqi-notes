import assert from 'node:assert/strict'
import test from 'node:test'
import { activeFilterCount, applyLibraryFilter, cardMatches, emptyFilter, filterableProperties, timeWindow } from '../../src/ui/libraryFilter'
import type { LibraryCard, PropertyDef } from '../../src/ui/types'

/**
 * 页面库筛选与排序的判据（`docs/09` §4.2 `R09-FILT-3/4/7/8`）。
 *
 * 面板只负责画与数，**判据全在这里**——所以规则要能被逐条测：命中语义、时间窗（按日历日）、
 * 置顶优先不会被排序打乱、徽章数只数条件不数排序。
 */
const card = (id: string, extra: Partial<LibraryCard> = {}): LibraryCard => ({
  id,
  name: id,
  paragraphs: [],
  createdLabel: '',
  updatedLabel: '',
  chips: [],
  backlinkCount: 0,
  pinned: false,
  starred: false,
  created: 1_700_000_000_000,
  modified: 1_700_000_000_000,
  tagIds: [],
  properties: [],
  ...extra,
})

// 固定「现在」： 15:00 本地时间，时间窗的断言才稳定。
const NOW = new Date(2026, 9, 4, 15, 0, 0).getTime()
const day = 24 * 60 * 60 * 1000

test('R09-FILT-3 标签多选是「或」：含所选 = 命中任一；排除 = 一个都不含', () => {
  const work = card('work', { tagIds: ['t-work'] })
  const life = card('life', { tagIds: ['t-life'] })
  const both = card('both', { tagIds: ['t-work', 't-life'] })
  const none = card('none')
  const cards = [work, life, both, none]

  const include = applyLibraryFilter(cards, { ...emptyFilter(), tagMode: 'include', tagIds: ['t-work'] }, NOW)
  assert.deepEqual(include.map((item) => item.id), ['work', 'both'])
  const includeTwo = applyLibraryFilter(cards, { ...emptyFilter(), tagMode: 'include', tagIds: ['t-work', 't-life'] }, NOW)
  assert.deepEqual(includeTwo.map((item) => item.id), ['work', 'life', 'both'], '选两个 = 命中任一，不是「全含」')
  const exclude = applyLibraryFilter(cards, { ...emptyFilter(), tagMode: 'exclude', tagIds: ['t-work', 't-life'] }, NOW)
  assert.deepEqual(exclude.map((item) => item.id), ['none'])
  // 模式是「不限」时，选中的标签不生效（不留下隐性条件）
  assert.equal(applyLibraryFilter(cards, { ...emptyFilter(), tagIds: ['t-work'] }, NOW).length, 4)
})

test('R09-FILT-3 时间范围按日历日算，且不含未来时间戳', () => {
  assert.deepEqual(timeWindow('any', NOW), null)
  assert.equal(timeWindow('today', NOW)?.from, new Date(2026, 9, 4, 0, 0, 0).getTime())
  assert.equal(timeWindow('week', NOW)?.from, new Date(2026, 9, 4, 0, 0, 0).getTime() - 6 * day, '近 7 天 = 含今天共 7 个日历日')
  assert.equal(timeWindow('thisMonth', NOW)?.from, new Date(2026, 9, 1, 0, 0, 0).getTime())
  assert.equal(timeWindow('thisYear', NOW)?.from, new Date(2026, 0, 1, 0, 0, 0).getTime())

  const fresh = card('fresh', { modified: NOW - 2 * 60 * 60 * 1000 })
  const old = card('old', { modified: NOW - 40 * day })
  const future = card('future', { modified: NOW + day })
  const cards = [fresh, old, future]
  assert.deepEqual(applyLibraryFilter(cards, { ...emptyFilter(), timeRange: 'today' }, NOW).map((item) => item.id), ['fresh'])
  assert.deepEqual(applyLibraryFilter(cards, { ...emptyFilter(), timeRange: 'thisYear' }, NOW).map((item) => item.id), ['fresh', 'old'])
  // 时间字段可切到「创建时间」
  const createdAt = card('byCreated', { created: NOW - day, modified: NOW - 40 * day })
  assert.equal(cardMatches(createdAt, { ...emptyFilter(), timeRange: 'week', timeField: 'created' }, NOW), true)
  assert.equal(cardMatches(createdAt, { ...emptyFilter(), timeRange: 'week', timeField: 'modified' }, NOW), false)
})

test('R09-FILT-4 属性之间「与」、同一属性内「或」；关键词全部包含且大小写不敏感', () => {
  const status = { defId: 'status', optionIds: ['doing', 'draft'] }
  const priority = { defId: 'priority', optionIds: ['high'] }
  const hit = card('hit', { properties: [{ defId: 'status', type: 'select', optionId: 'doing' }, { defId: 'priority', type: 'select', optionId: 'high' }] })
  const halfHit = card('half', { properties: [{ defId: 'status', type: 'select', optionId: 'doing' }] })
  const other = card('other', { properties: [{ defId: 'status', type: 'select', optionId: 'done' }, { defId: 'priority', type: 'select', optionId: 'high' }] })
  const cards = [hit, halfHit, other]
  assert.deepEqual(applyLibraryFilter(cards, { ...emptyFilter(), propertyOptions: [status] }, NOW).map((item) => item.id), ['hit', 'half'])
  assert.deepEqual(applyLibraryFilter(cards, { ...emptyFilter(), propertyOptions: [status, priority] }, NOW).map((item) => item.id), ['hit'])
  // 空的属性组不构成条件
  assert.equal(applyLibraryFilter(cards, { ...emptyFilter(), propertyOptions: [{ defId: 'status', optionIds: [] }, priority] }, NOW).length, 2)

  const kw = card('kw', { name: '副业探索 · 平台分发', paragraphs: ['周末做一个小工具试试看'] })
  assert.equal(cardMatches(kw, { ...emptyFilter(), keywords: ['副业'] }, NOW), true)
  assert.equal(cardMatches(kw, { ...emptyFilter(), keywords: ['副业', '小工具'] }, NOW), true, '多个关键词是「全部包含」')
  assert.equal(cardMatches(kw, { ...emptyFilter(), keywords: ['副业', '不存在'] }, NOW), false)
  assert.equal(cardMatches(kw, { ...emptyFilter(), keywords: ['PLATFORM'] }, NOW), false)
  assert.equal(cardMatches(card('latin', { name: 'Platform Notes' }), { ...emptyFilter(), keywords: ['platform'] }, NOW), true, '拉丁词大小写不敏感')
})

test('R09-FILT-3 星标三态与反链有无', () => {
  const starred = card('starred', { starred: true })
  const plain = card('plain', { backlinkCount: 3 })
  const cards = [starred, plain]
  assert.deepEqual(applyLibraryFilter(cards, { ...emptyFilter(), star: 'starred' }, NOW).map((item) => item.id), ['starred'])
  assert.deepEqual(applyLibraryFilter(cards, { ...emptyFilter(), star: 'unstarred' }, NOW).map((item) => item.id), ['plain'])
  assert.deepEqual(applyLibraryFilter(cards, { ...emptyFilter(), backlinks: 'has' }, NOW).map((item) => item.id), ['plain'])
  assert.deepEqual(applyLibraryFilter(cards, { ...emptyFilter(), backlinks: 'none' }, NOW).map((item) => item.id), ['starred'])
})

test('R09-FILT-8 排序：默认是库的固有顺序（置顶优先），选定字段后组内排序且置顶仍在最前', () => {
  const pinnedOld = card('pinned-old', { pinned: true, modified: NOW - 100 * day })
  const newer = card('newer', { modified: NOW - day })
  const older = card('older', { modified: NOW - 10 * day })
  const cards = [pinnedOld, newer, older]

  assert.deepEqual(applyLibraryFilter(cards, emptyFilter(), NOW).map((item) => item.id), ['pinned-old', 'newer', 'older'], '默认顺序不动（V2b 已验收的行为）')
  assert.deepEqual(
    applyLibraryFilter(cards, { ...emptyFilter(), sort: { field: 'modified', direction: 'desc' } }, NOW).map((item) => item.id),
    ['pinned-old', 'newer', 'older'],
  )
  assert.deepEqual(
    applyLibraryFilter(cards, { ...emptyFilter(), sort: { field: 'modified', direction: 'asc' } }, NOW).map((item) => item.id),
    ['pinned-old', 'older', 'newer'],
    '升序时置顶的仍在最前（排序只在组内生效）',
  )
  const title = [card('乙'), card('甲'), card('B'), card('a')]
  // zh-CN 的排序里**汉字排在拉丁字母之前**（按拼音：甲 jiǎ < 乙 yǐ）——实测确认后锁下来。
  assert.deepEqual(applyLibraryFilter(title, { ...emptyFilter(), sort: { field: 'title', direction: 'asc' } }, NOW).map((item) => item.id), ['甲', '乙', 'a', 'B'])
  assert.deepEqual(applyLibraryFilter(title, { ...emptyFilter(), sort: { field: 'title', direction: 'desc' } }, NOW).map((item) => item.id), ['B', 'a', '乙', '甲'])
})

test('R09-FILT-7 徽章只数「条件」：排序与未生效的标签选择都不算', () => {
  const filter = emptyFilter()
  assert.equal(activeFilterCount(filter), 0)
  assert.equal(activeFilterCount({ ...filter, sort: { field: 'title', direction: 'asc' } }), 0, '排序不是条件')
  assert.equal(activeFilterCount({ ...filter, tagIds: ['t1'] }), 0, '模式是「不限」时标签不算条件')
  assert.equal(activeFilterCount({ ...filter, tagMode: 'include', tagIds: ['t1'], star: 'starred' }), 2)
  assert.equal(activeFilterCount({ ...filter, keywords: ['a', 'b'], backlinks: 'has', timeRange: 'week' }), 4)
  assert.equal(activeFilterCount({ ...filter, propertyOptions: [{ defId: 'status', optionIds: ['doing'] }, { defId: 'x', optionIds: [] }] }), 1, '空组不算')
})

test('R09-FILT-4 / PROPS-FILTER-1 高级区画**全部属性**（单选给选项 chips ＋「未设置」；其余类型给「未设置」）', () => {
  const defs: PropertyDef[] = [
    { id: 'status', name: '状态', type: 'select', options: [{ id: 'doing', label: '进行中' }], created: 1, modified: 1 },
    { id: 'note', name: '备注', type: 'text', options: [], created: 1, modified: 1 },
    { id: 'dead', name: '停了', type: 'text', options: [], created: 1, modified: 1, disabled: true },
  ]
  assert.deepEqual(filterableProperties(defs).map((def) => def.id), ['status', 'note'], '停用的定义不进筛选区；文本属性也在（未设置条件）')
})

test('PROPS-FILTER-1 「未设置」条件：没有值条目才命中；`checkbox false` 算已设置（数据册口径）', () => {
  const withValue = card('with', { properties: [{ defId: 'status', type: 'select', optionId: 'doing' }] })
  const unset = card('unset', { properties: [] })
  const checkboxFalse = card('cb', { properties: [{ defId: 'done', type: 'checkbox', value: false }] })
  const cards = [withValue, unset, checkboxFalse]
  const unsetStatus = { defId: 'status', optionIds: [], unset: true }
  const unsetDone = { defId: 'done', optionIds: [], unset: true }
  assert.deepEqual(applyLibraryFilter(cards, { ...emptyFilter(), propertyOptions: [unsetStatus] }, NOW).map((item) => item.id), ['unset', 'cb'])
  assert.deepEqual(applyLibraryFilter(cards, { ...emptyFilter(), propertyOptions: [unsetDone] }, NOW).map((item) => item.id), ['with', 'unset'], '`checkbox false` 是「已设置」')
})

test('PROPS-SORT-1 按属性排序：数字按数值、文本按中文显示值；**未设置排最后**（不论升降）', () => {
  const defs: PropertyDef[] = [
    { id: 'score', name: '分数', type: 'number', created: 1, modified: 1 },
    { id: 'note', name: '备注', type: 'text', created: 1, modified: 1 },
  ]
  const cards = [
    card('b', { properties: [{ defId: 'score', type: 'number', value: 2 }] }),
    card('a', { properties: [{ defId: 'score', type: 'number', value: 10 }] }),
    card('none', { properties: [] }),
  ]
  const desc = applyLibraryFilter(cards, { ...emptyFilter(), sort: { field: 'property', defId: 'score', direction: 'desc' } }, NOW, defs).map((item) => item.id)
  assert.deepEqual(desc, ['a', 'b', 'none'], '数字按数值（10 > 2）且未设置排最后')
  const asc = applyLibraryFilter(cards, { ...emptyFilter(), sort: { field: 'property', defId: 'score', direction: 'asc' } }, NOW, defs).map((item) => item.id)
  assert.deepEqual(asc, ['b', 'a', 'none'], '升序里未设置**仍然**在最后')
  const byText = [card('x', { properties: [{ defId: 'note', type: 'text', value: '乙' }] }), card('y', { properties: [{ defId: 'note', type: 'text', value: '甲' }] })]
  assert.deepEqual(applyLibraryFilter(byText, { ...emptyFilter(), sort: { field: 'property', defId: 'note', direction: 'asc' } }, NOW, defs).map((item) => item.id), ['y', 'x'], '文本按中文显示值排（甲 < 乙）')
})
