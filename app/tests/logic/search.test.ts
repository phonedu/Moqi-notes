import assert from 'node:assert/strict'
import test from 'node:test'
import { SEARCH_LIMIT } from '../../src/application/search'
import { substringHits } from '../../src/application/searchSubstring'
import { BrowserSearchPort, filterHits } from '../../src/adapters/search'
import type { Block, BlockMap, MetadataRegistry } from '@moqi/editor'

/**
 * 关键词检索的结果语义（`docs/03` §15.2、`09-桌面端交互规范` `R09-SEARCH-2/5`、`11` `SEARCH-GLOBAL-1`）。
 *
 * 这里锁的是**两条实现共用的那套语义**（桌面走 SQLite FTS5，浏览器与单测走 `substringHits`）：
 * 命中范围、排除已删、页面在前 + 按修改时间倒序、默认条数、筛选。`SEARCH-PARITY-1`（同一条查询
 * 两端结果一致）靠两份用例共同钉住：Rust 侧 `search_hits_*` 五条 + 这里。
 */
const block = (id: string, text: string, extra: Partial<Block> = {}): Block => ({
  entityId: id,
  blockUid: `${id}-uid`,
  type: 'text',
  content: [{ t: 'text', v: text }],
  parent: null,
  children: [],
  position: 0,
  collapsed: false,
  checked: false,
  deleted: false,
  deletedAt: null,
  prevParent: null,
  prevIndex: null,
  isObject: false,
  objectName: null,
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

const mapOf = (...blocks: Block[]): BlockMap => new Map(blocks.map((item) => [item.entityId, item]))

test('SEARCH-GLOBAL-1 中文子串搜得到：命中可以落在句子中间（R09-SEARCH-5）', () => {
  const blocks = mapOf(block('n1', '墨契是本地优先的双链笔记'))
  const hits = substringHits(blocks, '双链笔记')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].entityId, 'n1')
  assert.equal(hits[0].text, '墨契是本地优先的双链笔记')
})

test('SEARCH-GLOBAL-1 两字与单字查询也要命中（中文两字词太常见，不能只靠三字索引）', () => {
  const blocks = mapOf(block('n1', '墨契是本地优先的双链笔记'))
  assert.equal(substringHits(blocks, '双链').length, 1)
  assert.equal(substringHits(blocks, '墨').length, 1)
})

test('SEARCH-GLOBAL-1 页面按名字命中、结果排在块前面，且 text 给名字（R09-SEARCH-2 的分组依据）', () => {
  const page = block('p1', '', { isObject: true, objectName: '读书笔记', modified: 5 })
  const body = block('b1', '读书笔记里的一条正文', { parent: 'p1', modified: 99 })
  const hits = substringHits(mapOf(page, body), '读书')
  assert.equal(hits.length, 2)
  assert.equal(hits[0].entityId, 'p1')
  assert.equal(hits[0].isObject, true)
  assert.equal(hits[0].text, '读书笔记')
  assert.equal(hits[1].entityId, 'b1')
})

test('SEARCH-GLOBAL-1 已删的块不进结果；空查询不返回任何东西', () => {
  const blocks = mapOf(block('d1', '待删除的双链笔记', { deleted: true, deletedAt: 5 }), block('k1', '存活的块'))
  assert.equal(substringHits(blocks, '双链').length, 0)
  assert.equal(substringHits(blocks, '   ').length, 0)
  assert.equal(substringHits(blocks, '存活').length, 1)
})

test('SEARCH-GLOBAL-1 命中范围含标签与属性；筛选按块类型与标签 id（AND 语义）', () => {
  const blocks = mapOf(
    block('a', '正文里没有那个词', { tags: ['t-work'], properties: [{ defId: 'status', type: 'text', value: '进行中' }] }),
    block('b', '正文里有工作', { tags: ['t-work', 't-home'] }),
  )
  assert.equal(substringHits(blocks, '进行中').length, 1, '属性值也在命中范围里')
  assert.equal(substringHits(blocks, 't-work').length, 2, '标签 id 也在命中范围里')

  const all = substringHits(blocks, '工作')
  assert.equal(filterHits(all, { tags: ['t-work'] }).length, 1, '按标签 id 筛出一个')
  assert.equal(filterHits(all, { tags: ['t-work', 't-home'] }).length, 1, '两个标签都有的块仍在（b 同时挂了这两个）')
  assert.equal(filterHits(all, { tags: ['t-home', 't-missing'] }).length, 0, '缺一个就不算命中（AND 语义）')
  assert.equal(filterHits(substringHits(mapOf(block('c', '工作', { type: 'todo' }), block('d', '工作')), '工作'), { kinds: ['todo'] }).length, 1, '按块类型筛（todo）')
})

test('SEARCH-PROP-1 属性与标签按**名字**命中（A2：索引文本 =「属性名: 显示值」/ 标签名）', () => {
  const registry: MetadataRegistry = {
    properties: [{ id: 'status', name: '状态', type: 'select', created: 1, modified: 1, options: [{ id: 'o-doing', label: '进行中' }] }],
    tags: [{ id: 't-work', name: '工作', created: 1, modified: 1 }],
  }
  const blocks = mapOf(block('a', '正文里没有那两个词', {
    tags: ['t-work'],
    properties: [{ defId: 'status', type: 'select', optionId: 'o-doing' }],
  }))
  assert.equal(substringHits(blocks, '进行中', {}, registry).length, 1, '选项名可搜——此前索引里只有 optionId，搜不到')
  assert.equal(substringHits(blocks, '状态', {}, registry).length, 1, '属性名也可搜')
  assert.equal(substringHits(blocks, '状态: 进行中', {}, registry).length, 1, '「名称: 显示值」整串连着也能搜')
  assert.equal(substringHits(blocks, '工作', {}, registry).length, 1, '标签按名字命中')
  // 定义缺失时退回裸值（与 Rust 侧同一口径）：老库 / 专测数据也不丢命中。
  assert.equal(substringHits(blocks, '进行中').length, 0, '不给注册表时 select 只写 optionId——选项名搜不到')
  assert.equal(substringHits(blocks, 'o-doing').length, 1, '退回裸值的那份仍命中')
})

test('SEARCH-INDEX-1 端口如实报索引状态：浏览器通道说「memory-scan」、规模排除已删、不发明重建时间（R09-SEARCH-6）', async () => {
  const blocks = mapOf(block('a', '甲'), block('b', '乙'), block('c', '丙', { deleted: true, deletedAt: 5 }))
  const port = new BrowserSearchPort(() => blocks)
  const status = await port.status()
  assert.equal(status.engine, 'memory-scan', '浏览器通道没有索引，不许假装有')
  assert.equal(status.indexed, 2, '规模 = 存活块数（已删的不算）')
  assert.equal(status.rebuiltAt, null, '没有索引就没有「上次重建」，界面显示「不适用」')
  assert.equal(status.failures, 0, '内存扫描没有写入环节，失败恒为 0')
})

test('SEARCH-GLOBAL-1 默认条数封顶（界面一屏 + 滚动余量，两端一致）', () => {
  const many = mapOf(...Array.from({ length: SEARCH_LIMIT + 10 }, (_, index) => block(`k${index}`, `工作 ${index}`, { modified: index })))
  assert.equal(substringHits(many, '工作').length, SEARCH_LIMIT)
  assert.equal(substringHits(many, '工作', { limit: 3 }).length, 3)
  // 同分时按 modified 倒序：最新的在前（存储层的 SQL 也是这个序）。
  assert.equal(substringHits(many, '工作', { limit: 1 })[0].modified, SEARCH_LIMIT + 9)
})
