import assert from 'node:assert/strict'
import test from 'node:test'

import { DomainStore } from '../../src/application/store'
import { createTextBlock, instantiateTemplate, markTemplate, validateBlockGraph, type Block, type BlockMap } from '@moqi/editor'

/**
 * 页面模板（0.7 复利线第一刀）：模板 = **被标记的普通页面**，不新增块类型。
 * 「从模板创建」按三件应用：① 属性预设 ② 内容复制（**仅空实例**）③ 子结构深复制。
 *
 * 这里钉四件事：标记是页面级 update op（二次调用 no-op、非页面拒绝）；空页三件全带过来
 * （id 全换新、内部行内引用改指副本）；**非空页只带属性预设、正文一字不动**（负例）；
 * store 的「从模板创建」是**一个事务**（一次撤销回到没有这一页）。
 */

function page(id: string, name: string, extra: Partial<Block> = {}): Block {
  return { ...createTextBlock({ entityId: id, blockUid: `u-${id}`, isObject: true, objectName: name }), ...extra }
}

function child(id: string, text: string, parent: string, position: number, extra: Partial<Block> = {}): Block {
  return { ...createTextBlock({ entityId: id, blockUid: `u-${id}`, text, parent }), position, ...extra }
}

function graphOf(...blocks: Block[]): BlockMap {
  return new Map(blocks.map((block) => [block.entityId, block]))
}

test('markTemplate：页面级 update op；二次调用 no-op；非页面拒绝', () => {
  const blocks = graphOf(page('tpl', '日记模板'), child('c1', '正文', 'tpl', 0))
  const transaction = markTemplate(blocks, 'tpl', true)
  assert.ok(transaction)
  assert.equal(transaction!.operations.length, 1)
  const op = transaction!.operations[0]
  assert.equal(op.type, 'update')
  if (op.type === 'update') {
    assert.deepEqual(op.changes, { isTemplate: true })
    assert.deepEqual(op.previous, { isTemplate: false })
  }
  // 已标记再加 = no-op
  blocks.get('tpl')!.isTemplate = true
  assert.equal(markTemplate(blocks, 'tpl', true), null)
  // 非页面块不能当模板
  assert.equal(markTemplate(blocks, 'c1', true), null)
})

test('instantiateTemplate：空页三件——属性预设、正文整棵复制、id 全换新、内部引用改指副本', () => {
  const template = page('tpl', '会议模板', { isTemplate: true,
    properties: [{ defId: 'p1', type: 'text', value: '每周' }],
    children: ['h1', 'list1'],
  })
  const heading = child('h1', '议程', 'tpl', 0, { type: 'heading1' })
  const list = child('list1', '第一项', 'tpl', 1, { children: ['li1'] })
  const li = child('li1', '子项', 'list1', 0, {
    // 内部行内引用：目标在同一棵子树里 → 副本必须改指新 id
    content: [{ t: 'inline-ref', v: '第一项', ref: { kind: 'block', targetId: 'list1' } }],
  })
  const blocks = graphOf(template, heading, list, li, page('target', '新页'))
  const result = instantiateTemplate(blocks, 'tpl', 'target')
  assert.ok(result)
  assert.equal(result!.propertiesOnly, false)
  assert.equal(result!.copiedBlocks, 3)

  // 在真实图上应用，验三件
  const store = new DomainStore([template, heading, list, li, page('target', '新页')])
  assert.equal(store.applyTemplate('target', 'tpl'), true)
  const target = store.get('target')!
  assert.equal(target.children.length, 2)
  assert.deepEqual(target.properties, [{ defId: 'p1', type: 'text', value: '每周' }])
  const copiedHeading = store.get(target.children[0])!
  assert.equal(copiedHeading.type, 'heading1')
  assert.equal(copiedHeading.parent, 'target')
  const copiedList = store.get(target.children[1])!
  assert.equal(copiedList.children.length, 1, '子结构深复制一层不少')
  const copiedLi = store.get(copiedList.children[0])!
  const fragment = copiedLi.content[0]
  assert.equal(fragment.t, 'inline-ref')
  if (fragment.t === 'inline-ref') {
    assert.equal(fragment.ref?.targetId, copiedList.entityId, '内部引用改指副本，不指原模板块')
  }
  // 所有 id 全新
  const ids = [copiedHeading.entityId, copiedList.entityId, copiedLi.entityId]
  assert.equal(new Set(ids).size, 3)
  for (const id of ids) assert.notEqual(id, 'h1')
})

test('instantiateTemplate：目标非空 → 只带属性预设，正文一字不动（负例）', () => {
  const template = page('tpl', '模板', { isTemplate: true, properties: [{ defId: 'p1', type: 'text', value: '模板值' }], children: ['h1'] })
  const heading = child('h1', '模板正文', 'tpl', 0)
  const target = page('target', '已有内容的页', { children: ['own1'] })
  const own = child('own1', '我自己的字', 'target', 0)
  const store = new DomainStore([template, heading, target, own])

  assert.equal(store.applyTemplate('target', 'tpl'), true)
  const after = store.get('target')!
  assert.deepEqual(after.children, ['own1'], '正文一字不动：不新增任何块')
  assert.deepEqual(after.properties, [{ defId: 'p1', type: 'text', value: '模板值' }], '属性预设照带')
  assert.equal(store.get('own1')!.content[0].t === 'text' ? (store.get('own1')!.content[0] as { v: string }).v : '', '我自己的字')
})

test('store.createPageFromTemplate：建页＋应用三件 = 一个事务（一次撤销回到没有这一页）', () => {
  const template = page('tpl', '模板', { isTemplate: true, children: ['h1'], properties: [{ defId: 'p1', type: 'text', value: 'x' }] })
  const heading = child('h1', '标题', 'tpl', 0)
  const store = new DomainStore([template, heading])

  const pageId = store.createPageFromTemplate('tpl')
  assert.ok(pageId)
  const created = store.get(pageId!)!
  assert.equal(created.isObject, true)
  assert.equal(created.children.length, 1)
  assert.equal(created.properties.length, 1)

  store.undo()
  assert.equal(store.get(pageId!)?.deleted, true, '一次撤销整页退回（建页与应用同一事务：墓碑取代活页）')
})

test('模板图结构合法：实例化后的块图过 validateBlockGraph', () => {
  const template = page('tpl', '模板', { isTemplate: true, children: ['h1', 'list1'] })
  const heading = child('h1', '标题', 'tpl', 0)
  const list = child('list1', '列表', 'tpl', 1, { children: ['li1'] })
  const li = child('li1', '子项', 'list1', 0)
  const store = new DomainStore([template, heading, list, li])
  const pageId = store.createPageFromTemplate('tpl')!
  const issues = validateBlockGraph(store.read()).filter((issue) => issue.code !== 'position-duplicate' && issue.code !== 'position-order')
  assert.deepEqual(issues, [])
  assert.ok(store.get(pageId))
})
