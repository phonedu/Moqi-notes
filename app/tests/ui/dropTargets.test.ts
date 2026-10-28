import assert from 'node:assert/strict'
import test from 'node:test'
import { createTextBlock } from '@moqi/editor'
import type { Block, BlockMap } from '@moqi/editor'
import { resolveDropDestination } from '@moqi/editor'

/** page → a, b（b → c）；正文块与页面容器同层。 */
function document(): BlockMap {
  const page = createTextBlock({ entityId: 'page', blockUid: 'page0001', text: '页面', isObject: true, objectName: '页面' })
  const a = createTextBlock({ entityId: 'a', blockUid: 'a0000001', text: 'A', parent: 'page' })
  const b = createTextBlock({ entityId: 'b', blockUid: 'b0000001', text: 'B', parent: 'page' })
  const c = createTextBlock({ entityId: 'c', blockUid: 'c0000001', text: 'C', parent: 'b' })
  page.children = ['a', 'b']
  b.children = ['c']
  const blocks: BlockMap = new Map<string, Block>()
  for (const block of [page, a, b, c]) blocks.set(block.entityId, block)
  return blocks
}

test('落点：同层前后按兄弟顺序解析', () => {
  const blocks = document()
  assert.deepEqual(resolveDropDestination(blocks, 'c', 'a', 'after'), { parentId: 'page', index: 1 })
  assert.deepEqual(resolveDropDestination(blocks, 'c', 'a', 'before'), { parentId: 'page', index: 0 })
})

test('落点：into 追加为最后一个子块，且不把自己算进索引', () => {
  const blocks = document()
  assert.deepEqual(resolveDropDestination(blocks, 'a', 'b', 'into'), { parentId: 'b', index: 1 })
  const own = resolveDropDestination(blocks, 'c', 'b', 'into')
  assert.deepEqual(own, { parentId: 'b', index: 0 }, '已经在 b 里的块不该被算进子块索引')
})

test('BLOCK-DRAG-3 落点：根块（页面容器）只接受 into，前后都是无效落点', () => {
  // 页面容器是页面本身：前后落点会在领域里生成新的根块，等于把正文块移出本篇。
  const blocks = document()
  assert.equal(resolveDropDestination(blocks, 'a', 'page', 'before'), null)
  assert.equal(resolveDropDestination(blocks, 'a', 'page', 'after'), null)
  assert.deepEqual(resolveDropDestination(blocks, 'a', 'page', 'into'), { parentId: 'page', index: 1 })
})

test('落点：自身与自身后代都无效（不成环）', () => {
  const blocks = document()
  assert.equal(resolveDropDestination(blocks, 'b', 'b', 'into'), null)
  assert.equal(resolveDropDestination(blocks, 'b', 'c', 'into'), null)
  assert.equal(resolveDropDestination(blocks, 'b', 'c', 'after'), null)
  assert.equal(resolveDropDestination(blocks, 'missing', 'a', 'into'), null)
})
