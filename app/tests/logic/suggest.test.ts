import assert from 'node:assert/strict'
import test from 'node:test'
import { suggestReferences } from '@moqi/editor'
import type { Block, BlockMap } from '@moqi/editor'

/**
 * 双链建议 · 规则版（`docs/09` §6.2 `R09-BEDIT-5b`；行为 `SUGGEST-RULE-1` / `SUGGEST-FILTER-1`）。
 *
 * 这套规则给的是**候选 + 一个主要理由**（不给分数），所以断言要同时钉住「谁进候选」与
 * 「理由是哪一条」——理由错了，用户就没法核对，建议组就退化成噪音。
 */
const page = (id: string, name: string, extra: Partial<Block> = {}): Block => ({
  entityId: id,
  blockUid: `${id}-uid`,
  type: 'text',
  content: [],
  parent: null,
  children: [],
  position: 0,
  collapsed: false,
  checked: false,
  deleted: false,
  deletedAt: null,
  prevParent: null,
  prevIndex: null,
  isObject: true,
  objectName: name,
  pinned: false,
  starred: false,
  properties: [],
  propertyShown: [],
  propertyHidden: [],
  tags: [],
  asset: null,
  blockRefs: [],
  blockBackRefs: [],
  objectRefs: [],
  objectBackRefs: [],
  aiMeta: null,
  created: 1,
  modified: 1,
  ...extra,
})

const body = (id: string, parent: string, text: string, extra: Partial<Block> = {}): Block => ({
  ...page(id, '', { ...extra, isObject: false, objectName: null }),
  parent,
  content: [{ t: 'text', v: text }],
})

const mapOf = (...blocks: Block[]): BlockMap => new Map(blocks.map((item) => [item.entityId, item]))

test('SUGGEST-RULE-1 四条规则各出人、每条只带一个主要理由', () => {
  const blocks = mapOf(
    page('me', '我的笔记'),
    body('me-b1', 'me', '正文'),
    // 反链补全：它引用过本篇
    page('back', '引用者'),
    body('back-b1', 'back', '见 [[我的笔记]]', { objectRefs: ['me'] }),
    // 同标签
    page('tagged', '同标签页', { tags: ['t1'] }),
    page('me-tagged', '我的笔记', { tags: ['t1'] }),
    // 标题相似（查询命中）
    page('titled', '读书笔记'),
    // 同源：都引用了《产品路线》
    page('route', '产品路线'),
    page('same-source', '另一篇', { objectRefs: ['route'] }),
    page('me-source', '我的笔记', { objectRefs: ['route'] }),
  )
  // 当前页是 me：把它换成带标签/引用的版本，保证四条规则都有数据
  const me = blocks.get('me')!
  me.tags = ['t1']
  me.objectRefs = ['route']

  const none = suggestReferences({ blocks, fromId: 'me-b1', query: '' })
  const reasons = Object.fromEntries(none.map((item) => [item.pageId, item.reason]))
  assert.equal(reasons.back, 'backlink')
  assert.equal(reasons.tagged, 'tag')
  assert.equal(reasons['same-source'], 'shared-ref')

  const titled = suggestReferences({ blocks, fromId: 'me-b1', query: '读书' })
  const hit = titled.find((item) => item.pageId === 'titled')
  assert.equal(hit?.reason, 'title')
  assert.equal(hit?.reasonText, '标题含「读书」', '理由要带上用户打的字，能当场核对')

  // 反链那条的理由文案
  const back = none.find((item) => item.pageId === 'back')
  assert.equal(back?.reasonText, '已引用本篇')
  // 同源那条说清是哪一篇
  const shared = none.find((item) => item.pageId === 'same-source')
  assert.equal(shared?.reasonText, '都引用了《产品路线》')
})

test('SUGGEST-RULE-1 打了字时「标题命中」排最前（那是用户明确的意图），且每个页面只出一条', () => {
  const blocks = mapOf(
    page('me', '我的笔记', { tags: ['t1'] }),
    body('me-b1', 'me', '正文'),
    page('tagged-same-title', '读书笔记', { tags: ['t1'] }),
    page('back', '引用者'),
    body('back-b1', 'back', '见 [[我的笔记]]', { objectRefs: ['me'] }),
  )
  const list = suggestReferences({ blocks, fromId: 'me-b1', query: '读书' })
  assert.equal(list[0].pageId, 'tagged-same-title')
  assert.equal(list[0].reason, 'title', '既同标签又标题命中时，理由说标题（更贴近用户打的字）')
  assert.equal(new Set(list.map((item) => item.pageId)).size, list.length, '同一页面不许出现两次')
})

test('SUGGEST-FILTER-1 自引用与被删目标一律过滤', () => {
  const blocks = mapOf(
    page('me', '我的笔记', { tags: ['t1'] }),
    body('me-b1', 'me', '正文'),
    page('gone', '已删的同标签页', { tags: ['t1'], deleted: true, deletedAt: 5 }),
    page('alive', '存活的同标签页', { tags: ['t1'] }),
  )
  const list = suggestReferences({ blocks, fromId: 'me-b1', query: '' })
  assert.deepEqual(list.map((item) => item.pageId), ['alive'], '自己不出现在建议里；回收站里的也不出现')
})

test('SUGGEST-RULE-1 上限与稳定顺序：条数封顶（默认 5），同规则内按名字排', () => {
  const blocks = mapOf(
    page('me', '我的笔记', { tags: ['t1'] }),
    body('me-b1', 'me', '正文'),
    ...['丙', '甲', '乙', '丁', '戊', '己'].map((name, index) => page(`p${index}`, name, { tags: ['t1'] })),
  )
  const list = suggestReferences({ blocks, fromId: 'me-b1', query: '' })
  assert.equal(list.length, 5, '默认最多 5 条（建议组是「补充」，不是第二个候选列表）')
  // 同规则内按名字排（结果稳定，不随插入顺序抖）；zh-CN 排序按拼音：丙 bǐng < 丁 dīng < 己 jǐ < 甲 jiǎ < 戊 wù
  assert.deepEqual(list.map((item) => item.name), ['丙', '丁', '己', '甲', '戊'])
})

test('SUGGEST-RULE-1 光标在子块里也算「当前页」；不在任何页面里时不产建议', () => {
  const blocks = mapOf(
    page('me', '我的笔记', { tags: ['t1'], children: ['me-b1'] }),
    body('me-b1', 'me', '正文'),
    page('other', '同标签页', { tags: ['t1'] }),
    page('root-block', '散块', { isObject: false, objectName: null }),
  )
  assert.equal(suggestReferences({ blocks, fromId: 'me-b1', query: '' }).length, 1, '在子块里打字，按所属页面算')
  assert.equal(suggestReferences({ blocks, fromId: 'root-block', query: '' }).length, 0, '没有所属页面就不产建议')
})
