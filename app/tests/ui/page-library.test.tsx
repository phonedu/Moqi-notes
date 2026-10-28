import test from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { PageLibraryView } from '../../src/ui/PageLibraryView'
import { planBlockDelete } from '../../src/ui/deleteGuard'
import { createTextBlock } from '@moqi/editor'
import type { LibraryCard } from '../../src/ui/types'

const cards: LibraryCard[] = [{
  id: 'p1',
  name: '副业探索',
  paragraphs: ['约束条件：每周可投入时间 ≤ 10 小时。', '方向一：独立开发。'],
  createdLabel: '09-21',
  updatedLabel: '3 小时前',
  backlinkCount: 2,
  pinned: false,
  starred: false,
  created: 1_700_000_000_000,
  modified: 1_700_000_000_000,
  tagIds: ['tag-1'],
  properties: [{ defId: 'status', type: 'select', optionId: 'doing' }],
}]

function render(props: Partial<Parameters<typeof PageLibraryView>[0]> = {}) {
  return renderToStaticMarkup(
    <PageLibraryView
      cards={cards}
      activeTagName={null}
      onClearFilter={() => undefined}
      onOpen={() => undefined}
      onCreate={() => undefined}
      onCardMenu={() => undefined}
      onToggleStar={() => undefined}
      onSearch={() => undefined}
      onFilter={() => undefined}
      filterCount={0}
      mode="list"
      onModeChange={() => undefined}
      {...props}
    />,
  )
}

test('页面库头部：页名 + 搜索 + 筛选（视图切换已收掉）', () => {
  const markup = render({ mode: 'list' })
  const header = markup.split('lib-stack')[0]
  assert.match(header, /class="pc-title"/)
  assert.match(header, /全部页面/)
  assert.doesNotMatch(header, /class="lib-switch"/, '视图切换不再占头部')
  assert.match(markup, /全局搜索（⌘K）/)
  assert.match(markup, /aria-label="筛选"/)
  assert.doesNotMatch(header, /后续版本/, '头部这两个入口都已实现')
  assert.doesNotMatch(markup, /折叠或展开侧栏/, '头部不再有侧栏开关')
})

test('R09-FILT-7 筛选按钮上的条件数徽章：没有条件时不显示，有条件时显示条数', () => {
  assert.doesNotMatch(render({ mode: 'list', filterCount: 0 }), /已设 \d+ 个条件/)
  const withTwo = render({ mode: 'list', filterCount: 2 })
  assert.match(withTwo, /已设 2 个条件/)
  assert.match(withTwo, /class="bdg"/)
})

