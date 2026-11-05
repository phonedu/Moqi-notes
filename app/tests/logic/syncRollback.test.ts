import assert from 'node:assert/strict'
import test from 'node:test'

import { DomainStore } from '../../src/application/store'
import { createTextBlock } from '@moqi/editor'

/**
 * 同步回滚的水位语义：同步前记一个撤销栈水位，回滚只撤「水位之后全是同步事务」的那一段。
 * 中间夹过用户自己的编辑就拒绝——宁可让用户 ⌘Z 逐条撤，也不连带撤掉手写。
 */

function seeded(): { store: DomainStore; pageId: string; blockId: string } {
  const page = createTextBlock({ entityId: 'pg', blockUid: 'pg1', isObject: true, objectName: '页面' })
  const block = createTextBlock({ entityId: 'b1', blockUid: 'b1', text: '原文', parent: 'pg' })
  page.children = ['b1']
  const store = new DomainStore([page, block])
  return { store, pageId: 'pg', blockId: 'b1' }
}

const update = (blockId: string, text: string, source: 'user' | 'sync') => ({
  id: `${source}:${text}`,
  timestamp: Date.now(),
  source,
  operations: [{ type: 'update' as const, opId: `${source}:op:${text}`, blockId, changes: { content: [{ t: 'text' as const, v: text }] }, previous: {} }],
})

test('rollbackSyncSince：整段都是同步事务时整批撤回（同步改写的 N 块回到同步前）', () => {
  const { store, blockId } = seeded()
  const mark = store.undoMark()
  store.apply(update(blockId, '远端一', 'sync'))
  store.apply(update(blockId, '远端二', 'sync'))
  assert.equal(store.get(blockId)?.content[0].t === 'text' ? (store.get(blockId)!.content[0] as { v: string }).v : '', '远端二')

  assert.equal(store.rollbackSyncSince(mark), 2)
  const text = store.get(blockId)!.content[0]
  assert.equal(text.t === 'text' ? (text as { v: string }).v : '', '原文', '回到同步前的内容')
})

test('rollbackSyncSince：水位之后夹了用户编辑 → 拒绝（返回 -1，什么都不撤）', () => {
  const { store, blockId } = seeded()
  const mark = store.undoMark()
  store.apply(update(blockId, '远端', 'sync'))
  store.apply(update(blockId, '我自己的手写', 'user'))
  assert.equal(store.rollbackSyncSince(mark), -1)
  const text = store.get(blockId)!.content[0]
  assert.equal(text.t === 'text' ? (text as { v: string }).v : '', '我自己的手写', '拒绝时不许动任何内容')
})

test('rollbackSyncSince：水位之后没有事务 → 返回 -1（没有可回滚的）', () => {
  const { store } = seeded()
  assert.equal(store.rollbackSyncSince(store.undoMark()), -1)
})
