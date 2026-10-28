import assert from 'node:assert/strict'
import test from 'node:test'
import { createTextBlock } from '../src/domain/block'
import { createMemoryEditorHost } from '../src/editor/memoryHost'

/** 内存宿主（M3 件）：load/save/read/writes/reset 的循环契约。 */

const seed = () => [createTextBlock({ entityId: 'p1', blockUid: 'p0000001', text: '甲', isObject: true, objectName: '页' })]

test('memoryHost：load 空库回 null；save 落副本再 load 拿回', async () => {
  const host = createMemoryEditorHost([])
  assert.equal(await host.storage.load(), null, '空库 = null（编辑器建空白页）')
  const blocks = seed()
  await host.storage.save(blocks)
  assert.equal(host.writes, 1)
  const back = await host.storage.load()
  assert.equal(back?.length, 1)
  assert.equal(back?.[0].objectName, '页')
  // 落盘是副本：外部改原数组不回灌
  blocks[0].objectName = '改过'
  assert.equal((await host.storage.load())?.[0].objectName, '页')
})

test('memoryHost：reset 回种子并清计数', async () => {
  const host = createMemoryEditorHost(seed())
  const first = await host.storage.load()
  assert.equal(first?.length, 1)
  await host.storage.save([])
  assert.equal(host.writes, 1)
  host.reset(seed())
  assert.equal(host.writes, 0, 'reset 不计落盘')
  assert.equal((await host.storage.load())?.length, 1, 'reset 显式给种子')
})