test('页面卡片：时间 + 标题 + 两行摘要（无创建日期 / 属性行 / 反链行）', () => {
  const markup = render()
  assert.match(markup, /3 小时前/)
  assert.doesNotMatch(markup, /创建于 09-21/, '列表只留更新时间')
  assert.match(markup, /副业探索 更多操作/)
  assert.match(markup, /打开页面 副业探索/)
  assert.match(markup, /约束条件/)
  assert.match(markup, /cnt clamp/)
  assert.doesNotMatch(markup, /attr kv|状态 · 进行中|#副业/, '卡片不再重复属性 / 标签')
  assert.doesNotMatch(markup, /2 条反向链接/, '列表不再挂反链行')
})

test('无反链的页面不渲染反链行', () => {
  const markup = render({ cards: [{ ...cards[0], backlinkCount: 0 }] })
  assert.doesNotMatch(markup, /条反向链接/)
})

test('标签筛选态显示可清除的筛选胶囊与筛选空态', () => {
  const markup = render({ activeTagName: '副业' })
  assert.match(markup, /#副业/)
  assert.match(markup, /清除标签筛选/)

  const empty = render({ cards: [], activeTagName: '副业' })
  assert.match(empty, /该筛选下暂无页面/)
  assert.match(empty, /清除全部筛选/)
})

test('无页面时给出新建引导，两类空态互不混用', () => {
  const markup = render({ cards: [] })
  assert.match(markup, /还没有页面/)
  assert.match(markup, /新建页面/)
  assert.doesNotMatch(markup, /清除全部筛选/)
})

test('LIB-VIEW-1 页面库只保留列表形态，视图切换器已移除', () => {
  const markup = render({ mode: 'list' })
  assert.doesNotMatch(markup, /class="lib-switch"/)
  assert.doesNotMatch(markup, />画册</, '不应再有画册')
  assert.doesNotMatch(markup, /class="pcard"/)
})

test('列表卡片：时间 + 标题 + 两行摘要；不再有展开 / 收起', () => {
  const markup = render({ mode: 'list', activePageId: 'p1' })
  assert.match(markup, /class="lcard[^"]*cur"/, '当前页在列表里高亮')
  assert.match(markup, /3 小时前/)
  assert.match(markup, /副业探索 更多操作/)
  assert.match(markup, /打开页面 副业探索/)
  assert.match(markup, /cnt clamp/)
  const cards = markup.slice(markup.indexOf('lib-stack'))
  assert.doesNotMatch(cards, /class="cwrap"/)
  assert.doesNotMatch(cards, /expb|clps/)
  assert.doesNotMatch(cards, /展开|收起/)
})

test('简约卡片：紧凑行，不再带属性行', () => {
  const markup = render({ mode: 'compact', activePageId: 'p1' })
  assert.match(markup, /class="scard[^"]*cur"/)
  assert.match(markup, /副业探索 更多操作/)
  assert.doesNotMatch(markup, /状态 · 进行中/)
  assert.doesNotMatch(markup.slice(markup.indexOf('lib-stack')), /expb|clps|展开|收起/)
})

test('页面列形态：一排搞定（页名 + 搜索 + 筛选），没有侧栏开关与折叠箭头', () => {
  const markup = render({ mode: 'list' })
  assert.match(markup, /class="pagecol-head"/)
  assert.match(markup, /class="pc-title"/)
  assert.doesNotMatch(markup, /class="lib-switch"/)
  assert.doesNotMatch(markup, /折叠或展开侧栏/)
  assert.doesNotMatch(markup, /col-fold/
)
})

test('LIB-FADE-1 截断不做渐隐遮罩（2026-10-09 用户裁决「直接截断」；ID 沿用，语义改为"任何状态下都不出现渐隐"）', () => {
  const list = render({ mode: 'list' })
  assert.doesNotMatch(list, /is-fade/, '列表卡不再有渐隐层')
  assert.match(list, /cnt clamp/, '截断仍走 clamp（`-webkit-line-clamp`）')
  const compact = render({ mode: 'compact' })
  assert.doesNotMatch(compact, /is-fade/, '简约卡同理')
  assert.match(compact, /cnt clamp/)
})

test('planBlockDelete：单块直接删，多块 / 带子块弹确认，引用数随目标算', () => {
  const child = createTextBlock({ entityId: 'child', blockUid: 'b1' })
  const parent = createTextBlock({ entityId: 'parent', blockUid: 'b2' })
  parent.children = ['child']
  const source = createTextBlock({ entityId: 'source', blockUid: 'b3' })
  source.objectRefs = ['parent']
  const blocks = new Map([[child.entityId, child], [parent.entityId, parent], [source.entityId, source]])
  const get = (id: string) => blocks.get(id)

  assert.deepEqual(planBlockDelete(['child'], get, blocks), { count: 1, refs: 0, hasChildren: false, needsConfirm: false })
  const withChild = planBlockDelete(['parent'], get, blocks)
  assert.equal(withChild.hasChildren, true)
  assert.equal(withChild.needsConfirm, true)
  assert.equal(withChild.refs, 1)
  const many = planBlockDelete(['child', 'source'], get, blocks)
  assert.equal(many.count, 2)
  assert.equal(many.needsConfirm, true)
  assert.equal(planBlockDelete([], get, blocks).needsConfirm, false)
})
