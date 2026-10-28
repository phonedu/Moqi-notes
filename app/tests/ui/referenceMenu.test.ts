import assert from 'node:assert/strict'
import test from 'node:test'
import { menuRows, type MenuRow } from '@moqi/editor'

/**
 * 候选菜单的行规则（台账 D-015，2026-10-04）。
 *
 * 这一层要钉住的是**信息不丢**：菜单同一页只出一行（精确候选与建议重复时不去重两遍），
 * 但那个页面**该带的理由不能因为「恰好也被搜到」就消失**——空查询时精确候选列出整库页面，
 * 建议会被全部吞掉，用户看到的就是一串没理由的字母序页面（用户 2026-10-04 实测）。
 */

type Row = Pick<MenuRow, 'targetId' | 'label' | 'hint' | 'reason' | 'group'>
const state = (results: { targetId: string; label: string; hint: string }[], suggestions: { pageId: string; name: string; reasonText: string; reason?: 'backlink' | 'tag' | 'title' | 'shared-ref' }[]) => ({
  blockId: 'b1',
  displayText: null,
  typed: '',
  offset: 0,
  kind: 'object' as const,
  trigger: '[[' as const,
  query: '',
  results,
  suggestions: suggestions.map((item) => ({ pageId: item.pageId, name: item.name, reason: item.reason ?? ('backlink' as const), reasonText: item.reasonText })),
})

test('D-015: 精确候选与建议是同一页时只出一行，但那行**保留理由**', () => {
  const rows: Row[] = menuRows(state(
    [{ targetId: 'p1', label: '双链笔记', hint: '空页面' }, { targetId: 'p2', label: '双链的另一种用法', hint: '用法举例' }],
    [{ pageId: 'p1', name: '双链笔记', reasonText: '已引用本篇' }],
  ))
  assert.equal(rows.length, 2, '同一个页面不出两行')
  assert.deepEqual(rows[0], { targetId: 'p1', label: '双链笔记', hint: '空页面', reason: '已引用本篇', group: 'exact' })
  assert.equal(rows[1].reason, undefined, '没被建议命中的候选照旧只有提示')
})

test('D-015: 建议分组条只画在**建议行**上（精确行带理由也不算建议区）', () => {
  const rows: Row[] = menuRows(state(
    [{ targetId: 'p1', label: '甲页', hint: '甲页的正文' }],
    [{ pageId: 'p1', name: '甲页', reasonText: '同标签' }, { pageId: 'p2', name: '乙页', reasonText: '同标签' }],
  ))
  assert.deepEqual(rows.map((row) => row.group), ['exact', 'suggest'], '分组条的位置只由 group 决定')
  assert.equal(rows.findIndex((row) => row.group === 'suggest'), 1)
  assert.equal(rows[0].reason, '同标签', '精确行照样带着理由')
})

test('D-015: 没有建议时行就是纯精确候选（提示照旧）', () => {
  const rows: Row[] = menuRows(state([{ targetId: 'p1', label: '甲页', hint: '甲页的正文' }], []))
  assert.deepEqual(rows, [{ targetId: 'p1', label: '甲页', hint: '甲页的正文', reason: undefined, group: 'exact' }])
})

test('D-015: 「标题命中」这条理由在精确候选行上不重复显示（用户打的字本来就匹配了页名）', () => {
  const rows: Row[] = menuRows(state(
    [{ targetId: 'p1', label: '产品路线', hint: '空页面' }],
    [{ pageId: 'p1', name: '产品路线', reason: 'title', reasonText: '标题含「产」' }],
  ))
  assert.equal(rows[0].reason, undefined, '精确候选行不再重复「标题含…」')
  assert.equal(rows[0].hint, '空页面', '提示照旧')
  // 纯建议行上它仍有信息量：解释这一行为什么被推荐
  const onlySuggestion: Row[] = menuRows(state([], [{ pageId: 'p2', name: '产品路线', reason: 'title', reasonText: '标题含「产」' }]))
  assert.equal(onlySuggestion[0].reason, '标题含「产」')
  assert.equal(onlySuggestion[0].group, 'suggest')
})
