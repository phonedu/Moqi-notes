import assert from 'node:assert/strict'
import test from 'node:test'
import { AI_ACTION_LABEL, createTextBlock, expiredTrashIds, orderedRootIds, splitContentAtOffset, textContent, TRASH_RETENTION_DAYS } from '@moqi/editor'
import { AI_UI_OPS } from '../src/ui/aiMenu'
import type { Block, ContentFragment, MetadataRegistry, PropertyDef } from '@moqi/editor'
import { dedupeSelection, deleteBlocks } from '@moqi/editor'
import { aiAnswerPageName, aiOpScope, aiPanelGate, expandAiSources, insertAiResults } from '@moqi/editor'
import { insertExternalLink, insertRefTrigger, parseRefQuery, refLabel, searchRefTargets } from '@moqi/editor'
import { refToken, selectionAsText } from '@moqi/editor'
import { AiService } from '../src/application/aiService'
import { OpenAICompatibleAIPort, StubAIPort } from '../src/adapters/ai'
import { applyPropertyValue, addPropertyOption, coercePropertyValue, createPropertyDef, disablePropertyDef, emptyRegistry, ensureTagDef, isPropertySet, migratePlainTags, movePropertyDef, movePropertyOption, propertyNameProblem, propertyRowVisible, deletePropertyDef, propertyUsages, removePropertyOption, renamePropertyDef, renamePropertyOption, tagUsages } from '@moqi/editor'
import { normalizeBlock } from '@moqi/editor'
import { addBlockRef, rebuildReverseRefs, validateReverseRefs, addObjectRef, removeBlockRef } from '@moqi/editor'
import { backlinkSourceCounts, collectBacklinks, danglingRefCount } from '@moqi/editor'
import { planMarkdownExport, sanitizeExportName, type ExportScope } from '@moqi/editor'
import { blockMarkerOf, escapeLeadingMarker, parseMarkdownOutline, splitBlockMarker, unescapeLeadingMarker } from '@moqi/editor'
import { collapsedAncestors, purgeSubtreeIds } from '@moqi/editor'
import { buildSidebarStats, formatCompactCount } from '@moqi/editor'
import { runPurge, type PurgeDeps } from '../src/ui/purgeFlow'
import { DomainStore } from '../src/application/store'
import { OrderedPersistQueue, SerialPersistQueue } from '../src/application/persistQueue'
import type { Operation } from '@moqi/editor'
import { adoptDividerBodies, adoptObjectNames, adoptOrphanedChildren, assertValidBlockGraph, dropDanglingChildren, validateBlockGraph, validateBlockShape, webUrlError } from '@moqi/editor'
import { convertBlockType } from '@moqi/editor'
import { applyTransaction, derivedObjectName, touchedBlockIds } from '@moqi/editor'
import { availableCopyName } from '@moqi/editor'
import { parseBlock, parseBlockForLoad, serializeBlock, serializeBlockGraph, parseBlockGraph } from '@moqi/editor'
import { blocksFromEditor, createMoqiEditor, editorStateFromBlocks } from '@moqi/editor'
import { BlockNode, blockTypeClassName } from '@moqi/editor'

const tx = (operations: Operation[]) => ({ id: crypto.randomUUID(), operations, timestamp: Date.now(), source: 'user' as const })

test('SAVE-CHAIN-1: flush waits for logs and deletion, preserving batch order', async () => {
  const queue = new OrderedPersistQueue()
  const events: string[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  queue.enqueue([
    async () => { events.push('snapshot') },
    async () => { await gate; events.push('log') },
    async () => { events.push('purge') },
  ])
  queue.enqueue([async () => { events.push('new-snapshot') }])
  let flushed = false
  const flushing = queue.flush().then(() => { flushed = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(flushed, false)
  assert.deepEqual(events, ['snapshot'])
  release()
  await flushing
  assert.deepEqual(events, ['snapshot', 'log', 'purge', 'new-snapshot'])
})

test('SAVE-CHAIN-2: failed logs retry before newer edits without replaying completed writes', async () => {
  const queue = new OrderedPersistQueue()
  const events: string[] = []
  let fail = true
  queue.enqueue([
    async () => { events.push('snapshot') },
    async () => { if (fail) throw new Error('disk'); events.push('log') },
    async () => { events.push('purge') },
  ])
  await assert.rejects(queue.flush(), /disk/)
  fail = false
  queue.enqueue([async () => { events.push('new-snapshot') }])
  await queue.flush()
  assert.deepEqual(events, ['snapshot', 'log', 'purge', 'new-snapshot'])
})

/** page → p1, p2 (p2 → c1, c2) used by indent/outdent tests. */
function outlineDocument() {
  const page = createTextBlock({ entityId: 'page', blockUid: 'page00001', text: '页面', isObject: true, objectName: '页面' })
  const p1 = createTextBlock({ entityId: 'p1', blockUid: 'p1000001', text: '第一段', parent: 'page' })
  const p2 = createTextBlock({ entityId: 'p2', blockUid: 'p2000002', text: '第二段', parent: 'page' })
  const c1 = createTextBlock({ entityId: 'c1', blockUid: 'c1000001', text: '子级一', parent: 'p2' })
  const c2 = createTextBlock({ entityId: 'c2', blockUid: 'c2000002', text: '子级二', parent: 'p2' })
  page.children = ['p1', 'p2']
  p2.children = ['c1', 'c2']
  return { store: new DomainStore([page, p1, p2, c1, c2]), page, p1, p2, c1, c2 }
}

/**
 * 与 `outlineDocument` 同，但另有**一页别的页面**（`other`，含一个正文块 `ob1`）。
 *
 * 为什么需要它（D-014，）：把「自引用」拒到页级之后，`outlineDocument` 里那个唯一的目标
 * `page` 变成了**本篇自己**——原先靠它来测「对象引用」的用例全都变成在测被拒的路径。这些用例要测的是
 * 引用通路本身，所以补一页当目标；「本篇不能被引用」另有 D-014 那条专门钉住。
 */
function outlineWithOtherPage() {
  const base = outlineDocument()
  const other = createTextBlock({ entityId: 'other', blockUid: 'other001', isObject: true, objectName: '另一页', text: '另一页' })
  const ob1 = createTextBlock({ entityId: 'ob1', blockUid: 'ob100001', text: '别页的正文', parent: 'other' })
  other.children = ['ob1']
  return { ...base, other, ob1, store: new DomainStore([...base.store.snapshot().values(), other, ob1]) }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

test('Content split keeps each side exactly once at every cursor position', () => {
  const content = [{ t: 'text' as const, v: 'abcdef' }]
  assert.deepEqual(splitContentAtOffset(content, 0), [[], content])
  assert.deepEqual(splitContentAtOffset(content, 3), [[{ t: 'text', v: 'abc' }], [{ t: 'text', v: 'def' }]])
  assert.deepEqual(splitContentAtOffset(content, 6), [content, []])
  assert.deepEqual(splitContentAtOffset(content, 99), [content, []])
  assert.deepEqual(content, [{ t: 'text', v: 'abcdef' }])
})

test('Content split preserves inline fragment kinds and marks without duplication', () => {
  const content = [
    { t: 'text' as const, v: 'ab', marks: [{ type: 'bold' as const }] },
    { t: 'inline-ref' as const, v: 'XY' },
    { t: 'text' as const, v: 'cd', marks: [{ type: 'italic' as const }] },
  ]
  const [left, right] = splitContentAtOffset(content, 3)
  assert.deepEqual(left, [
    { t: 'text', v: 'ab', marks: [{ type: 'bold' }] },
    { t: 'inline-ref', v: 'X' },
  ])
  assert.deepEqual(right, [
    { t: 'inline-ref', v: 'Y' },
    { t: 'text', v: 'cd', marks: [{ type: 'italic' }] },
  ])
  assert.equal([...left, ...right].map((fragment) => fragment.v).join(''), 'abXYcd')
  assert.deepEqual(content, [
    { t: 'text', v: 'ab', marks: [{ type: 'bold' }] },
    { t: 'inline-ref', v: 'XY' },
    { t: 'text', v: 'cd', marks: [{ type: 'italic' }] },
  ])
})

test('SerialPersistQueue never writes superseded snapshots out of order', async () => {
  const firstWrite = deferred<void>()
  const writes: string[] = []
  let persisted = ''
  const queue = new SerialPersistQueue<string>(async (snapshot) => {
    writes.push(`start:${snapshot}`)
    if (snapshot === 'v1') await firstWrite.promise
    persisted = snapshot
    writes.push(`done:${snapshot}`)
  })

  queue.enqueue('v1')
  // Let the first writer start and block. New edits supersede v2 before any
  // storage write starts, so v2 must never be persisted.
  await Promise.resolve()
  queue.enqueue('v2')
  queue.enqueue('v3')
  firstWrite.resolve()
  await queue.flush()

  assert.deepEqual(writes, ['start:v1', 'done:v1', 'start:v3', 'done:v3'])
  assert.equal(persisted, 'v3')
})

test('Splitting an object block inserts the new paragraph before existing children', () => {
  const root = createTextBlock({ entityId: 'split-object', blockUid: 'split0001', text: '对象正文', isObject: true, objectName: '项目' })
  const child = createTextBlock({ entityId: 'split-child', blockUid: 'split0002', text: '已有子段落', parent: root.entityId })
  root.children = [child.entityId]
  const store = new DomainStore([root, child])
  const [before, after] = splitContentAtOffset(root.content, 2)
  const inserted = createTextBlock({ entityId: 'split-new', blockUid: 'split0003', text: '', parent: root.entityId })
  inserted.content = after

  store.apply(tx([
    { type: 'update', opId: 'split-update', blockId: root.entityId, changes: { content: before }, previous: { content: root.content } },
    { type: 'insert', opId: 'split-insert', block: inserted, parentId: root.entityId, index: 0 },
  ]))

  assert.deepEqual(store.get(root.entityId)?.children, [inserted.entityId, child.entityId])
  assert.equal(store.get(inserted.entityId)?.parent, root.entityId)
  assert.equal(store.get(root.entityId)?.content[0]?.v, '对象')
  assert.equal(store.get(inserted.entityId)?.content[0]?.v, '正文')
  assert.equal(validateBlockGraph(store.snapshot()).length, 0)
})

test('Block graph keeps parent and children consistent', () => {
  const root = createTextBlock({ entityId: 'root', blockUid: 'root00001', text: 'root' })
  const child = createTextBlock({ entityId: 'child', blockUid: 'child0001', text: 'child' })
  const store = new DomainStore([root])
  store.apply(tx([{ type: 'insert', opId: 'insert-child', block: child, parentId: 'root', index: 0 }]))
  assert.equal(validateBlockGraph(store.snapshot()).length, 0)
  assert.deepEqual(store.get('root')?.children, ['child'])
  assert.equal(store.get('child')?.parent, 'root')
})

test('Block refs rebuild reverse refs', () => {
  const source = createTextBlock({ entityId: 'source', blockUid: 'source001', text: 'source' })
  const target = createTextBlock({ entityId: 'target', blockUid: 'target001', text: 'target' })
  const blocks = new Map([['source', source], ['target', target]])
  addBlockRef(blocks, 'source', 'target', 'link', 'context')
  assert.deepEqual(blocks.get('target')?.blockBackRefs.map((ref) => ref.fromBlockId), ['source'])
  assert.deepEqual(validateReverseRefs(blocks), [])
  blocks.get('target')!.blockBackRefs = []
  rebuildReverseRefs(blocks)
  assert.deepEqual(blocks.get('target')?.blockBackRefs.map((ref) => ref.fromBlockId), ['source'])
})

test('Incremental ref changes update only affected reverse indexes', () => {
  const source = createTextBlock({ entityId: 'inc-source', blockUid: 'inc00001', text: 'source' })
  const target = createTextBlock({ entityId: 'inc-target', blockUid: 'inc00002', text: 'target' })
  const object = createTextBlock({ entityId: 'inc-object', blockUid: 'inc00003', text: 'object', isObject: true, objectName: '对象' })
  const blocks = new Map([['inc-source', source], ['inc-target', target], ['inc-object', object]])
  addBlockRef(blocks, 'inc-source', 'inc-target', 'mention')
  addObjectRef(blocks, 'inc-source', 'inc-object')
  assert.equal(target.blockBackRefs.length, 1)
  assert.deepEqual(object.objectBackRefs, ['inc-source'])
  removeBlockRef(blocks, 'inc-source', 'inc-target', 'mention')
  assert.equal(target.blockBackRefs.length, 0)
  assert.deepEqual(validateReverseRefs(blocks), [])
})

test('backlinkSourceCounts 与 collectBacklinks 逐条同义（页面库反链数的索引化，去重 / 自指 / 已删来源）', () => {
  const page = createTextBlock({ entityId: 'bl-page', blockUid: 'blp00001', text: '页', isObject: true, objectName: '页' })
  const a = createTextBlock({ entityId: 'bl-a', blockUid: 'bla00001', text: '甲' })
  const b = createTextBlock({ entityId: 'bl-b', blockUid: 'blb00001', text: '乙' })
  const gone = createTextBlock({ entityId: 'bl-gone', blockUid: 'blg00001', text: '删' })
  const blocks = new Map([[page.entityId, page], [a.entityId, a], [b.entityId, b], [gone.entityId, gone]])
  addBlockRef(blocks, 'bl-a', 'bl-page', 'link')       // 甲 → 页（block 引用）
  addBlockRef(blocks, 'bl-a', 'bl-page', 'mention')    // 甲 → 页再一条：**来源只算一个**
  addBlockRef(blocks, 'bl-a', 'bl-b', 'link')          // 甲 → 乙
  addObjectRef(blocks, 'bl-b', 'bl-page')              // 乙 → 页（object 引用）
  addBlockRef(blocks, 'bl-gone', 'bl-page', 'link')    // 已删来源：默认不计
  addBlockRef(blocks, 'bl-b', 'bl-b', 'link')          // 自指：两个口径都排除
  gone.deleted = true
  for (const id of [...blocks.keys()]) {
    assert.equal(backlinkSourceCounts(blocks).get(id) ?? 0, collectBacklinks(blocks, id).length, `默认口径 ${id}`)
    assert.equal(backlinkSourceCounts(blocks, { includeDeleted: true }).get(id) ?? 0, collectBacklinks(blocks, id, { includeDeleted: true }).length, `含已删 ${id}`)
  }
})

test('Undo and redo restore a transaction', () => {
  const root = createTextBlock({ entityId: 'root', blockUid: 'root00002', text: 'root' })
  const child = createTextBlock({ entityId: 'child', blockUid: 'child0002', text: 'child' })
  const store = new DomainStore([root])
  store.apply(tx([{ type: 'insert', opId: 'insert-child', block: child, parentId: 'root', index: 0 }]))
  assert.equal(store.get('child')?.entityId, 'child')
  store.undo()
  assert.equal(store.get('child')?.deleted, true)
  store.redo()
  assert.equal(store.get('child')?.entityId, 'child')
})

test('Block JSON round-trips without Lexical state', () => {
  const root = createTextBlock({ entityId: 'json-root', blockUid: 'json00001', text: '持久化边界' })
  const json = serializeBlock(root)
  assert.deepEqual(parseBlock(json), root)
  const graph = new Map([[root.entityId, root]])
  assert.deepEqual([...parseBlockGraph(serializeBlockGraph(graph)).keys()], ['json-root'])
})

test('Delete and restore preserve subtree identity and order', () => {
  const root = createTextBlock({ entityId: 'delete-root', blockUid: 'delete001', text: 'root' })
  const child = createTextBlock({ entityId: 'delete-child', blockUid: 'delete002', text: 'child', parent: 'delete-root' })
  root.children = ['delete-child']
  const store = new DomainStore([root, child])
  store.apply(tx([{ type: 'delete', opId: 'delete-tree', blockId: 'delete-root', descendantIds: ['delete-child'], snapshots: [] }]))
  assert.equal(store.get('delete-root')?.deleted, true)
  assert.equal(store.get('delete-child')?.deleted, true)
  store.undo()
  assert.equal(store.get('delete-root')?.deleted, false)
  assert.equal(store.get('delete-child')?.deleted, false)
  assert.deepEqual(store.get('delete-root')?.children, ['delete-child'])
})

test('Move rejects cycles and preserves same-parent order', () => {
  const root = createTextBlock({ entityId: 'move-root', blockUid: 'move00001', text: 'root' })
  const first = createTextBlock({ entityId: 'move-first', blockUid: 'move00002', text: 'first', parent: 'move-root' })
  const second = createTextBlock({ entityId: 'move-second', blockUid: 'move00003', text: 'second', parent: 'move-root' })
  root.children = ['move-first', 'move-second']
  const store = new DomainStore([root, first, second])
  store.apply(tx([{ type: 'move', opId: 'move-same-parent', blockId: 'move-first', oldParentId: 'move-root', oldIndex: 0, newParentId: 'move-root', newIndex: 2 }]))
  assert.deepEqual(store.get('move-root')?.children, ['move-second', 'move-first'])
  assert.throws(() => store.apply(tx([{ type: 'move', opId: 'move-cycle', blockId: 'move-root', oldParentId: null, oldIndex: 0, newParentId: 'move-first', newIndex: 0 }])), /自身后代/)
})

test('BLOCK-TAB-1: Tab indent makes the block the last child of the previous sibling with its whole subtree', () => {
  const { store } = outlineDocument()
  assert.equal(store.indent('p2'), true)
  assert.deepEqual(store.get('page')?.children, ['p1'])
  assert.deepEqual(store.get('p1')?.children, ['p2'])
  assert.equal(store.get('p2')?.parent, 'p1')
  // The subtree travels with the moved block; children identities are untouched.
  assert.deepEqual(store.get('p2')?.children, ['c1', 'c2'])
  assert.equal(store.get('c1')?.parent, 'p2')
  assert.equal(store.get('c2')?.parent, 'p2')
  assert.equal(validateBlockGraph(store.snapshot()).length, 0)
  assert.equal(textOfId(store, 'p2'), '第二段')
})

test('BLOCK-TAB-3: Tab indent no-ops on root blocks, first children, and missing blocks without a transaction', () => {
  const { store } = outlineDocument()
  // Root-level block (page itself) and first child must not create undo steps.
  assert.equal(store.indent('page'), false)
  assert.equal(store.indent('p1'), false)
  assert.equal(store.indent('missing'), false)
  assert.equal(store.canUndo(), false)
  assert.deepEqual(store.get('page')?.children, ['p1', 'p2'])
})

test('V2A-01: Tab indent keeps collapsed states of the moved subtree', () => {
  const { store } = outlineDocument()
  store.apply(tx([{ type: 'collapse', opId: 'collapse-p2', blockId: 'p2', collapsed: true }]))
  store.apply(tx([{ type: 'collapse', opId: 'collapse-c1', blockId: 'c1', collapsed: true }]))
  store.indent('p2')
  assert.equal(store.get('p2')?.collapsed, true)
  assert.equal(store.get('c1')?.collapsed, true)
  assert.equal(validateBlockGraph(store.snapshot()).length, 0)
})

test('BLOCK-TAB-6: Undo and redo restore indent and outdent', () => {
  const { store } = outlineDocument()
  store.indent('p2')
  store.undo()
  assert.deepEqual(store.get('page')?.children, ['p1', 'p2'])
  assert.deepEqual(store.get('p1')?.children, [])
  store.redo()
  assert.deepEqual(store.get('p1')?.children, ['p2'])
  store.outdent('p2')
  assert.deepEqual(store.get('page')?.children, ['p1', 'p2'])
  assert.deepEqual(store.get('p1')?.children, [])
  store.undo()
  assert.deepEqual(store.get('p1')?.children, ['p2'])
  assert.equal(validateBlockGraph(store.snapshot()).length, 0)
})

test('BLOCK-TAB-4: Shift+Tab outdent places the block right after its former parent as a sibling', () => {
  const { store } = outlineDocument()
  store.indent('p2')
  // c1 sits at depth 2 (p1 → p2 → c1); outdenting makes it a sibling of p2 under p1.
  assert.equal(store.outdent('c1'), true)
  assert.deepEqual(store.get('p1')?.children, ['p2', 'c1'])
  assert.equal(store.get('c1')?.parent, 'p1')
  assert.deepEqual(store.get('p2')?.children, ['c2'])
  assert.equal(validateBlockGraph(store.snapshot()).length, 0)
})

test('BLOCK-TAB-5: Shift+Tab outdent under a page container is a no-op（页面容器不是缩进层级）', () => {
  // 页面对象块是页面容器（docs/09 §409）：它的直接子块已经在最左边缘，再反缩进没有可去的层级。
  // 旧实现把它提成根块（newParentId: null, newIndex: 0）——那等于把正文块移出本篇：
  // 编辑器里掉到页面末尾，刷新后整块从页面与页面库消失（仍是库里的一条孤立根块）。
  const { store } = outlineDocument()
  assert.equal(store.outdent('p2'), false)
  assert.equal(store.get('p2')?.parent, 'page')
  assert.deepEqual(store.get('page')?.children, ['p1', 'p2'])
  assert.deepEqual(orderedRootIds(store.snapshot()), ['page'])
  assert.equal(store.canUndo(), false)
  assert.equal(validateBlockGraph(store.snapshot()).length, 0)
})

test('V2A-01: Shift+Tab outdent no-ops at root level', () => {
  const { store } = outlineDocument()
  assert.equal(store.outdent('page'), false)
  assert.equal(store.outdent('missing'), false)
  assert.equal(store.canUndo(), false)
})

test('BLOCK-DRAG-1: drag move reparents the block at the target index with its subtree', () => {
  const { store } = outlineDocument()
  assert.equal(store.move('p1', 'p2', 0), true)
  assert.deepEqual(store.get('page')?.children, ['p2'])
  assert.deepEqual(store.get('p2')?.children, ['p1', 'c1', 'c2'])
  assert.equal(store.get('p1')?.parent, 'p2')
  assert.equal(validateBlockGraph(store.snapshot()).length, 0)
})

/** 块组拖拽用：3+ 个同级根块 + 一个带子块的根（`BLOCK-DRAG-1` 的块组形态）。 */
function groupFixture() {
  const page = createTextBlock({ entityId: 'page', blockUid: 'page00001', text: '页面', isObject: true, objectName: '页面' })
  const a = createTextBlock({ entityId: 'a', blockUid: 'a0000001', text: 'A', parent: 'page' })
  const b = createTextBlock({ entityId: 'b', blockUid: 'b0000002', text: 'B', parent: 'page' })
  const c = createTextBlock({ entityId: 'c', blockUid: 'c0000003', text: 'C', parent: 'page' })
  const d = createTextBlock({ entityId: 'd', blockUid: 'd0000004', text: 'D', parent: 'page' })
  const b1 = createTextBlock({ entityId: 'b1', blockUid: 'b1000001', text: 'B 的子级', parent: 'b' })
  page.children = ['a', 'b', 'c', 'd']
  b.children = ['b1']
  return { store: new DomainStore([page, a, b, c, d, b1]), page, a, b, c, d, b1 }
}

// γ2（）：移动端「选择模式内拖拽」= 块组一次事务移动。
test('BLOCK-DRAG-1（块组）：整组一次事务移动、保持相对顺序、一步撤销', () => {
  const { store } = groupFixture()
  // 选 A 与 C 一起拖到列表末尾（去掉 A/C 后 ['b','d']，落点 index 4 = 追加）
  assert.equal(store.moveBlocks(['a', 'c'], 'page', 4), true)
  assert.deepEqual(store.get('page')?.children, ['b', 'd', 'a', 'c'])
  assert.equal(validateBlockGraph(store.snapshot()).length, 0)
  // **一次事务 ⇒ 一步撤销**（撤销后 canUndo 归 false = 只有这一笔）
  assert.equal(store.canUndo(), true)
  store.undo()
  assert.deepEqual(store.get('page')?.children, ['a', 'b', 'c', 'd'])
  assert.equal(store.canUndo(), false)
})

test('BLOCK-DRAG-1（块组）：含父子时只动根（父级去重，子块不重复搬）', () => {
  const { store } = groupFixture()
  // B 与它的子块 b1 同时选中 ⇒ 去重后只移动 B（整棵走）
  assert.equal(store.moveBlocks(['b', 'b1'], 'page', 0), true)
  assert.deepEqual(store.get('page')?.children, ['b', 'a', 'c', 'd'])
  assert.deepEqual(store.get('b')?.children, ['b1'])
  assert.equal(store.get('b1')?.parent, 'b')
  assert.equal(validateBlockGraph(store.snapshot()).length, 0)
})

test('BLOCK-DRAG-1（块组）：跨父级整组落进同一目标，顺序不变', () => {
  const { store } = groupFixture()
  // A（根）与 b1（B 的子）一起拖进 D ⇒ D.children = ['a','b1']，相对顺序不变
  assert.equal(store.moveBlocks(['a', 'b1'], 'd', 0), true)
  assert.deepEqual(store.get('d')?.children, ['a', 'b1'])
  assert.deepEqual(store.get('page')?.children, ['b', 'c', 'd'])
  assert.deepEqual(store.get('b')?.children, [])
  assert.equal(validateBlockGraph(store.snapshot()).length, 0)
})

test('BLOCK-DRAG-1（块组）：非法落点整组 no-op（回弹，不部分生效）', () => {
  const { store } = groupFixture()
  // 组里有一块的落点非法（b1 在 B 的子树内）⇒ **整组都不动**、不产生事务
  assert.equal(store.moveBlocks(['b', 'b1'], 'b1', 0), false)
  // 拖到自己身上
  assert.equal(store.moveBlocks(['b'], 'b', 0), false)
  // 页面容器不得移进别的块
  assert.equal(store.moveBlocks(['page'], 'd', 0), false)
  assert.equal(store.canUndo(), false)
  assert.deepEqual(store.get('page')?.children, ['a', 'b', 'c', 'd'])
  assert.deepEqual(store.get('b')?.children, ['b1'])
})

test('V2A-03: drag move before and after a target adjusts the sibling index', () => {
  const { store } = outlineDocument()
  // Drop c1 after p2 at the page level (index of p2 + 1).
  assert.equal(store.move('c1', 'page', 2), true)
  assert.deepEqual(store.get('page')?.children, ['p1', 'p2', 'c1'])
  assert.deepEqual(store.get('p2')?.children, ['c2'])
  // Drop c1 before p2 (index of p2).
  assert.equal(store.move('c1', 'page', 1), true)
  assert.deepEqual(store.get('page')?.children, ['p1', 'c1', 'p2'])
  assert.equal(validateBlockGraph(store.snapshot()).length, 0)
})

test('V2A-03: drag move to top level lifts the block and its subtree', () => {
  const { store } = outlineDocument()
  assert.equal(store.move('p2', null, 0), true)
  assert.equal(store.get('p2')?.parent, null)
  assert.deepEqual(store.get('page')?.children, ['p1'])
  assert.deepEqual(store.get('p2')?.children, ['c1', 'c2'])
  assert.equal(validateBlockGraph(store.snapshot()).length, 0)
})

test('BLOCK-DRAG-2: drag move rejects self, descendants and same-slot drops without a transaction', () => {
  const { store } = outlineDocument()
  assert.equal(store.move('p2', 'p2', 0), false)
  assert.equal(store.move('p2', 'c1', 0), false)
  assert.equal(store.move('p1', 'page', 0), false)
  assert.equal(store.canUndo(), false)
  assert.deepEqual(store.get('page')?.children, ['p1', 'p2'])
  assert.deepEqual(store.get('p2')?.children, ['c1', 'c2'])
})

test('V2A-03: undo and redo restore a drag move', () => {
  const { store } = outlineDocument()
  store.move('c1', 'p1', 0)
  assert.deepEqual(store.get('p1')?.children, ['c1'])
  store.undo()
  assert.deepEqual(store.get('p1')?.children, [])
  assert.deepEqual(store.get('p2')?.children, ['c1', 'c2'])
  store.redo()
  assert.deepEqual(store.get('p1')?.children, ['c1'])
  assert.deepEqual(store.get('p2')?.children, ['c2'])
  assert.equal(validateBlockGraph(store.snapshot()).length, 0)
})

// 逮到（T6 ④ 加「上移 / 下移」时）：同父移动的撤销只在**往下移**时正确。
// 「上移一步」的逆操作落点会被 -1 规则吃掉（空位索引正好等于块自己那一格 → 原地不动），
// 根级上移的撤销则少走一格。修法是逆操作也遵守「newIndex 是块仍在原位时的空位索引」——
// 目标比现在靠后就让开自己那一格（见 domain/operation.ts applyMove 的注释）。
test('BLOCK-MOVE-1: 同父换位的撤销回到原位（上移一步 / 下移 / 根级上移）', () => {
  const page = createTextBlock({ entityId: 'page', blockUid: 'page00001', text: '页面', isObject: true, objectName: '页面' })
  const a = createTextBlock({ entityId: 'a', blockUid: 'a0000001', text: '甲', parent: 'page' })
  const b = createTextBlock({ entityId: 'b', blockUid: 'b0000001', text: '乙', parent: 'page' })
  const c = createTextBlock({ entityId: 'c', blockUid: 'c0000001', text: '丙', parent: 'page' })
  page.children = ['a', 'b', 'c']
  const store = new DomainStore([page, a, b, c])

  assert.equal(store.move('b', 'page', 0), true)
  assert.deepEqual(store.get('page')!.children, ['b', 'a', 'c'])
  store.undo()
  assert.deepEqual(store.get('page')!.children, ['a', 'b', 'c'], '上移一步的撤销')
  store.redo()
  assert.deepEqual(store.get('page')!.children, ['b', 'a', 'c'], '重做回到移动后')

  assert.equal(store.move('b', 'page', 3), true)
  assert.deepEqual(store.get('page')!.children, ['a', 'c', 'b'])
  store.undo()
  assert.deepEqual(store.get('page')!.children, ['b', 'a', 'c'], '下移的撤销')

  const pageA = createTextBlock({ entityId: 'r-a', blockUid: 'root0001', text: 'A', isObject: true, objectName: 'A' })
  const pageB = createTextBlock({ entityId: 'r-b', blockUid: 'root0002', text: 'B', isObject: true, objectName: 'B' })
  const pageC = createTextBlock({ entityId: 'r-c', blockUid: 'root0003', text: 'C', isObject: true, objectName: 'C' })
  const roots = new DomainStore([pageA, pageB, pageC])
  const rootIds = () => [...roots.snapshot().values()]
    .filter((block) => block.parent === null && !block.deleted)
    .sort((left, right) => left.position - right.position)
    .map((block) => block.entityId)
  assert.equal(roots.move('r-c', null, 0), true)
  assert.deepEqual(rootIds(), ['r-c', 'r-a', 'r-b'])
  roots.undo()
  assert.deepEqual(rootIds(), ['r-a', 'r-b', 'r-c'], '根级上移的撤销')
  assert.equal(validateBlockGraph(roots.snapshot()).length, 0)
  assert.equal(validateBlockGraph(store.snapshot()).length, 0)
})

// 逮到：撤销是**反序**回放，同级兄弟若按正序记录，插回时就越插越靠后
// （删「甲、乙」再 ⌘Z 得到「甲、丙、乙」；块选中态 ⌫ 删两块时可见）。记录顺序改为从后往前。
test('SELECT-4: 批量删除的撤销按原顺序插回（含中间隔着没删的兄弟）', () => {
  const page = createTextBlock({ entityId: 'page', blockUid: 'page00001', text: '页面', isObject: true, objectName: '页面' })
  const a = createTextBlock({ entityId: 'a', blockUid: 'a0000001', text: '甲', parent: 'page' })
  const b = createTextBlock({ entityId: 'b', blockUid: 'b0000001', text: '乙', parent: 'page' })
  const c = createTextBlock({ entityId: 'c', blockUid: 'c0000001', text: '丙', parent: 'page' })
  const d = createTextBlock({ entityId: 'd', blockUid: 'd0000001', text: '丁', parent: 'page' })
  page.children = ['a', 'b', 'c', 'd']
  const store = new DomainStore([page, a, b, c, d])

  const batch = deleteBlocks(store.snapshot(), ['a', 'b', 'd'])
  assert.ok(batch)
  store.apply(batch.transaction)
  assert.deepEqual(store.get('page')!.children, ['c'])
  store.undo()
  assert.deepEqual(store.get('page')!.children, ['a', 'b', 'c', 'd'], '三块一起删、一起回')
  store.redo()
  assert.deepEqual(store.get('page')!.children, ['c'])
  assert.equal(validateBlockGraph(store.snapshot()).length, 0)
})

function textOfId(store: DomainStore, id: string): string {
  const block = store.get(id)
  assert.ok(block, `Missing block: ${id}`)
  return block.content.map((fragment) => fragment.v).join('')
}

test('BLOCK-TYPE-1: type conversion preserves identity, children, refs, tags and properties', () => {
  const { store } = outlineDocument()
  store.apply(tx([{
    type: 'update',
    opId: 'convert-refs',
    blockId: 'p2',
    changes: {
      tags: ['标签'],
      properties: [{ defId: 'd1', type: 'text', value: 'v1' }],
      blockRefs: [{ targetBlockId: 'c1', fromBlockId: 'p2', type: 'link' }],
      objectRefs: ['page'],
    },
    previous: {},
  }]))

  assert.deepEqual(store.convertType('p2', 'bullet'), ['p2'])
  const converted = store.get('p2')!
  assert.equal(converted.entityId, 'p2')
  assert.equal(converted.blockUid, 'p2000002')
  assert.equal(converted.type, 'bullet')
  assert.equal(textOfId(store, 'p2'), '第二段')
  assert.deepEqual(converted.children, ['c1', 'c2'])
  assert.equal(converted.parent, 'page')
  assert.deepEqual(converted.tags, ['标签'])
  assert.deepEqual(converted.properties, [{ defId: 'd1', type: 'text', value: 'v1' }])
  assert.deepEqual(converted.blockRefs, [{ targetBlockId: 'c1', fromBlockId: 'p2', type: 'link' }])
  assert.deepEqual(converted.objectRefs, ['page'])
  assert.deepEqual(validateBlockGraph(store.snapshot()), [])

  store.undo()
  assert.equal(store.get('p2')?.type, 'text')
  assert.equal(textOfId(store, 'p2'), '第二段')
  store.redo()
  assert.equal(store.get('p2')?.type, 'bullet')
})

test('V2A-04: converting to the same type without a content override is a no-op', () => {
  const { store } = outlineDocument()
  assert.equal(store.convertType('p1', 'text'), null)
  assert.equal(store.convertType('missing', 'text'), null)
  assert.equal(store.canUndo(), false)
})

// REF-DANGLE-1（`09-桌面端交互规范` §6.13）：删除被引用的块 = 删完再说——删之前先把
// 「几处引用会断」数出来（toast 用）。口径 = 活跃、且自己不在被删集合里的块，指向被删集合的
// `objectRefs` 元素与 `blockRefs` 元素各算一个点。
// REF-ALIAS-1（`09-桌面端交互规范` §6.13）：别名**只做显示**——`[[页面|别名` 里 `|` 之前是筛选
// 关键词、之后是显示文字（写进片段的 v，数据不动：仍是 v + targetId，没有别名字段）。
test('REF-ALIAS-1: parseRefQuery —— 竖线前筛选、竖线后显示；带别名的查询按页名匹配候选', () => {
  assert.deepEqual(parseRefQuery('项目 B'), { needle: '项目 B', display: null })
  assert.deepEqual(parseRefQuery('项目|那个大项目'), { needle: '项目', display: '那个大项目' })
  assert.deepEqual(parseRefQuery(' 项目 | 别名 '), { needle: '项目', display: '别名' }, '两侧空白都吃掉')
  assert.deepEqual(parseRefQuery('项目|'), { needle: '项目', display: null }, '竖线后为空：显示文字回落候选标签')
  assert.deepEqual(parseRefQuery('项|目|B'), { needle: '项', display: '目|B' }, '只看第一个竖线')

  const page = createTextBlock({ entityId: 'page', blockUid: 'page00001', text: '项目', isObject: true, objectName: '项目' })
  const other = createTextBlock({ entityId: 'other', blockUid: 'other001', text: '别页', isObject: true, objectName: '别页' })
  const blocks = new Map([page, other].map((block) => [block.entityId, block]))
  // 引用者放在**另一页**：候选会排掉「本篇」（自引用被拒，REF-LINK-4），放同页会一条都搜不到。
  const from = createTextBlock({ entityId: 'from', blockUid: 'from0001', text: '引用者', parent: 'other' })
  blocks.set(from.entityId, from)
  other.children = ['from']
  const hit = searchRefTargets(blocks, 'object', '项目|那个大项目', 'from')
  assert.deepEqual(hit.map((candidate) => candidate.label), ['项目'], '候选按竖线前的关键词匹配，别名不参与筛选')
})

// REF-ELINK-2/3（`09-桌面端交互规范` §6.13）：外部链接的地址判据与写入——一次事务、
// 一个 `link` 片段；区间碰到引用/链接片段时**扩到整片段**（不切片，保住绑定）。
test('REF-ELINK-2: webUrlError —— http(s) / mailto 才合法，且不许有空格', () => {
  assert.equal(webUrlError('https://example.com/a?b=c'), null)
  assert.equal(webUrlError('http://example.com'), null)
  assert.equal(webUrlError('mailto:someone@example.com'), null)
  assert.equal(webUrlError('  https://example.com  '), null, '两侧空白先 trim')
  assert.notEqual(webUrlError(''), null, '空地址：禁用并说明')
  assert.notEqual(webUrlError('example.com'), null, '没 scheme 不认')
  assert.notEqual(webUrlError('https://exa mple.com'), null, '带空格不认')
})

test('REF-ELINK-3: insertExternalLink —— 光标处插入 / 替换选区 / 区间扩到整片段 / 无效地址 no-op', () => {
  const page = createTextBlock({ entityId: 'page', blockUid: 'page00001', text: '页面', isObject: true, objectName: '页面' })
  const line = createTextBlock({ entityId: 'line', blockUid: 'line0001', text: '前 中 后', parent: 'page' })
  page.children = ['line']
  const blocks = new Map([page, line].map((block) => [block.entityId, block]))

  const inserted = insertExternalLink(blocks, 'line', { text: '站点', url: 'https://example.com', offset: 2, length: 0 })!
  assert.ok(inserted)
  applyTransaction(blocks, { ...inserted, inverse: [] })
  // applyTransaction 换的是块对象：断言要重新取（别拿旧引用）。
  const afterInsert = blocks.get('line')!
  assert.deepEqual(afterInsert.content.map((f) => [f.t, f.v]), [['text', '前 '], ['link', '站点'], ['text', '中 后']])
  assert.equal(afterInsert.content[1].url, 'https://example.com')

  const replaced = insertExternalLink(blocks, 'line', { text: '', url: 'https://example.org', offset: 0, length: 2 })
  assert.ok(replaced)
  assert.equal(replaced.operations[0].type, 'update')

  const bad = insertExternalLink(blocks, 'line', { text: 'x', url: 'not-a-url', offset: 0, length: 0 })
  assert.equal(bad, null, '无效地址：不产事务')

  // 区间碰到引用片段：扩到整片段，不切片
  const refLine = createTextBlock({ entityId: 'ref-line', blockUid: 'refline1', text: '', parent: 'page' })
  refLine.content = [{ t: 'text', v: 'ab' }, { t: 'inline-ref', v: '目标', ref: { kind: 'block', targetId: 'line' } }, { t: 'text', v: 'cd' }]
  // 取新对象再挂子树：上一次 applyTransaction 已经换过一遍块对象。
  blocks.get('page')!.children = ['line', 'ref-line']
  blocks.set('ref-line', refLine)
  const snap = insertExternalLink(blocks, 'ref-line', { text: 'L', url: 'https://example.com', offset: 3, length: 2 })!
  assert.ok(snap)
  applyTransaction(blocks, { ...snap, inverse: [] })
  // 引用片段被整体替换（不切片——切片会丢掉 ref 绑定）；纯文本按区间正常切（'cd' 只剩 'd'）。
  assert.deepEqual(blocks.get('ref-line')!.content.map((f) => [f.t, f.v]), [['text', 'ab'], ['link', 'L'], ['text', 'd']])
})

test('REF-ELINK-3: 形状码 —— url 只准出现在 link 片段上、且必须是可打开的地址', () => {
  const bad = createTextBlock({ entityId: 'bad', blockUid: 'bad00001', text: 'x' })
  bad.content = [{ t: 'text', v: 'x', url: 'https://example.com' }]
  assert.deepEqual(validateBlockShape(bad).map((issue) => issue.code), ['url-binding-only-on-link'])
  const broken = createTextBlock({ entityId: 'broken', blockUid: 'broken01', text: 'x' })
  broken.content = [{ t: 'link', v: 'x', url: 'nope' }]
  assert.deepEqual(validateBlockShape(broken).map((issue) => issue.code), ['link-url-invalid'])
  const good = createTextBlock({ entityId: 'good', blockUid: 'good0001', text: 'x' })
  good.content = [{ t: 'link', v: '站点', url: 'https://example.com' }]
  assert.equal(validateBlockShape(good).length, 0)
})

test('REF-DANGLE-1: danglingRefCount —— 引用点计数（被删集合内部的引用不算，已删来源不算）', () => {
  const page = createTextBlock({ entityId: 'page', blockUid: 'page00001', text: '页面', isObject: true, objectName: '页面' })
  const target = createTextBlock({ entityId: 'target', blockUid: 'target01', text: '被引的块', parent: 'page' })
  const source = createTextBlock({ entityId: 'source', blockUid: 'source01', text: '引用者', parent: 'page' })
  const inner = createTextBlock({ entityId: 'inner', blockUid: 'inner001', text: '被删子树内部', parent: 'target' })
  const other = createTextBlock({ entityId: 'other', blockUid: 'other001', text: '别页', isObject: true, objectName: '别页' })
  page.children = ['target', 'source']
  target.children = ['inner']
  const blocks = new Map([page, target, source, inner, other].map((block) => [block.entityId, block]))

  source.blockRefs = [{ targetBlockId: 'target', fromBlockId: 'source', type: 'link' }]
  inner.objectRefs = ['other']
  assert.equal(danglingRefCount(blocks, ['target']), 1, '只数被删目标拿到的那个引用点')
  assert.equal(danglingRefCount(blocks, ['target', 'inner']), 1, '子树一起删时，内部对别页的引用不算「失去」')

  other.objectRefs = ['target', 'target']
  assert.equal(danglingRefCount(blocks, ['target']), 3, '两个 objectRefs 元素算两个点')

  source.deleted = true
  assert.equal(danglingRefCount(blocks, ['target']), 2, '已删来源不数')
})

// D11（ 裁决，原判据「离开 todo 就清空勾选」被改掉）：勾选态**保留**——
// 数据留、界面无痕、转回即还原（与「AI 采用」同一条哲学：转换可逆）。
// 界面无痕由渲染层保证（复选框只画在 todo 上），域层不再替用户清数据。
test('BLOCK-TYPE-6 / V2A-04: todo carries checked, and converting away keeps it hidden in the data（D11）', () => {
  const { store } = outlineDocument()
  assert.deepEqual(store.convertType('p1', 'todo'), ['p1'])
  assert.equal(store.get('p1')?.type, 'todo')
  assert.equal(store.get('p1')?.checked, false)
  assert.equal(textOfId(store, 'p1'), '第一段')

  store.apply(tx([{ type: 'update', opId: 'check-p1', blockId: 'p1', changes: { checked: true }, previous: { checked: false } }]))
  assert.equal(store.get('p1')?.checked, true)

  assert.deepEqual(store.convertType('p1', 'numbered'), ['p1'])
  assert.equal(store.get('p1')?.type, 'numbered')
  assert.equal(store.get('p1')?.checked, true, '转出 todo 保留勾选态（界面不再显示复选框）')
  assert.deepEqual(store.convertType('p1', 'todo'), ['p1'])
  assert.equal(store.get('p1')?.checked, true, '转回 todo 即还原勾选')

  store.undo()
  assert.equal(store.get('p1')?.type, 'numbered', '转回那一步可单独撤销')
  assert.equal(store.get('p1')?.checked, true, '撤销也保留勾选态')
})

// D13（）：页面容器不参与类型转换——界面置灰只是第一道，域层也要把关
// （与置顶上限同一条做法）。顺带审计：缩进 / 反缩进本来就靠 `parent === null` 拦住，
// 移动则要补一条「页面容器不能被移进别的块」。
test('BLOCK-TYPE-7 / BLOCK-DRAG-4: 页面容器拒绝转换与下移（域层守卫，D13）', () => {
  const { store } = outlineDocument()
  assert.equal(store.convertType('page', 'heading1'), null)
  assert.equal(store.get('page')?.type, 'text')
  assert.equal(store.move('page', 'p1', 0), false, '页面容器不能被移进别的块')
})

test('BLOCK-TYPE-2: converting a block with text to divider moves the original text to the next sibling', () => {
  const { store } = outlineDocument()
  const affected = store.convertType('p2', 'divider')
  assert.ok(affected)
  assert.equal(affected[0], 'p2')
  const siblingId = affected[1]
  assert.ok(siblingId)
  assert.equal(textOfId(store, siblingId), '第二段')
  assert.equal(store.get('p2')?.type, 'divider')
  assert.deepEqual(store.get('p2')?.content, [])
  assert.deepEqual(store.get('p2')?.children, ['c1', 'c2'])
  assert.deepEqual(store.get('page')?.children, ['p1', 'p2', siblingId])
  assert.equal(store.get(siblingId)?.parent, 'page')
  assert.deepEqual(store.get(siblingId)?.content, [{ t: 'text', v: '第二段' }])
  assert.deepEqual(validateBlockGraph(store.snapshot()), [])

  store.undo()
  assert.equal(store.get('p2')?.type, 'text')
  assert.equal(textOfId(store, 'p2'), '第二段')
  assert.deepEqual(store.get('page')?.children, ['p1', 'p2'])
  assert.equal(store.get(siblingId)?.deleted, true)
})

test('V2A-04: converting an empty block to divider stays a single update without a sibling', () => {
  const { store } = outlineDocument()
  store.apply(tx([{ type: 'update', opId: 'clear-p1', blockId: 'p1', changes: { content: [] }, previous: { content: store.get('p1')!.content } }]))
  assert.deepEqual(store.convertType('p1', 'divider'), ['p1'])
  assert.deepEqual(store.get('p1')?.content, [])
  assert.deepEqual(store.get('page')?.children, ['p1', 'p2'])
  assert.equal(store.snapshot().size, 5)
})

test('BLOCK-SLASH-2: a slash choice drops the trigger through the content override without touching other text', () => {
  const { store } = outlineDocument()
  store.apply(tx([{ type: 'update', opId: 'slash', blockId: 'p1', changes: { content: [{ t: 'text', v: '/' }] }, previous: { content: store.get('p1')!.content } }]))
  assert.deepEqual(store.convertType('p1', 'heading2', []), ['p1'])
  assert.equal(store.get('p1')?.type, 'heading2')
  assert.deepEqual(store.get('p1')?.content, [])
  store.undo()
  assert.equal(store.get('p1')?.type, 'text')
  assert.equal(textOfId(store, 'p1'), '/')
})

test('Block JSON normalizes checked for data persisted before T12', () => {
  const root = createTextBlock({ entityId: 'norm-root', blockUid: 'norm00001', text: '旧数据' })
  const legacy = { ...root } as Record<string, unknown>
  delete legacy.checked
  const restored = parseBlock(JSON.stringify(legacy))
  assert.equal(restored.checked, false)
  assert.deepEqual(validateBlockGraph(new Map([[restored.entityId, restored]])), [])
})


test('REF-LINK-1: accepting a `[[` object link writes the ref and swaps the trigger in one transaction', () => {
  const { store } = outlineWithOtherPage()
  store.apply(tx([{ type: 'update', opId: 'type-ref', blockId: 'p1', changes: { content: [{ t: 'text', v: '参见 [[另' }] }, previous: { content: store.get('p1')!.content } }]))

  const affected = store.insertRef('p1', 'object', 'other', { trigger: '[[', query: '另', displayText: '另一页' })
  assert.deepEqual(affected, ['p1', 'p1', 'other'])
  assert.deepEqual(store.get('p1')!.content, [
    { t: 'text', v: '参见 ' },
    { t: 'inline-ref', v: '另一页', ref: { kind: 'object', targetId: 'other' } },
  ])
  assert.deepEqual(store.get('p1')!.objectRefs, ['other'])
  assert.deepEqual(store.get('other')!.objectBackRefs, ['p1'])
  assert.deepEqual(validateBlockGraph(store.snapshot()), [])

  store.undo()
  assert.deepEqual(store.get('p1')!.content, [{ t: 'text', v: '参见 [[另' }])
  assert.deepEqual(store.get('p1')!.objectRefs, [])
  assert.deepEqual(store.get('other')!.objectBackRefs, [])
})

test('REF-LINK-2: the object menu only lists active objects, filters by name and hides the source', () => {
  const { store } = outlineWithOtherPage()
  // 候选里没有**本篇**（D-014：页级自引用不出现），但有别的页面
  assert.deepEqual(store.findRefTargets('object', '', 'p1').map((candidate) => candidate.targetId), ['other'])
  assert.deepEqual(store.findRefTargets('object', '另', 'p1').map((candidate) => candidate.label), ['另一页'])
  assert.deepEqual(store.findRefTargets('object', '不存在', 'p1'), [])
  assert.deepEqual(store.findRefTargets('object', '', 'page').map((candidate) => candidate.targetId), ['other'])
  assert.deepEqual(store.findRefTargets('object', '', 'ob1').map((candidate) => candidate.targetId), ['page'], '从别页的块出发，少的是它自己那页（other）')
  store.apply(tx([{ type: 'delete', opId: 'del-other', blockId: 'other', descendantIds: ['ob1'], snapshots: [{ blockId: 'other', prevParent: null, prevIndex: 2 }, { blockId: 'ob1', prevParent: 'other', prevIndex: 0 }] }]))
  assert.deepEqual(store.findRefTargets('object', '', 'p1'), [])
})

test('REF-LINK-3: a missing or deleted target never leaves a half ref', () => {
  const { store } = outlineDocument()
  store.apply(tx([{ type: 'update', opId: 'u-ref', blockId: 'p1', changes: { content: [{ t: 'text', v: '[[页' }] }, previous: { content: store.get('p1')!.content } }]))
  assert.equal(store.insertRef('p1', 'object', 'ghost', { trigger: '[[', query: '页', displayText: '页面' }), null)
  assert.equal(store.insertRef('p1', 'object', 'page', { trigger: '[[', query: '错', displayText: '页面' }), null)
  assert.deepEqual(store.get('p1')!.content, [{ t: 'text', v: '[[页' }])
})

test('REF-LINK-4: a `((` block link writes blockRefs/blockBackRefs and rejects self reference', () => {
  const { store } = outlineDocument()
  store.apply(tx([{ type: 'update', opId: 'u-block-ref', blockId: 'p1', changes: { content: [{ t: 'text', v: '见 ((' }] }, previous: { content: store.get('p1')!.content } }]))
  assert.equal(store.insertRef('p1', 'block', 'p1', { trigger: '((', query: '', displayText: '第一段' }), null)

  const affected = store.insertRef('p1', 'block', 'p2', { trigger: '((', query: '', displayText: '第二段' })
  assert.deepEqual(affected, ['p1', 'p1', 'p2'])
  assert.deepEqual(store.get('p1')!.content, [
    { t: 'text', v: '见 ' },
    { t: 'inline-ref', v: '第二段', ref: { kind: 'block', targetId: 'p2' } },
  ])
  assert.deepEqual(store.get('p1')!.blockRefs, [{ targetBlockId: 'p2', fromBlockId: 'p1', type: 'link', context: undefined }])
  assert.deepEqual(store.get('p2')!.blockBackRefs.map((ref) => ref.fromBlockId), ['p1'])
  assert.deepEqual(validateBlockGraph(store.snapshot()), [])
})

/**
 * D-014（）：**页级自引用也拒**——不只是「同一个块」。
 *
 * `02`「自引用……不写半成品」与 `11` `REF-LINK-4`「自引用被拒」说的是自引用这件事，
 * 而实现此前只拒 `fromId === targetId`：一篇页面的正文块回头引用**本篇**既能被选中、也真能插进去，
 * 于是这一页的反链面板把自己页里的块算成「引用了我」（`backlinks.ts` 不排除同页来源）。
 * 这组断言同时钉住**两个闸**：候选里不出现本篇、直接调领域层也插不进去。
 */
test('D-014: 本篇不在候选里，也插不进自己（同页的其它块照旧允许）', () => {
  const { store, p1 } = outlineDocument()

  // 候选闸：从正文块 p1 出发，`[[` 与 `((` 都不给「本篇」
  const objects = store.findRefTargets('object', '', 'p1').map((candidate) => candidate.targetId)
  assert.ok(!objects.includes('page'), '对象候选里不该出现本篇')
  const blockTargets = store.findRefTargets('block', '', 'p1').map((candidate) => candidate.targetId)
  assert.ok(!blockTargets.includes('page'), '块候选里不该出现本篇这个页面容器')
  assert.ok(blockTargets.includes('p2') && blockTargets.includes('c1'), '同页的其它块照旧在候选里（引本页上文是常用写法）')

  // 插入闸：直接调领域层也拒（正文一个字都不动、不留半成品）
  store.apply(tx([{ type: 'update', opId: 'u-self-ref', blockId: 'p1', changes: { content: [{ t: 'text', v: '[[页' }] }, previous: { content: store.get('p1')!.content } }]))
  assert.equal(store.insertRef('p1', 'object', 'page', { trigger: '[[', query: '页', displayText: '页面' }), null)
  assert.deepEqual(store.get('p1')!.content, [{ t: 'text', v: '[[页' }])
  assert.deepEqual(store.get('page')!.objectBackRefs, [])

  // 反向对照：引**别的**页面照旧（这条闸不是「对象引用一律拒」）
  store.apply(tx([{ type: 'update', opId: 'u-other-ref', blockId: 'p1', changes: { content: [{ t: 'text', v: '[[页' }] }, previous: { content: store.get('p1')!.content } }]))
  const other = new DomainStore([...store.snapshot().values(), createTextBlock({ entityId: 'other', blockUid: 'other001', text: '另一页', isObject: true, objectName: '另一页' })])
  assert.deepEqual(other.insertRef('p1', 'object', 'other', { trigger: '[[', query: '页', displayText: '另一页' }), ['p1', 'p1', 'other'])
  assert.equal(p1.isObject, false)
})

test('REF-LINK-5: a block link target keeps its identity and binding when the block is renamed', () => {
  const { store } = outlineDocument()
  store.apply(tx([{ type: 'update', opId: 'u-rename-ref', blockId: 'p1', changes: { content: [{ t: 'text', v: '((' }] }, previous: { content: store.get('p1')!.content } }]))
  store.insertRef('p1', 'block', 'p2', { trigger: '((', query: '', displayText: '第二段' })
  store.apply(tx([{ type: 'update', opId: 'rename-p2', blockId: 'p2', changes: { content: [{ t: 'text', v: '改名后的段落' }] }, previous: { content: store.get('p2')!.content } }]))

  const fragment = store.get('p1')!.content.find((item) => item.t === 'inline-ref')!
  assert.equal(fragment.ref!.targetId, 'p2')
  assert.equal(fragment.v, '第二段')
  assert.equal(store.get('p1')!.blockRefs[0].targetBlockId, 'p2')
  assert.deepEqual(validateBlockGraph(store.snapshot()), [])
})

test('V2A-06: an object link refuses a non-object target', () => {
  const { store } = outlineDocument()
  store.apply(tx([{ type: 'update', opId: 'u-ref-p2', blockId: 'p1', changes: { content: [{ t: 'text', v: '[[' }] }, previous: { content: store.get('p1')!.content } }]))
  assert.equal(store.insertRef('p1', 'object', 'p2', { trigger: '[[', query: '', displayText: '第二段' }), null)
})

test('Content validation rejects a ref binding on a non inline-ref fragment', () => {
  const block = createTextBlock({ entityId: 'bad-ref', blockUid: 'bad00001', text: 'x' })
  block.content = [{ t: 'text', v: 'x', ref: { kind: 'object', targetId: 'page' } }]
  assert.ok(validateBlockShape(block).some((issue) => issue.code === 'ref-binding-only-on-inline-ref'))
  const missingTarget = createTextBlock({ entityId: 'bad-ref-2', blockUid: 'bad00002', text: 'x' })
  missingTarget.content = [{ t: 'inline-ref', v: 'x', ref: { kind: 'object', targetId: '' } }]
  assert.ok(validateBlockShape(missingTarget).some((issue) => issue.code === 'inline-ref-binding-invalid'))
})

test('REF-BACK-1: backlink panel lists object and block sources and hides deleted sources', () => {
  const { store } = outlineWithOtherPage()
  store.apply(tx([{ type: 'update', opId: 'u-b1', blockId: 'ob1', changes: { content: [{ t: 'text', v: '[[' }] }, previous: { content: store.get('ob1')!.content } }]))
  store.insertRef('ob1', 'object', 'page', { trigger: '[[', query: '', displayText: '页面' })
  store.apply(tx([{ type: 'update', opId: 'u-b2', blockId: 'p2', changes: { content: [{ t: 'text', v: '((' }] }, previous: { content: store.get('p2')!.content } }]))
  store.insertRef('p2', 'block', 'p1', { trigger: '((', query: '', displayText: '第一段' })

  assert.deepEqual(store.backlinks('page').map((entry) => [entry.sourceId, entry.kind]), [['ob1', 'object']])
  assert.deepEqual(store.backlinks('p1').map((entry) => [entry.sourceId, entry.kind, entry.preview]), [['p2', 'block', '第一段']])
  assert.deepEqual(store.backlinks('ghost'), [])

  store.apply(tx([{
    type: 'delete',
    opId: 'del-p2',
    blockId: 'p2',
    descendantIds: ['c1', 'c2'],
    snapshots: [
      { blockId: 'p2', prevParent: 'page', prevIndex: 1 },
      { blockId: 'c1', prevParent: 'p2', prevIndex: 0 },
      { blockId: 'c2', prevParent: 'p2', prevIndex: 1 },
    ],
  }]))
  assert.deepEqual(store.backlinks('p1'), [])
  assert.deepEqual(store.backlinks('p1', true).map((entry) => entry.sourceId), ['p2'])
})

test('V2A-05/06: a source linking the same target once per kind is listed once', () => {
  const { store } = outlineDocument()
  store.apply(tx([
    { type: 'block-ref', opId: 'r-block', fromId: 'p1', targetId: 'page', refType: 'link' },
    { type: 'object-ref', opId: 'r-object', fromId: 'p1', targetId: 'page' },
  ]))
  assert.deepEqual(store.backlinks('page').map((entry) => [entry.sourceId, entry.kind]), [['p1', 'block']])
  assert.deepEqual(validateBlockGraph(store.snapshot()), [])
})

test('PROPS-VALUE-1: typed property values coerce, set/clear and distinguish unset from checkbox false', () => {
  const select: PropertyDef = { id: 'd-status', name: '状态', type: 'select', options: [{ id: 'o-doing', label: '进行中' }], created: 0, modified: 0 }
  assert.deepEqual(coercePropertyValue(select, 'o-doing'), { defId: 'd-status', type: 'select', optionId: 'o-doing' })
  assert.equal(coercePropertyValue(select, 'o-ghost'), null)

  const checkbox: PropertyDef = { id: 'd-done', name: '完成', type: 'checkbox', created: 0, modified: 0 }
  assert.deepEqual(coercePropertyValue(checkbox, false), { defId: 'd-done', type: 'checkbox', value: false })
  assert.equal(coercePropertyValue(checkbox, 'false'), null)

  const number: PropertyDef = { id: 'd-weight', name: '权重', type: 'number', created: 0, modified: 0 }
  assert.deepEqual(coercePropertyValue(number, ' 3 '), { defId: 'd-weight', type: 'number', value: 3 })
  assert.equal(coercePropertyValue(number, ''), null)

  const value = coercePropertyValue(select, 'o-doing')!
  const set = applyPropertyValue([], value, 'd-status')
  assert.deepEqual(set, [value])
  assert.equal(applyPropertyValue(set!, value, 'd-status'), null)
  assert.deepEqual(applyPropertyValue(set!, null, 'd-status'), [])

  const falseValue = { defId: 'd-done', type: 'checkbox' as const, value: false }
  assert.equal(isPropertySet([falseValue], 'd-done'), true)
  assert.equal(isPropertySet([], 'd-done'), false)
})

test('PROPS-TAG-1: tag definitions are reused by name and legacy plain-text tags lazily register', () => {
  const first = ensureTagDef('重要', emptyRegistry(), 10)
  const second = ensureTagDef('重要', first.registry, 20)
  assert.equal(second.id, first.id)
  assert.equal(second.registry.tags.length, 1)

  const block = createTextBlock({ entityId: 'tag-b1', blockUid: 'tag00001', text: 'x' })
  block.tags = ['旧标签', first.id]
  const migrated = migratePlainTags([block], first.registry)
  assert.deepEqual(migrated.tags.map((tag) => tag.name).sort(), ['旧标签', '重要'].sort() as string[])
  assert.deepEqual(migratePlainTags([block], migrated), migrated)
})

test('T15: a root-level move reorders roots and normalizes position contiguously', () => {
  const a = createTextBlock({ entityId: 'r-a', blockUid: 'root0001', text: 'A' })
  const b = createTextBlock({ entityId: 'r-b', blockUid: 'root0002', text: 'B' })
  const c = createTextBlock({ entityId: 'r-c', blockUid: 'root0003', text: 'C' })
  const store = new DomainStore([a, b, c])
  const roots = () => [...store.snapshot().values()].filter((block) => block.parent === null).sort((left, right) => left.position - right.position || left.entityId.localeCompare(right.entityId)).map((block) => block.entityId)

  assert.deepEqual(roots(), ['r-a', 'r-b', 'r-c'])
  assert.equal(store.move('r-c', null, 0), true)
  assert.deepEqual(roots(), ['r-c', 'r-a', 'r-b'])
  assert.deepEqual(['r-c', 'r-a', 'r-b'].map((id) => store.get(id)!.position), [0, 1, 2])
  assert.equal(store.move('r-a', null, 3), true)
  assert.deepEqual(roots(), ['r-c', 'r-b', 'r-a'])
  assert.equal(validateBlockGraph(store.snapshot()).length, 0)

  store.undo()
  assert.deepEqual(roots(), ['r-c', 'r-a', 'r-b'])
  store.redo()
  assert.deepEqual(roots(), ['r-c', 'r-b', 'r-a'])
})

test('T15: delete and restore keep sibling positions contiguous', () => {
  const { store } = outlineDocument()
  store.apply(tx([{ type: 'delete', opId: 'del-c1', blockId: 'c1', descendantIds: [], snapshots: [] }]))
  assert.deepEqual(store.get('p2')!.children, ['c2'])
  assert.equal(store.get('c2')!.position, 0)

  store.undo()
  assert.deepEqual(store.get('p2')!.children, ['c1', 'c2'])
  assert.deepEqual(store.get('p2')!.children.map((id) => store.get(id)!.position), [0, 1])
  assert.equal(validateBlockGraph(store.snapshot()).length, 0)
})

test('SELECT-1: multi-select dedupes to parents in document order', () => {
  const { store } = outlineDocument()
  const blocks = store.snapshot()
  assert.deepEqual(dedupeSelection(blocks, ['c1', 'p2', 'p1']), ['p1', 'p2'])
  assert.deepEqual(dedupeSelection(blocks, ['p2', 'c1', 'c2', 'p1']), ['p1', 'p2'])
  assert.deepEqual(dedupeSelection(blocks, ['c1', 'c2']), ['c1', 'c2'])
  assert.deepEqual(dedupeSelection(blocks, []), [])
})

test('SELECT-2: copy rebuilds identity, keeps content, tags and properties, and re-registers refs', () => {
  const page = createTextBlock({ entityId: 'page', blockUid: 'page00001', text: '页面', isObject: true, objectName: '页面' })
  const p1 = createTextBlock({ entityId: 'p1', blockUid: 'p1000001', text: '第一段', parent: 'page' })
  const p2 = createTextBlock({ entityId: 'p2', blockUid: 'p2000002', text: '第二段', parent: 'page' })
  const c1 = createTextBlock({ entityId: 'c1', blockUid: 'c1000001', text: '子级一', parent: 'p2' })
  const c2 = createTextBlock({ entityId: 'c2', blockUid: 'c2000002', text: '子级二', parent: 'p2' })
  page.children = ['p1', 'p2']
  p2.children = ['c1', 'c2']
  c1.blockRefs = [{ targetBlockId: 'x', fromBlockId: 'c1', type: 'link' }]
  c1.objectRefs = ['obj']
  c1.tags = ['tag-1']
  c1.properties = [{ defId: 'def-1', type: 'text', value: '重要' }]
  const x = createTextBlock({ entityId: 'x', blockUid: 'x0000001', text: '目标' })
  const obj = createTextBlock({ entityId: 'obj', blockUid: 'obj00001', text: '对象', isObject: true, objectName: '对象' })
  const store = new DomainStore([page, p1, p2, c1, c2, x, obj])

  const rootIds = store.copy(['p2'])
  assert.equal(rootIds?.length, 1)
  const copyId = rootIds![0]
  const copy = store.get(copyId)!
  assert.notEqual(copyId, 'p2')
  assert.notEqual(copy.blockUid, 'p2000002')
  assert.deepEqual(store.get('page')!.children, ['p1', 'p2', copyId])
  assert.equal(copy.parent, 'page')
  assert.equal(copy.children.length, 2)

  const copiedC1 = store.get(copy.children[0])!
  assert.equal(copiedC1.parent, copyId)
  assert.equal(textContent(copiedC1), '子级一')
  assert.deepEqual(copiedC1.tags, ['tag-1'])
  assert.deepEqual(copiedC1.properties, [{ defId: 'def-1', type: 'text', value: '重要' }])
  assert.deepEqual(copiedC1.children, [])

  assert.equal(store.get('x')!.blockBackRefs.length, 1)
  assert.equal(store.get('x')!.blockBackRefs[0].fromBlockId, copiedC1.entityId)
  assert.deepEqual(store.get('obj')!.objectBackRefs, [copiedC1.entityId])
  assert.deepEqual(store.get('p2')!.blockRefs, [])

  assert.equal(validateBlockGraph(store.snapshot()).length, 0)
  store.undo()
  assert.deepEqual(store.get('page')!.children, ['p1', 'p2'])
  assert.equal(store.get(copyId)!.deleted, true)
})

test('V2A-09: copying multiple roots keeps every copy right after its source', () => {
  const { store } = outlineDocument()
  const rootIds = store.copy(['p1', 'p2'])!
  assert.equal(rootIds.length, 2)
  assert.deepEqual(store.get('page')!.children, ['p1', rootIds[0], 'p2', rootIds[1]])
  assert.equal(validateBlockGraph(store.snapshot()).length, 0)
})

test('SELECT-3: copy remaps internal refs to the copies and keeps aiMeta and external refs', () => {
  const page = createTextBlock({ entityId: 'page', blockUid: 'page00001', text: '页面', isObject: true, objectName: '页面' })
  const p2 = createTextBlock({ entityId: 'p2', blockUid: 'p2000002', text: '第二段', parent: 'page' })
  const c1 = createTextBlock({ entityId: 'c1', blockUid: 'c1000001', text: '子级一', parent: 'p2' })
  page.children = ['p2']
  p2.children = ['c1']
  p2.aiMeta = { action: 'summary', status: 'complete', sourceBlockIds: ['page'] }
  c1.content = [
    { t: 'text', v: '见 ' },
    { t: 'inline-ref', v: '第二段', ref: { kind: 'block', targetId: 'p2' } },
  ]
  c1.blockRefs = [
    { targetBlockId: 'p2', fromBlockId: 'c1', type: 'link' },
    { targetBlockId: 'x', fromBlockId: 'c1', type: 'mention' },
  ]
  const x = createTextBlock({ entityId: 'x', blockUid: 'x0000001', text: '外部目标' })
  const store = new DomainStore([page, p2, c1, x])

  const rootIds = store.copy(['p2'])!
  const copyId = rootIds[0]
  const copy = store.get(copyId)!
  const copiedC1 = store.get(copy.children[0])!

  assert.equal(copy.parent, 'page')
  assert.deepEqual(copy.aiMeta, { action: 'summary', status: 'complete', sourceBlockIds: ['page'] })
  assert.equal(copy.children.length, 1)
  assert.equal(copiedC1.content[1].t, 'inline-ref')
  assert.equal(copiedC1.content[1].ref?.targetId, copyId)
  assert.equal(copiedC1.blockRefs.length, 2)
  assert.deepEqual(
    copiedC1.blockRefs.find((ref) => ref.targetBlockId === copyId),
    { targetBlockId: copyId, fromBlockId: copiedC1.entityId, type: 'link', context: undefined },
  )
  assert.equal(copiedC1.blockRefs.find((ref) => ref.targetBlockId === 'x')?.type, 'mention')
  assert.equal(store.get('x')!.blockBackRefs[0].fromBlockId, copiedC1.entityId)
  assert.equal(store.get(copyId)!.blockBackRefs.some((ref) => ref.fromBlockId === copiedC1.entityId), true)
  assert.equal(validateBlockGraph(store.snapshot()).length, 0)
})

test('R09-SET-5 建属性定义查重名（忽略首尾空白与大小写）——名字是标签、键必须唯一（导出 front-matter 会用到）', () => {
  const now = Date.now()
  const first = createPropertyDef('状态', 'select', emptyRegistry(), now)
  assert.equal(first?.def.name, '状态')
  assert.equal(first?.def.type, 'select')
  assert.deepEqual(first?.def.options, [])
  assert.equal(first!.registry.properties.length, 1)

  // 同名（含首尾空白 / 大小写差异）一律拒绝，注册表不动
  assert.equal(createPropertyDef('状态', 'text', first!.registry), null)
  assert.equal(createPropertyDef(' 状态 ', 'text', first!.registry), null)
  const latin = createPropertyDef('Status', 'text', emptyRegistry(), now)
  assert.equal(createPropertyDef('status', 'text', latin!.registry), null)
  assert.equal(createPropertyDef('   ', 'text', first!.registry), null)

  // 非 select 不带 options；不同名照建
  const second = createPropertyDef('优先级', 'number', first!.registry, now + 1)
  assert.equal(second?.def.options, undefined)
  assert.equal(second?.registry.properties.length, 2)
})

test('T20: disablePropertyDef freezes a def while addPropertyOption only accepts live selects', () => {
  const registry = emptyRegistry()
  const now = Date.now()
  const def: PropertyDef = { id: 'def-1', name: '状态', type: 'select', options: [{ id: 'opt-1', label: '进行中' }], created: now, modified: now }
  const base = { ...registry, properties: [def] }

  const disabled = disablePropertyDef('def-1', base, now + 1)
  assert.equal(disabled?.properties[0].disabled, true)
  assert.equal(disabled?.properties[0].modified, now + 1)
  assert.equal(disablePropertyDef('def-1', disabled!, now + 2), null)
  assert.equal(disablePropertyDef('missing', base), null)

  const added = addPropertyOption('def-1', '已完成', disabled!)
  assert.equal(added, null)

  const live = { ...registry, properties: [{ ...def, disabled: false }] }
  const first = addPropertyOption('def-1', '已完成', live)
  assert.equal(first?.registry.properties[0].options?.length, 2)
  const second = addPropertyOption('def-1', ' 已完成 ', first!.registry)
  assert.equal(second?.optionId, first?.optionId)
  assert.equal(addPropertyOption('def-1', '  ', live), null)
  assert.equal(addPropertyOption('missing', '任意', live), null)
  const textDef = { ...registry, properties: [{ id: 'def-2', name: '备注', type: 'text' as const, created: now, modified: now }] }
  assert.equal(addPropertyOption('def-2', '任意', textDef), null)

  assert.deepEqual(coercePropertyValue(disabled!.properties[0], 'opt-1'), { defId: 'def-1', type: 'select', optionId: 'opt-1' })
})

test('T08/θ4: 选项维护（改名 / 删除 / 排序）＋ 定义排序——**数组序即数据**，越界与无操作一律 null', () => {
  const now = Date.now()
  const defs: PropertyDef[] = [
    { id: 'def-1', name: '状态', type: 'select', options: [{ id: 'opt-1', label: '进行中' }, { id: 'opt-2', label: '已完成' }], created: now, modified: now },
    { id: 'def-2', name: '备注', type: 'text', created: now, modified: now },
  ]
  const registry = { ...emptyRegistry(), properties: defs }

  // 改名：**值不动**（取值按 optionId 挂，改名只换显示名与导出文字）；撞别的选项名 / 空名 / 不存在的 id = null
  const renamed = renamePropertyOption('def-1', 'opt-1', ' 进行中（改） ', registry, now + 1)
  assert.deepEqual(renamed?.properties[0].options?.map((option) => option.label), ['进行中（改）', '已完成'])
  assert.equal(renamed?.properties[0].modified, now + 1)
  assert.equal(renamePropertyOption('def-1', 'opt-1', '已完成', registry), null, '撞别的选项名 ⇒ 拒')
  assert.equal(renamePropertyOption('def-1', 'opt-1', '   ', registry), null)
  assert.equal(renamePropertyOption('def-1', 'missing', '任意', registry), null)

  // 删除选项：只动注册表（引用它的取值由动作层先清——体例同 deletePropertyDef）
  assert.deepEqual(removePropertyOption('def-1', 'opt-2', registry)?.properties[0].options?.map((option) => option.id), ['opt-1'])
  assert.equal(removePropertyOption('def-1', 'missing', registry), null)

  // 排序：`def.options` 数组序 = 数据；同位置 / 不存在的 id = 无操作（返回 null 不写盘）
  assert.deepEqual(movePropertyOption('def-1', 'opt-2', 0, registry)?.properties[0].options?.map((option) => option.id), ['opt-2', 'opt-1'])
  assert.deepEqual(movePropertyOption('def-1', 'opt-1', 99, registry)?.properties[0].options?.map((option) => option.id), ['opt-2', 'opt-1'], '越界夹到末尾')
  assert.equal(movePropertyOption('def-1', 'opt-1', 0, registry), null)
  assert.equal(movePropertyOption('def-1', 'missing', 0, registry), null)

  // 定义排序：`registry.properties` 数组序 = 数据（摘要条属性行与卡片属性行同序）
  assert.deepEqual(movePropertyDef('def-2', 0, registry)?.properties.map((def) => def.id), ['def-2', 'def-1'])
  assert.equal(movePropertyDef('def-1', 0, registry), null)
  assert.equal(movePropertyDef('missing', 0, registry), null)
})

test('T20: collapsedAncestors lists collapsed ancestors nearest first', () => {
  const { store } = outlineDocument()
  store.apply(tx([
    { type: 'collapse', opId: 'collapse-page', blockId: 'page', collapsed: true },
    { type: 'collapse', opId: 'collapse-p2', blockId: 'p2', collapsed: true },
  ]))
  assert.deepEqual(collapsedAncestors(store.snapshot(), 'c1'), ['p2', 'page'])
  assert.deepEqual(collapsedAncestors(store.snapshot(), 'p1'), ['page'])
  assert.deepEqual(collapsedAncestors(store.snapshot(), 'page'), [])
})

test('T20: validation rejects dangling refs and sourceless accepted aiMeta', () => {
  const dangling = createTextBlock({ entityId: 'dangle', blockUid: 'dangle01', text: '断链' })
  dangling.content = [{ t: 'inline-ref', v: 'x', ref: { kind: 'block', targetId: 'ghost' } }]
  dangling.blockRefs = [{ targetBlockId: 'ghost', fromBlockId: 'dangle', type: 'link' }]
  dangling.objectRefs = ['ghost']
  const codes = validateBlockGraph(new Map([['dangle', dangling]])).map((issue) => issue.code)
  assert.equal(codes.includes('dangling-inline-ref'), true)
  assert.equal(codes.includes('dangling-block-ref'), true)
  assert.equal(codes.includes('dangling-object-ref'), true)

  const sourceless = createTextBlock({ entityId: 'ai-empty', blockUid: 'aiempty1', text: '总结' })
  sourceless.aiMeta = { action: 'summary', status: 'complete', sourceBlockIds: [] }
  assert.equal(validateBlockShape(sourceless).some((issue) => issue.code === 'ai-meta-source-required'), true)
  const cancelled = createTextBlock({ entityId: 'ai-cancel', blockUid: 'aicancel1', text: '取消' })
  cancelled.aiMeta = { action: 'actions', status: 'cancelled', sourceBlockIds: [] }
  assert.equal(validateBlockShape(cancelled).length, 0)
})

test('SELECT-4: batch delete removes each deduped root once and undoes as one step', () => {
  const { store } = outlineDocument()
  const deleted = store.deleteSelection(['p1', 'p2', 'c1'])
  assert.deepEqual(deleted, ['p1', 'p2'])
  assert.deepEqual(store.get('page')!.children, [])
  assert.equal(store.get('p1')!.deleted, true)
  assert.equal(store.get('c1')!.deleted, true)
  assert.equal(validateBlockGraph(store.snapshot()).length, 0)

  store.undo()
  assert.deepEqual(store.get('page')!.children, ['p1', 'p2'])
  assert.deepEqual(store.get('p2')!.children, ['c1', 'c2'])
  assert.equal(store.get('p1')!.deleted, false)
  assert.equal(store.get('p2')!.position, 1)
})

// T6 ⑤（`09-桌面端交互规范` §九 `R09-KEY-21`）：块选中态「复制 / 剪切 / 复制为块引用」写进剪贴板的**文本形态**。
// 纯函数在域层（`domain/selectionText.ts`），界面只负责塞剪贴板；这里的判据 = 不丢链 + 层级用缩进。
test('SELECT-10: 选区转文本 —— 子树按层级缩进、行内引用还原成 ((…)) / [[…]] 不丢链', () => {
  const page = createTextBlock({ entityId: 'page', blockUid: 'page00001', text: '页面', isObject: true, objectName: '页面' })
  const a = createTextBlock({ entityId: 'a', blockUid: 'a0000001', text: '第一段 ', parent: 'page' })
  a.content = [
    { t: 'text', v: '第一段 ' },
    { t: 'inline-ref', v: '第二段', ref: { kind: 'block', targetId: 'b' } },
    { t: 'text', v: ' 收尾' },
  ]
  const b = createTextBlock({ entityId: 'b', blockUid: 'b0000001', text: '第二段', parent: 'page' })
  const c = createTextBlock({ entityId: 'c', blockUid: 'c0000001', text: '子级', parent: 'b' })
  const d = createTextBlock({ entityId: 'd', blockUid: 'd0000001', text: '别页', isObject: true, objectName: '别页' })
  page.children = ['a', 'b']
  b.children = ['c']
  const blocks = new Map([page, a, b, c, d].map((block) => [block.entityId, block]))

  assert.equal(
    selectionAsText(blocks, ['a', 'b'], 'plain'),
    ['第一段 ((第二段)) 收尾', '第二段', '\t子级'].join('\n'),
    'plain：根一条、子树一级一个 Tab、行内引用还原成文字形态',
  )
  assert.equal(refToken(blocks.get('b')!), '((第二段))', 'refToken：块引用文字的单一形态')
  assert.equal(selectionAsText(blocks, ['b'], 'ref'), '((第二段))', 'ref：块引用一条一行')
  assert.equal(refLabel(blocks.get('d')!), '别页', 'refLabel：页面容器用页名（与候选菜单同源）')
  assert.equal(selectionAsText(blocks, ['d'], 'ref'), '[[别页]]', 'ref：页面容器用 [[页名]]')
  assert.equal(selectionAsText(blocks, ['b', 'c'], 'plain'), ['第二段', '\t子级'].join('\n'), '子级被父级去重，不重复出现')
  assert.equal(selectionAsText(blocks, ['missing'], 'plain'), '')
})

test('BlockNode maps a Block tree to Lexical and back without persisting node keys', () => {
  const root = createTextBlock({ entityId: 'lex-root', blockUid: 'lex000001', text: '标题' })
  root.type = 'heading1'
  root.content = [
    { t: 'text', v: '粗体', marks: [{ type: 'bold' }] },
    { t: 'inline-ref', v: 'target-block' },
  ]
  root.tags = ['保留']
  root.objectRefs = ['object-1']
  root.blockRefs = [{ targetBlockId: 'lex-child', fromBlockId: root.entityId, type: 'link' }]
  const child = createTextBlock({ entityId: 'lex-child', blockUid: 'lex000002', text: '子节点', parent: root.entityId })
  root.children = [child.entityId]
  const original = new Map([[root.entityId, root], [child.entityId, child]])
  const editor = createMoqiEditor()
  const state = editorStateFromBlocks(editor, original)
  const json = state.toJSON()
  const serialized = JSON.stringify(json)
  assert.equal(serialized.includes('lex-root'), true)
  assert.equal(serialized.includes('lex000001'), true)
  assert.equal(serialized.includes('key'), false)

  const roundTrip = blocksFromEditor(editor, original)
  assert.equal(roundTrip.get('lex-root')?.type, 'heading1')
  assert.deepEqual(roundTrip.get('lex-root')?.content, root.content)
  assert.deepEqual(roundTrip.get('lex-root')?.children, ['lex-child'])
  assert.equal(roundTrip.get('lex-child')?.parent, 'lex-root')
  assert.deepEqual(roundTrip.get('lex-root')?.tags, ['保留'])
  assert.deepEqual(roundTrip.get('lex-root')?.objectRefs, ['object-1'])
  assert.deepEqual(roundTrip.get('lex-root')?.blockRefs, root.blockRefs)
})

test('V2A-10/11: aiMeta defaults to null and round-trips through Block JSON', () => {
  const legacy = createTextBlock({ entityId: 'legacy', blockUid: 'legacy01', text: '旧段落' })
  const raw = JSON.parse(serializeBlock(legacy)) as Record<string, unknown>
  assert.equal(raw.aiMeta, null)
  assert.equal(parseBlock(JSON.stringify(raw)).aiMeta, null)

  const result = createTextBlock({ entityId: 'ai-1', blockUid: 'ai100001', text: '总结' })
  result.aiMeta = { action: 'summary', status: 'needs-confirmation', sourceBlockIds: ['legacy'] }
  assert.deepEqual(parseBlock(serializeBlock(result)).aiMeta, result.aiMeta)
  assert.equal(validateBlockShape(result).length, 0)

  const broken = createTextBlock({ entityId: 'ai-2', blockUid: 'ai200002', text: '坏' })
  broken.aiMeta = { action: 'summary', status: 'unknown', sourceBlockIds: [] } as never
  assert.deepEqual(validateBlockShape(broken).map((issue) => issue.code), ['ai-meta-invalid'])
})

/**
 * D-018（，用真实模型实测抓到）：「整篇」的来源必须**展开成子树**。
 *
 * 面板宫格传进来的是 `[pageId]`，而 `dedupeSelection` 不替它展开 ⇒ 六项指令只把**页面名**
 * 喂给了模型（润色的输出就是「产品路线」四个字）。`R09-AIB-12` 当年只修了标签与落点。
 */
test('D-018: expandAiSources —— 整篇展开成子树、选区原样、已删除块不进来', () => {
  const { store } = outlineDocument()
  const page = store.get('page')!
  const blocks = store.snapshot()
  // 整篇：页面块 → 页面自己 + 全部存活后代（p1、p2、c1、c2）
  assert.deepEqual(
    expandAiSources(blocks, { sourceIds: ['page'], scope: 'page', byBlockSelection: false }),
    ['page', 'p1', 'p2', 'c1', 'c2'],
    '整篇 = 整棵子树（顺序按文档序）',
  )
  // 选区：原样，不展开（选区语义就是这些块）
  assert.deepEqual(
    expandAiSources(blocks, { sourceIds: ['p2'], scope: 'selection', byBlockSelection: false }),
    ['p2'],
    '选区档不许顺手展开成子树',
  )
  // 已删除的块不进来源
  store.apply(tx([{ type: 'delete', opId: 'del-c1', blockId: 'c1', descendantIds: [], snapshots: [{ blockId: 'c1', prevParent: 'p2', prevIndex: 0 }] }]))
  assert.ok(!expandAiSources(store.snapshot(), { sourceIds: ['page'], scope: 'page', byBlockSelection: false }).includes('c1'))
  assert.equal(page.isObject, true)
})

/**
 * R09-AIPANEL-3c（ 用户裁决「③+②」）：面板宫格的**作用范围按动作分两类**。
 *
 * 产出型（总结 / 提取行动 / 反问我）产出新内容、天然跨块 ⇒ 保留整篇；
 * 改写型（润色 / 扩写 / 换角度）的输出是逐行改写 ⇒ 只作用于一段（多块或无目标都不给跑）。
 * 这个纯函数同时供渲染（按钮禁用 + 宫格下方的原因文案）与执行（组装 `AiRequestPlan`）使用。
 */
test('R09-AIPANEL-3c: 面板宫格作用范围分档 —— 产出型走整篇、改写型一次一段（多块与无目标都挡）', () => {
  // 产出型：整篇（来源 = 页面块，实际展开由 expandAiSources 负责）
  assert.deepEqual(
    aiPanelGate({ action: 'summary', selectedBlocks: [], caretBlockId: null, pageId: 'page' }),
    { kind: 'ready', plan: { sourceIds: ['page'], scope: 'page', byBlockSelection: false } },
  )
  // 改写型：单块选中 → 那个块（按块选中的档位，落点也按它）
  assert.deepEqual(
    aiPanelGate({ action: 'polish', selectedBlocks: ['b1'], caretBlockId: 'b2', pageId: 'page' }),
    { kind: 'ready', plan: { sourceIds: ['b1'], scope: 'selection', byBlockSelection: true } },
  )
  // 改写型：只有光标 → 光标所在的一段
  assert.deepEqual(
    aiPanelGate({ action: 'reframe', selectedBlocks: [], caretBlockId: 'b2', pageId: 'page' }),
    { kind: 'ready', plan: { sourceIds: ['b2'], scope: 'selection', byBlockSelection: false } },
  )
  // 改写型：多块选中 → 不给跑，原因说得出（一次只改一段）
  const multi = aiPanelGate({ action: 'expand', selectedBlocks: ['b1', 'b2'], caretBlockId: 'b3', pageId: 'page' })
  assert.equal(multi.kind, 'blocked')
  if (multi.kind === 'blocked') assert.ok(multi.reason.includes('一次只改一段'), multi.reason)
  // 改写型：没有目标 → 不给跑，并且指路（先选中）
  const none = aiPanelGate({ action: 'polish', selectedBlocks: [], caretBlockId: null, pageId: 'page' })
  assert.equal(none.kind, 'blocked')
  if (none.kind === 'blocked') assert.ok(none.reason.includes('选中'), none.reason)
  // 产出型但没打开页面 → 也挡（不让它静默 no-op）
  assert.equal(aiPanelGate({ action: 'askback', selectedBlocks: [], caretBlockId: null, pageId: null }).kind, 'blocked')
  // 分类本身：三项产出型 / 三项改写型，谁都不能漂
  assert.deepEqual((['summary', 'actions', 'askback'] as const).map(aiOpScope), ['page', 'page', 'page'])
  assert.deepEqual((['polish', 'expand', 'reframe'] as const).map(aiOpScope), ['single', 'single', 'single'])
})

test('AI-INSERT-1: AI results insert after the source subtree with provenance and never touch the source', () => {
  const { store } = outlineDocument()
  const sourceBefore = structuredClone(store.get('p2')!)
  const built = insertAiResults(store.snapshot(), {
    sourceIds: ['p2'],
    action: 'summary',
    items: ['这是一段总结'],
    status: 'complete',
    confidence: 0.8,
    request: { provider: 'stub', model: 'stub', requestedAt: 1 },
    now: 1000,
  })
  assert.ok(built)
  assert.equal(built!.blockIds.length, 1)
  store.apply(built!.transaction)

  const result = store.get(built!.blockIds[0])!
  assert.equal(result.type, 'text')
  assert.equal(textContent(result), '这是一段总结')
  assert.deepEqual(result.aiMeta?.sourceBlockIds, ['p2'])
  assert.equal(result.aiMeta?.action, 'summary')
  assert.equal(result.aiMeta?.confidence, 0.8)
  assert.deepEqual(store.get('p2')!.children, sourceBefore.children)
  assert.equal(textContent(store.get('p2')!), textContent(sourceBefore))

  const actions = insertAiResults(store.snapshot(), { sourceIds: ['p2'], action: 'actions', items: ['买牛奶', '写周报'], status: 'complete' })!
  store.apply(actions.transaction)
  assert.deepEqual(actions.blockIds.map((id) => store.get(id)!.type), ['todo', 'todo'])
  assert.deepEqual(actions.blockIds.map((id) => store.get(id)!.checked), [false, false])
  assert.deepEqual(store.get(actions.blockIds[0])!.aiMeta?.sourceBlockIds, ['p2'])
})

/**
 * D-016②：跨页提问「存成新页」——**建页与结果插入同一个事务**（一步撤销把整页收回去），
 * 页名写进首行（`R04-NAME-7` 派生，名字即首行），出处照旧记在 `aiMeta.sourceBlockIds`。
 */
test('AI-INSERT-2（D-016②）：存成新页是一步撤销，页名即首行', () => {
  const { store } = outlineDocument()
  const before = store.snapshot().size
  const created = store.insertAiResultsIntoNewPage({
    sourceIds: ['p1', 'p2'],
    action: 'ask',
    items: ['这是一条跨页回答'],
    status: 'complete',
    sourceScope: 'page',
    pageName: aiAnswerPageName('双链笔记怎么用'),
  })
  assert.ok(created)
  const page = store.get(created!.pageId)!
  assert.equal(page.isObject, true)
  assert.equal(page.objectName, '问 AI：双链笔记怎么用')
  assert.equal(textContent(page), '问 AI：双链笔记怎么用', '页名同时是首行')
  assert.deepEqual(page.children, created!.blockIds, '回答就在这一页里面（不是根级）')
  const answer = store.get(created!.blockIds[0])!
  assert.equal(textContent(answer), '这是一条跨页回答')
  assert.deepEqual(answer.aiMeta?.sourceBlockIds, ['p1', 'p2'])
  assert.equal(store.snapshot().size, before + 2, '多了一页 + 一个回答块')

  store.undo()
  // 撤销走软删（块留在图上、标记 deleted）：**一步撤销把页与回答一起收掉**才是「同一个事务」的判据
  assert.equal(store.get(created!.pageId)?.deleted, true, '一步撤销：整页连着回答都收回去')
  assert.equal(store.get(created!.blockIds[0])?.deleted, true, '回答块与页同一事务（拆成两次的话这一次撤销只带得走一个）')
})

test('AI-INSERT-3（D-016②）：页名取问句前 12 字、空白压平，问句为空回落「自由问答」', () => {
  assert.equal(aiAnswerPageName('  双链笔记\n怎么用  '), '问 AI：双链笔记 怎么用')
  assert.equal(aiAnswerPageName('一二三四五六七八九十十一十二十三'), '问 AI：一二三四五六七八九十十一')
  assert.equal(aiAnswerPageName(undefined), '问 AI：自由问答')
  assert.equal(aiAnswerPageName('   '), '问 AI：自由问答')
})

test('V2A-10/11: AI insert is a no-op without items or sources', () => {
  const { store } = outlineDocument()
  assert.equal(insertAiResults(store.snapshot(), { sourceIds: ['p1'], action: 'summary', items: [], status: 'complete' }), null)
  assert.equal(insertAiResults(store.snapshot(), { sourceIds: [], action: 'summary', items: ['x'], status: 'complete' }), null)
})

test('UNDO-MIRROR-1: 镜像写回不占撤销步，一次撤销仍然撤掉最近那次结构动作', () => {
  const { store } = outlineDocument()
  store.indent('p2')
  // AI 流式生成按节拍写回正文走镜像（EditorShell.flushAiStream → convertType(mirror)）。
  store.convertType('p2', 'heading2', [{ t: 'text', v: '流式第一拍' }], { mirror: true })
  store.convertType('p2', 'heading2', [{ t: 'text', v: '流式第一拍第二拍' }], { mirror: true })
  assert.equal(textContent(store.get('p2')!), '流式第一拍第二拍')

  store.undo()
  // 撤销撤掉的是缩进（唯一那条真实记录），流式写回的正文留在原地。
  assert.equal(store.get('p2')!.parent, 'page')
  assert.equal(textContent(store.get('p2')!), '流式第一拍第二拍')
})

test('AI-ACTIONS-1: 「提取行动」用同一个事务替换生成占位块，撤销一次即整批退回', () => {
  const { store } = outlineDocument()
  const placeholder = createTextBlock({ entityId: 'ai1', blockUid: 'ai000001', text: '', parent: 'page' })
  placeholder.aiMeta = { action: 'actions', status: 'generating', sourceBlockIds: ['p2'] }
  store.apply(tx([{ type: 'insert', opId: 'op-ai', block: placeholder, parentId: 'page', index: 2 }]))
  store.convertType('ai1', 'text', [{ t: 'text', v: '（流式中间态）' }], { mirror: true })

  const built = insertAiResults(store.snapshot(), {
    sourceIds: ['p2'], action: 'actions', items: ['买牛奶', '写周报'], status: 'complete', removeBlockIds: ['ai1'],
  })!
  // 结果块与占位块同属一个事务：占位块随结果落库一起被替换掉，不需要额外一次撤销步。
  assert.deepEqual(built.transaction.operations.map((operation) => operation.type), ['insert', 'insert', 'delete'])
  store.apply(built.transaction)
  assert.equal(store.get('ai1')!.deleted, true)
  assert.equal(store.get('page')!.children.includes('ai1'), false)
  assert.deepEqual(built.blockIds.map((id) => store.get(id)!.type), ['todo', 'todo'])

  store.undo()
  assert.equal(store.get('ai1')!.deleted, false)
  assert.deepEqual(built.blockIds.map((id) => store.get(id)!.deleted), [true, true])
  assert.equal(validateBlockGraph(store.snapshot()).length, 0)
})

test('04 §5: 占位块已被删除或不存在时，替换事务照常成立（不产生空操作）', () => {
  const { store } = outlineDocument()
  const built = insertAiResults(store.snapshot(), {
    sourceIds: ['p2'], action: 'summary', items: ['总结'], status: 'complete', removeBlockIds: ['not-here', 'p2-not-a-block'],
  })!
  assert.deepEqual(built.transaction.operations.map((operation) => operation.type), ['insert'])
  store.apply(built.transaction)
  assert.equal(validateBlockGraph(store.snapshot()).length, 0)
})

test('V2A-10/11: StubAIPort is deterministic and supports cancel/error', async () => {
  const port = new StubAIPort({ items: ['固定行动'], status: 'needs-confirmation' })
  const proposal = await port.generate({ action: 'actions', sources: ['p1'], text: '任意' }, new AbortController().signal)
  assert.deepEqual(proposal.items, ['固定行动'])
  assert.equal(proposal.status, 'needs-confirmation')

  const failing = new StubAIPort({ failWith: '模型不可用' })
  await assert.rejects(() => failing.generate({ action: 'summary', sources: [], text: '' }, new AbortController().signal), /模型不可用/)

  const slow = new StubAIPort({ delayMs: 5000 })
  const controller = new AbortController()
  const pending = slow.generate({ action: 'summary', sources: [], text: '' }, controller.signal)
  controller.abort()
  await assert.rejects(() => pending, /aborted/)
})

test('V2A-10/11: AiService maps cancel and error to distinct results', async () => {
  const summary = new AiService(new StubAIPort({ items: ['总结'], status: 'complete' }))
  const ok = await summary.run('summary', ['p1'], '内容', new AbortController().signal)
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.ok ? ok.proposal.items : [], ['总结'])

  const failing = new AiService(new StubAIPort({ failWith: '超时' }))
  const error = await failing.run('summary', ['p1'], '内容', new AbortController().signal)
  assert.deepEqual(error, { ok: false, cancelled: false, error: '超时' })

  const slow = new AiService(new StubAIPort({ delayMs: 5000 }))
  const controller = new AbortController()
  const pending = slow.run('actions', ['p1'], '内容', controller.signal)
  controller.abort()
  assert.deepEqual(await pending, { ok: false, cancelled: true })
})

test('V2A-10/11: OpenAICompatibleAIPort sends chat completions and parses items', async () => {
  let captured: { url: string; body: unknown; auth?: string } | null = null
  const fetchStub = (async (url: string, init: RequestInit) => {
    captured = { url, body: JSON.parse(String(init.body)), auth: (init.headers as Record<string, string>).Authorization }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '- 第一条\n- 第二条' } }] }) }
  }) as unknown as typeof fetch

  const port = new OpenAICompatibleAIPort({ baseUrl: 'https://api.example.com/v1/', apiKey: 'secret', model: 'demo' }, fetchStub)
  const proposal = await port.generate({ action: 'actions', sources: ['p1'], text: '正文' }, new AbortController().signal)
  assert.equal(captured!.url, 'https://api.example.com/v1/chat/completions')
  assert.equal(captured!.auth, 'Bearer secret')
  assert.deepEqual(captured!.body, { model: 'demo', messages: [
    { role: 'system', content: '你是大纲笔记助手。请从用户内容中提取可执行行动项，每行一项，只输出行动项，不要编号或前言。' },
    { role: 'user', content: '正文' },
  ] })
  assert.deepEqual(proposal.items, ['第一条', '第二条'])
  assert.equal(proposal.request.model, 'demo')
})

test('V2A-04: switching between <p>-tagged types swaps the marker class without a reload', async () => {
  const classes = new Set<string>()
  const dom = {
    dataset: {} as Record<string, string>,
    classList: {
      add: (name: string) => { classes.add(name) },
      remove: (name: string) => { classes.delete(name) },
      toggle: (name: string, on: boolean) => { if (on) classes.add(name); else classes.delete(name) },
      contains: (name: string) => classes.has(name),
    },
    get className() { return [...classes].join(' ') },
    set className(value: string) { classes.clear(); for (const name of value.split(/\s+/)) if (name) classes.add(name) },
  } as unknown as HTMLElement

  const editor = createMoqiEditor()
  let sameTagChanged: boolean | undefined
  let headingRecreated: boolean | undefined
  await new Promise<void>((resolve) => {
    editor.update(() => {
      const text = new BlockNode('e1', 'u1000001', 'text')
      dom.className = `moqi-block ${blockTypeClassName('text')}`

      const bullet = new BlockNode('e1', 'u1000001', 'bullet')
      sameTagChanged = bullet.updateDOM(text, dom, {} as never)
      const numbered = new BlockNode('e1', 'u1000001', 'numbered')
      numbered.updateDOM(bullet, dom, {} as never)
      const todo = new BlockNode('e1', 'u1000001', 'todo')
      todo.updateDOM(numbered, dom, {} as never)
      const heading = new BlockNode('e1', 'u1000001', 'heading1')
      headingRecreated = heading.updateDOM(todo, dom, {} as never)
    }, { onUpdate: () => resolve() })
  })

  assert.equal(sameTagChanged, false)
  assert.ok(dom.classList.contains(blockTypeClassName('todo')))
  assert.ok(!dom.classList.contains(blockTypeClassName('bullet')))
  assert.ok(!dom.classList.contains(blockTypeClassName('numbered')))
  assert.ok(!dom.classList.contains(blockTypeClassName('text')))
  assert.equal(dom.dataset.blockType, 'todo')
  assert.equal(headingRecreated, true)
})

test('被领域校验拒绝的写入必须原子回滚，不能把块图留在不自洽状态', () => {
  const { store } = outlineDocument()
  const before = store.snapshot()
  // 制造一条非法插入：parent 指向不存在的块，校验应在提交时报错。
  assert.throws(() => {
    store.apply(tx([{
      type: 'insert',
      opId: 'bad-insert',
      block: createTextBlock({ entityId: 'orphan', blockUid: 'orphan0001', text: '孤儿' }),
      parentId: 'missing-parent',
      index: 0,
    }]))
  })
  // 回滚后快照与写入前**逐块全等**（`store.apply` 不再先备份整库——它靠的就是
  // 「applyTransaction 只碰工作副本、校验通过才回灌」这条不变式，这条深等断言守着它），
  // 后续合法写入仍然可用。
  assert.deepEqual(store.snapshot(), before)
  assert.equal(store.get('orphan'), undefined)
  assert.deepEqual(validateBlockGraph(store.snapshot()), [])
  assert.deepEqual(store.convertType('p1', 'bullet'), ['p1'])
  assert.deepEqual(validateBlockGraph(store.snapshot()), [])
})

test('STORE-HEAL-1 dropDanglingChildren 只清理指向不存在块的引用，其余结构保持原样', () => {
  const page = createTextBlock({ entityId: 'p', blockUid: 'p0000001', isObject: true, objectName: '页面' })
  const keep = createTextBlock({ entityId: 'k', blockUid: 'k0000001', text: '保留', parent: 'p' })
  page.children = ['k', 'ghost']
  const result = dropDanglingChildren([page, keep])
  assert.equal(result.removed, 1)
  assert.deepEqual(result.repairedBlockIds, ['p'])
  assert.deepEqual(result.blocks.find((block) => block.entityId === 'p')!.children, ['k'])
  assert.deepEqual(validateBlockGraph(new Map(result.blocks.map((block) => [block.entityId, block]))), [])
  // 修复结果再跑一次是恒等操作
  const clean = dropDanglingChildren(result.blocks)
  assert.equal(clean.removed, 0)
  assert.deepEqual(clean.repairedBlockIds, [])
})

test('STORE-HEAL-2 adoptOrphanedChildren 把漏记 children 的块按 position 收回父级', () => {
  const page = createTextBlock({ entityId: 'p', blockUid: 'p0000001', isObject: true, objectName: '页面' })
  const first = createTextBlock({ entityId: 'a', blockUid: 'a0000001', text: '一', parent: 'p' })
  const third = createTextBlock({ entityId: 'c', blockUid: 'c0000001', text: '三', parent: 'p' })
 // 复现 的坏数据：子块 parent 指向 page，但 page.children 里没有它
  const orphan = createTextBlock({ entityId: 'b', blockUid: 'b0000001', text: '二', parent: 'p' })
  first.position = 0
  orphan.position = 1
  third.position = 2
  page.children = ['a', 'c']

  const result = adoptOrphanedChildren([page, first, orphan, third])
  assert.equal(result.adopted, 1)
  assert.deepEqual(result.adoptedBlockIds, ['b'])
  assert.deepEqual(result.rootedBlockIds, [])
  assert.deepEqual(result.blocks.find((block) => block.entityId === 'p')!.children, ['a', 'b', 'c'])
  // 自愈后的图必须是自洽的——这正是当初卡住编辑器的那条校验
  assert.deepEqual(validateBlockGraph(new Map(result.blocks.map((block) => [block.entityId, block]))), [])

  // 修复结果再跑一次是恒等操作
  const clean = adoptOrphanedChildren(result.blocks)
  assert.equal(clean.adopted, 0)
  assert.deepEqual(clean.blocks.find((block) => block.entityId === 'p')!.children, ['a', 'b', 'c'])
})

test('adoptOrphanedChildren 把找不到父级的块降级为根块', () => {
  const orphan = createTextBlock({ entityId: 'x', blockUid: 'x0000001', text: '孤儿', parent: 'gone' })
  const result = adoptOrphanedChildren([orphan])
  assert.deepEqual(result.rootedBlockIds, ['x'])
  assert.equal(result.blocks[0].parent, null)
  assert.deepEqual(validateBlockGraph(new Map(result.blocks.map((block) => [block.entityId, block]))), [])
})

test('adoptOrphanedChildren 不动自洽的图（对象相同，避免无谓落盘）', () => {
  const page = createTextBlock({ entityId: 'p', blockUid: 'p0000001', isObject: true, objectName: '页面' })
  const child = createTextBlock({ entityId: 'k', blockUid: 'k0000001', text: '正文', parent: 'p' })
  page.children = ['k']
  const result = adoptOrphanedChildren([page, child])
  assert.equal(result.adopted, 0)
  assert.equal(result.blocks[0], page)
  assert.equal(result.blocks[1], child)
})

test('STORE-TOUCH-1 touchedBlockIds 把父块算进来：插入 / 移动都会改父块的 children', () => {
  const inserted = createTextBlock({ entityId: 'n', blockUid: 'n0000001', parent: 'p' })
 // 行尾 ＋：新块落在父块 p 下——p 的 children 变了，必须一起落盘（漏掉就是 的只读故障）
  assert.deepEqual(
    touchedBlockIds([{ type: 'insert', opId: 'o1', block: inserted, parentId: 'p', index: 0 }]).sort(),
    ['n', 'p'],
  )
  // 缩进：移动块自己 + 两个父块（旧父块的 children 少一条、新父块的多一条）
  assert.deepEqual(
    touchedBlockIds([{ type: 'move', opId: 'o2', blockId: 'n', oldParentId: 'p', oldIndex: 0, newParentId: 'q', newIndex: 0 }]).sort(),
    ['n', 'p', 'q'],
  )
  // 删除：块 + 后代 + 它们原来的父块
  assert.deepEqual(
    touchedBlockIds([{ type: 'delete', opId: 'o3', blockId: 'n', descendantIds: ['n2'], snapshots: [{ blockId: 'n', prevParent: 'p', prevIndex: 0 }] }]).sort(),
    ['n', 'n2', 'p'],
  )
  // 纯内容更新只动它自己
  assert.deepEqual(
    touchedBlockIds([{ type: 'update', opId: 'o4', blockId: 'n', changes: { content: [] }, previous: { content: [] } }]),
    ['n'],
  )
  // store 会把它们攒起来，交给落盘方取走
  const page2 = createTextBlock({ entityId: 'p2', blockUid: 'p2000001', isObject: true, objectName: '页面2' })
  const store = new DomainStore([page2])
  const child = createTextBlock({ entityId: 'c2', blockUid: 'c2000001', parent: 'p2' })
  store.apply({ id: 't1', timestamp: Date.now(), source: 'user', operations: [{ type: 'insert', opId: 'o5', block: child, parentId: 'p2', index: 0 }] })
  assert.deepEqual(store.takeTouched().sort(), ['c2', 'p2'])
  assert.deepEqual(store.takeTouched(), [])
})

// ---------- 页面对象名唯一性（docs/09 §4.3、docs/06） ----------

const objectMap = (names: { id: string; name: string; deleted?: boolean }[]) => {
  const map = new Map()
  for (const item of names) {
    const block = createTextBlock({ entityId: item.id, blockUid: `${item.id}000001`, text: '', isObject: true, objectName: item.name })
    if (item.deleted) block.deleted = true
    map.set(item.id, block)
  }
  return map as unknown as Parameters<typeof validateBlockGraph>[0]
}

test('PAGENAME-COPY-2 程序生成的页面名（复制 / 程序命名）：撞名时自动编号，不产生重名', () => {
  const blocks = objectMap([{ id: 'a', name: '未命名页面' }, { id: 'b', name: '未命名页面 2' }])
  assert.equal(availableCopyName(blocks, '未命名页面'), '未命名页面 3')
  assert.equal(availableCopyName(blocks, '读书笔记'), '读书笔记')
  // 空名字退回默认名，仍然唯一
  assert.equal(availableCopyName(blocks, '   '), '未命名页面 3')
})

test('PAGENAME-COPY-3 程序生成的页面名排除自己（改成自己的名字不算撞名）', () => {
  const blocks = objectMap([{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }])
  assert.equal(availableCopyName(blocks, '乙', 'a'), '乙 2')
  assert.equal(availableCopyName(blocks, '甲', 'a'), '甲', '改成自己的名字不算撞名')
})

test('PAGENAME-COPY-4 程序生成的页面名不避开回收站里的名字', () => {
  const blocks = objectMap([{ id: 'a', name: '回收站里的页面', deleted: true }])
  assert.equal(availableCopyName(blocks, '回收站里的页面'), '回收站里的页面')
})

test('PAGENAME-DUP-1 页面名允许重名（docs/04 §3）：链接靠 targetId 指向，不靠名字', () => {
  const duplicated = objectMap([{ id: 'a', name: '未命名页面' }, { id: 'b', name: '未命名页面' }])
  assert.equal(validateBlockGraph(duplicated).some((issue) => issue.code === 'duplicate-object-name'), false, '同名不再是错误')
})

test('类型转换不丢正文：不传新内容时原样保留（含行内格式与引用）', () => {
  const page = createTextBlock({ entityId: 'page', blockUid: 'page00001', text: '页面', isObject: true, objectName: '页面' })
  const block = createTextBlock({ entityId: 'p1', blockUid: 'p1000001', text: '重要正文', parent: 'page' })
  block.content = [{ t: 'text', v: '重要', marks: [{ type: 'bold' }] }, { t: 'text', v: '正文' }]
  const blocks = new Map([[page.entityId, page], [block.entityId, block]])
  page.children = ['p1']
  const transaction = convertBlockType(blocks, 'p1', 'heading1')
  assert.ok(transaction, '转换必须产生事务')
  const update = transaction!.operations[0]
  assert.equal(update.type, 'update')
  assert.deepEqual((update as Extract<Operation, { type: 'update' }>).changes.content, block.content, '不传内容时正文必须原样保留')
  applyTransaction(blocks, { ...transaction!, inverse: [] })
  assert.equal(textContent(blocks.get('p1')!), '重要正文')
})

test('转换成分隔线时正文移到新块，不会凭空消失', () => {
  const page = createTextBlock({ entityId: 'page', blockUid: 'page00001', text: '页面', isObject: true, objectName: '页面' })
  const block = createTextBlock({ entityId: 'p1', blockUid: 'p1000001', text: '要留下的字', parent: 'page' })
  const blocks = new Map([[page.entityId, page], [block.entityId, block]])
  page.children = ['p1']
  const transaction = convertBlockType(blocks, 'p1', 'divider')
  assert.ok(transaction)
  applyTransaction(blocks, { ...transaction!, inverse: [] })
  assert.equal(textContent(blocks.get('p1')!), '', '分隔线自身没有正文')
  assert.equal(textContent(blocks.get('page')!.children.map((id) => blocks.get(id)!).find((child) => child.entityId !== 'p1')!), '要留下的字')
})

test('REF-LINK-6: 触发词落在块内任意位置也能替换（工具条「选中文字 → 转链接」那条路）', () => {
  // 打字触发时触发词是块尾后缀；工具条是在选中文字处插入触发词，它在文字中间：
  // 两条路共用同一个领域入口，靠 offset 指明触发词起点（docs/09 §6.9）。
  const { store } = outlineWithOtherPage()
  store.apply(tx([{ type: 'update', opId: 'u-mid-ref', blockId: 'p1', changes: { content: [{ t: 'text', v: '开头[[选中部分]结尾' }] }, previous: { content: store.get('p1')!.content } }]))

  // 触发词 `[[` 在第 2 个字（"开头" 之后），查询词是「选中部分」，尾部还有正文
  const affected = store.insertRef('p1', 'object', 'other', { trigger: '[[', query: '选中部分', displayText: '另一页', offset: 2 })
  assert.deepEqual(affected, ['p1', 'p1', 'other'])
  assert.deepEqual(store.get('p1')!.content, [
    { t: 'text', v: '开头' },
    { t: 'inline-ref', v: '另一页', ref: { kind: 'object', targetId: 'other' } },
    { t: 'text', v: ']结尾' },
  ])
  assert.equal(validateBlockGraph(store.snapshot()).length, 0)
})

test('REF-LINK-7: offset 处的文字与「触发词 + 查询词」不符时是 no-op（不写半截引用）', () => {
  const { store } = outlineDocument()
  store.apply(tx([{ type: 'update', opId: 'u-mid-ref-2', blockId: 'p1', changes: { content: [{ t: 'text', v: '开头[[选中部分]结尾' }] }, previous: { content: store.get('p1')!.content } }]))
  assert.equal(store.insertRef('p1', 'object', 'page', { trigger: '[[', query: '别的内容', displayText: '页面', offset: 2 }), null)
  assert.equal(store.insertRef('p1', 'object', 'page', { trigger: '[[', query: '选中部分', displayText: '页面', offset: 9 }), null)
  assert.deepEqual(store.get('p1')!.content, [{ t: 'text', v: '开头[[选中部分]结尾' }])
})

test('REF-LINK-8: 触发词准备把选中文字原样留在原地（工具条「选中文字 → 转链接」）', () => {
  const { store } = outlineWithOtherPage()
  const content = [{ t: 'text' as const, v: '把段随手写的词变成链接' }]
  // 选中「段随手」（下标 1，长度 3）：结果应是 把 + [[段随手 + 写的词变成链接
  const prepared = insertRefTrigger(content, 1, 3, '[[')
  // 分片边界由 splitContentAtOffset 决定：把 | [[段随手 | 写的词变成链接（拼起来与原文一致）
  assert.deepEqual(prepared, [{ t: 'text', v: '把' }, { t: 'text', v: '[[段随手' }, { t: 'text', v: '写的词变成链接' }])
  // 之后领域按「触发词 + 查询词」整段替换，替换后原文仍是同一段文字
  store.apply(tx([{ type: 'update', opId: 'u-prep', blockId: 'p1', changes: { content: prepared! }, previous: { content: store.get('p1')!.content } }]))
  const affected = store.insertRef('p1', 'object', 'other', { trigger: '[[', query: '段随手', displayText: '段随手', offset: 1 })
  assert.deepEqual(affected, ['p1', 'p1', 'other'])
  assert.deepEqual(store.get('p1')!.content, [
    { t: 'text', v: '把' },
    { t: 'inline-ref', v: '段随手', ref: { kind: 'object', targetId: 'other' } },
    { t: 'text', v: '写的词变成链接' },
  ])
})

test('REF-LINK-9: 触发词准备——没选中文字时只在光标处插一个触发词，越界则 no-op', () => {
  const content = [{ t: 'text' as const, v: '这里是光标' }]
  assert.deepEqual(insertRefTrigger(content, 5, 0, '[['), [{ t: 'text', v: '这里是光标' }, { t: 'text', v: '[[' }])
  assert.equal(insertRefTrigger(content, 99, 0, '[['), null)
  assert.equal(insertRefTrigger(content, 4, 99, '[['), null)
})

test('REF-LINK-10: 块引用候选的标签与提示说人话（空块给占位、提示给所属页面）', () => {
  const { store } = outlineWithOtherPage()
  const candidates = store.findRefTargets('block', '', 'p2')
  assert.ok(!candidates.some((candidate) => candidate.targetId === 'page'), '本篇这个页面容器不进候选（D-014）')
  const other = candidates.find((candidate) => candidate.targetId === 'other')!
  assert.equal(other.label, '另一页', '页面容器的候选标签应是页名，而不是「(空 Block)」')
  assert.equal(other.hint, '另一页')
  const p1 = candidates.find((candidate) => candidate.targetId === 'p1')!
  assert.equal(p1.label, '第一段')
  assert.equal(p1.hint, '页面', '提示应是所属页面，不再是内部 blockUid')
})

test('PAGENAME-DERIVE-2 页面名由首行派生：空行回落「未命名页面」，写入内容时自动重算（docs/04 §3）', () => {
  const page = createTextBlock({ entityId: 'p', blockUid: 'p0000001', isObject: true, objectName: '未命名页面' })
  assert.equal(derivedObjectName(page), '未命名页面')
  assert.equal(derivedObjectName({ ...page, content: [{ t: 'text', v: '  风格与对话  ' }] }), '风格与对话')
  const blocks = new Map([[page.entityId, page]])
  const tx = (operations: Operation[]) => applyTransaction(blocks, { id: 't1', operations, inverse: [], timestamp: Date.now(), source: 'user' })
  tx([{ type: 'update', opId: 'o1', blockId: 'p', changes: { content: [{ t: 'text', v: '改首行当改名' }] }, previous: {} }])
  assert.equal((blocks.get('p') as { objectName: string }).objectName, '改首行当改名', '对象块写入内容后 objectName 自动跟随')
})

test('PAGENAME-LINK-1 [[ 候选按页面名找到其他页面（页面名 = 首行，docs/04 §3）', () => {
  const pageA = createTextBlock({ entityId: 'pa', blockUid: 'pa000001', isObject: true, objectName: '甲页' })
  const pageB = createTextBlock({ entityId: 'pb', blockUid: 'pb000001', isObject: true, objectName: '乙页' })
  const pageC = createTextBlock({ entityId: 'pc', blockUid: 'pc000001', isObject: true, objectName: '丙页' })
  const body = createTextBlock({ entityId: 'b1', blockUid: 'b1000001', text: '正文', parent: 'pa' })
  pageA.children = ['b1']
  const blocks = new Map([pageA, pageB, pageC, body].map((block) => [block.entityId, block]))
  const all = searchRefTargets(blocks, 'object', '', 'b1')
  assert.deepEqual(all.map((c) => c.label).sort(), ['乙页', '丙页'].sort(), '别的页面都能被 [[ 找到，标签就是页面名')
  assert.ok(!all.some((c) => c.targetId === 'pa'), '唯独不含本篇自己（D-014：页级自引用不出现）')
  const filtered = searchRefTargets(blocks, 'object', '乙', 'b1')
  assert.deepEqual(filtered.map((c) => c.label), ['乙页'], '输入查询词按页面名过滤')
})

test('PAGENAME-DERIVE-1 页面名派生覆盖所有写入路径：insert 新页面 / restore 恢复也会重算（docs/04 §3）', () => {
  const page = createTextBlock({ entityId: 'p', blockUid: 'p0000001', isObject: true, objectName: '随便写的' })
  const blocks = new Map([[page.entityId, page]])
  applyTransaction(blocks, { id: 't1', inverse: [], timestamp: Date.now(), source: 'user', operations: [
    { type: 'insert', opId: 'o1', block: createTextBlock({ entityId: 'child', blockUid: 'c0000001', text: '第一行文字', parent: 'p' }), parentId: 'p', index: 0 },
  ] })
  assert.equal((blocks.get('p') as { objectName: string }).objectName, '未命名页面', '容器自己没有内容时回落占位')
  // 容器自身内容改掉 → 名字跟随（不论走的是哪条操作）
  applyTransaction(blocks, { id: 't2', inverse: [], timestamp: Date.now(), source: 'user', operations: [
    { type: 'update', opId: 'o2', blockId: 'p', changes: { content: [{ t: 'text', v: '真正的页名' }] }, previous: {} },
  ] })
  assert.equal((blocks.get('p') as { objectName: string }).objectName, '真正的页名')
})

test('PAGENAME-LINK-2 同名页面在 [[ 候选里能区分：提示给页内摘要（docs/04 §3 第二步）', () => {
  // 源块放在**第三页**上：两个同名页面都得是「别的页面」，才测得到同名区分（D-014 之后自己那页不进候选）
  const pageHome = createTextBlock({ entityId: 'ph', blockUid: 'ph000001', isObject: true, objectName: '出发页' })
  const pageA = createTextBlock({ entityId: 'pa', blockUid: 'pa000001', isObject: true, objectName: '未命名页面' })
  const pageB = createTextBlock({ entityId: 'pb', blockUid: 'pb000001', isObject: true, objectName: '未命名页面' })
  const homeBody = createTextBlock({ entityId: 'h1', blockUid: 'h1000001', text: '出发页的正文', parent: 'ph' })
  const aBody = createTextBlock({ entityId: 'a1', blockUid: 'a1000001', text: '甲页的正文', parent: 'pa' })
  const bBody = createTextBlock({ entityId: 'b1', blockUid: 'b1000001', text: '乙页的正文', parent: 'pb' })
  pageHome.children = ['h1']
  pageA.children = ['a1']
  pageB.children = ['b1']
  const blocks = new Map([pageHome, pageA, pageB, homeBody, aBody, bBody].map((block) => [block.entityId, block]))
  const candidates = searchRefTargets(blocks, 'object', '未命名', 'h1')
  assert.deepEqual(candidates.map((c) => c.label), ['未命名页面', '未命名页面'], '两个同名页面都在候选里')
  assert.deepEqual(candidates.map((c) => c.hint), ['甲页的正文', '乙页的正文'], '提示给出页内摘要，用来区分同名')
  const emptyPage = createTextBlock({ entityId: 'pc', blockUid: 'pc000001', isObject: true, objectName: '未命名页面' })
  const withEmpty = new Map([...blocks, ['pc', emptyPage]] as [string, typeof emptyPage][])
  assert.ok(searchRefTargets(withEmpty, 'object', '未命名', 'h1').some((c) => c.hint === '空页面'), '没有任何正文的页面提示「空页面」')
})

test('PAGENAME-RESTORE-2 载入迁移：老数据的 objectName 落进正文首行（页面名 = 首行，2026-09-28 用户实测）', () => {
  const legacy = createTextBlock({ entityId: 'p1', blockUid: 'p1000001', isObject: true, objectName: '老的页面名' })
  const placeholder = createTextBlock({ entityId: 'p2', blockUid: 'p2000001', isObject: true, objectName: '未命名页面' })
  const already = createTextBlock({ entityId: 'p3', blockUid: 'p3000001', isObject: true, objectName: '一致', text: '一致' })
  const result = adoptObjectNames([legacy, placeholder, already])
  assert.deepEqual(result.adopted, [{ entityId: 'p1', name: '老的页面名' }], '只迁移「名字会丢」的那些')
  assert.equal((result.blocks.find((b) => b.entityId === 'p1')!.content[0] as { v: string }).v, '老的页面名', '名字写进首行内容')
  assert.equal(result.blocks.find((b) => b.entityId === 'p2')!.content.map((f) => f.v).join('').trim(), '', '占位名不动（首行仍为空）')
  assert.equal((result.blocks.find((b) => b.entityId === 'p3')!.content as unknown[]).length, 1, '已经一致的也不动')
})

test('PAGENAME-COPY-1 复制页的名字与首行一致（名字 = 首行，docs/04 §3.1）', () => {
  // 复制页时把新名字写进副本首行——否则派生会把副本名字改回源页名字
  const page = createTextBlock({ entityId: 'src', blockUid: 'src00001', isObject: true, objectName: '源页', text: '源页' })
  const body = createTextBlock({ entityId: 'b', blockUid: 'b0000001', text: '正文', parent: 'src' })
  page.children = ['b']
  const blocks = new Map([page, body].map((block) => [block.entityId, block]))
  const copyId = 'copy'
  const copy = createTextBlock({ entityId: copyId, blockUid: 'copy0001', isObject: true, objectName: '源页', text: '源页' })
  blocks.set(copyId, copy)
  applyTransaction(blocks, { id: 't', inverse: [], timestamp: Date.now(), source: 'user', operations: [
    { type: 'update', opId: 'o', blockId: copyId, changes: { content: [{ t: 'text', v: '源页（副本）' }] }, previous: { content: copy.content } },
  ] })
  assert.equal((blocks.get(copyId) as { objectName: string }).objectName, '源页（副本）', '副本名字跟随它的首行')
})

test('PAGENAME-RESTORE-1 还原后的页面名字跟着首行（含老数据把 objectName 落进首行）', () => {
  const legacy = createTextBlock({ entityId: 'old', blockUid: 'old00001', isObject: true, objectName: '老页名' })
  const adopted = adoptObjectNames([legacy])
  assert.equal(adopted.adopted.length, 1)
  const blocks = new Map(adopted.blocks.map((block) => [block.entityId, block]))
  // 还原走的是 restore 操作，随后任何写入都会经 applyTransaction 的派生重算
  applyTransaction(blocks, { id: 't', inverse: [], timestamp: Date.now(), source: 'user', operations: [
    { type: 'restore', opId: 'o', blockId: 'old', snapshots: [{ blockId: 'old', prevParent: null, prevIndex: 0 }] },
  ] })
  assert.equal((blocks.get('old') as { objectName: string }).objectName, '老页名', '名字不丢')
})

test('载入不丢 aiMeta 的新字段：sourceScope 保留、ask 动作、generating 与 accepted 状态不再被判非法（R09-AIB-7）', () => {
  const page = createTextBlock({ entityId: 'page', blockUid: 'page00001', text: '页面', isObject: true, objectName: '页面' })
  const ai = createTextBlock({ entityId: 'a1', blockUid: 'a1000001', text: '结果', parent: 'page' })
  ai.aiMeta = { action: 'summary', sourceBlockIds: ['page'], sourceScope: 'page', status: 'complete' }
  const ask = createTextBlock({ entityId: 'a2', blockUid: 'a2000001', text: '问答', parent: 'page' })
  ask.aiMeta = { action: 'ask', sourceBlockIds: ['page'], status: 'generating' }
  // 采用（方案 A：界面什么都不显示，只留数据）之后 `aiMeta` 必须挺过载入——丢成 null 就等于「没有保留」。
  const accepted = createTextBlock({ entityId: 'a3', blockUid: 'a3000001', text: '已采纳', parent: 'page' })
  accepted.aiMeta = { action: 'actions', sourceBlockIds: ['page'], sourceScope: 'selection', status: 'accepted' }
  page.children = ['a1', 'a2', 'a3']
  const store = new DomainStore([page, ai, ask, accepted])
  const roundTrip = parseBlock(JSON.stringify(store.get('a1')!))
  assert.equal(roundTrip.aiMeta?.sourceScope, 'page', 'sourceScope 必须挺过载入（白名单重建器会把它丢掉）')
  const askRound = parseBlock(JSON.stringify(store.get('a2')!))
  assert.equal(askRound.aiMeta?.action, 'ask', 'ask 动作不能被测成非法而丢成 null')
  assert.equal(askRound.aiMeta?.status, 'generating', 'generating 状态保留，由启动时的收口流程处理')
  const acceptedRound = parseBlock(JSON.stringify(store.get('a3')!))
  assert.equal(acceptedRound.aiMeta?.status, 'accepted', 'accepted 必须挺过载入，否则块角 ✦ 与悬停出处都会消失')
  assert.equal(acceptedRound.aiMeta?.sourceScope, 'selection', '已采纳块的来源范围同样要留下')
  assert.equal(validateBlockShape(acceptedRound).some((issue) => issue.code === 'ai-meta-invalid'), false, 'accepted 是合法状态')
})

// ── V2b: 页面置顶与星标（`PIN` / `STAR`，docs/11 §3.17 / §3.18）─────────────

/** 六个页面，created 递增 —— 用来断言置顶组内的稳定顺序。 */
function sixPages(): DomainStore {
  return new DomainStore(
    ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) =>
      createTextBlock({ entityId: id, blockUid: `${id}0000001`, text: `页面 ${id}`, isObject: true, objectName: `页面 ${id}`, now: 1000 + index }),
    ),
  )
}

test('PIN-FIELD-1 新页面的 pinned / starred 默认 false；旧数据载入时补出默认值', () => {
  const page = createTextBlock({ entityId: 'p', blockUid: 'p0000001', text: '页面', isObject: true, objectName: '页面' })
  assert.equal(page.pinned, false)
  assert.equal(page.starred, false)

  // 模拟 0.2.0 之前落盘的 Block——那时还没有这两个字段
  const legacy = JSON.parse(JSON.stringify(page)) as Record<string, unknown>
  delete legacy.pinned
  delete legacy.starred
  const loaded = parseBlock(JSON.stringify(legacy))
  assert.equal(loaded.pinned, false)
  assert.equal(loaded.starred, false, '从旧库读出来的页面必须有这两个字段，不能是 undefined')
})

test('PIN-ORDER-1 置顶页排在 orderedRootIds 最前，组内按既有顺序稳定排列，取消后回原位', () => {
  const store = sixPages()
  assert.deepEqual(orderedRootIds(store.snapshot()), ['a', 'b', 'c', 'd', 'e', 'f'])

  store.setPinned('d', true)
  store.setPinned('b', true)
  assert.deepEqual(orderedRootIds(store.snapshot()), ['b', 'd', 'a', 'c', 'e', 'f'], '置顶的在前；组内仍按原顺序（b 在 d 前），不因置顶动作互相跳位')

  store.setPinned('b', false)
  assert.deepEqual(orderedRootIds(store.snapshot()), ['d', 'a', 'b', 'c', 'e', 'f'], '取消置顶回到它原来的位置（position 从未被改动）')
})

test('PIN-LIMIT-2 第 6 个置顶被领域层拒绝，且不产生 transaction', () => {
  const store = sixPages()
  for (const id of ['a', 'b', 'c', 'd', 'e']) assert.equal(store.setPinned(id, true), true, `${id} 应该能置顶`)

  const undoBefore = store.canUndo()
  assert.equal(store.setPinned('f', true), false, '第 6 个必须被拒绝')
  assert.equal(store.get('f')?.pinned, false, '被拒绝后不能改到数据')
  assert.equal(store.canUndo(), undoBefore, '被拒绝不能产生 transaction——否则会污染撤销栈与 oplog')

  assert.equal(store.canPin('f'), false, '界面据此把「置顶」置灰')
  assert.equal(store.canPin('a'), true, '已置顶的页面仍可操作（取消置顶）')

  store.setPinned('a', false)
  assert.equal(store.canPin('f'), true, '腾出一个位置后又能置顶')
  assert.equal(store.setPinned('f', true), true)
})

test('PIN-SHAPE-1 非页面块不许 pinned / starred；超限只报告、不卡死写入', () => {
  const page = createTextBlock({ entityId: 'p', blockUid: 'p0000001', text: '页面', isObject: true, objectName: '页面' })
  const body = createTextBlock({ entityId: 'b', blockUid: 'b0000001', text: '正文', parent: 'p' })
  body.pinned = true
  body.starred = true
  const codes = validateBlockShape(body).map((issue) => issue.code)
  assert.ok(codes.includes('pinned-must-be-false-on-non-object'))
  assert.ok(codes.includes('starred-must-be-false-on-non-object'))
  assert.equal(validateBlockShape(page).some((issue) => issue.code.startsWith('pinned-') || issue.code.startsWith('starred-')), false, '页面本身合法')

  // 超限状态（例如从没有上限的版本合并进来）必须只报告——否则 assertValidBlockGraph
  // 会拒绝每一次写入，软件表现成「能看不能写」。
  const over = new Map(
    ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => {
      const block = createTextBlock({ entityId: id, blockUid: `${id}0000001`, text: id, isObject: true, objectName: id, now: 1000 + index })
      block.pinned = true
      return [id, block] as const
    }),
  )
  assert.equal(validateBlockGraph(over).filter((issue) => issue.code === 'pinned-limit-exceeded').length, 1, '第 6 个起逐个报告')
  assert.doesNotThrow(() => assertValidBlockGraph(over), '超限不能进 STRUCTURAL_CODES')
})

test('PIN-DEFAULT-1 置顶页成为 orderedRootIds 首位（打开软件时的默认页）', () => {
  const store = sixPages()
  store.setPinned('e', true)
  assert.equal(orderedRootIds(store.snapshot())[0], 'e')
})

test('PIN-COPY-1 复制页面不继承 pinned / starred', () => {
  const store = sixPages()
  store.setPinned('a', true)
  store.setStarred('a', true)
  const copied = store.copy(['a'])
  assert.ok(copied && copied.length === 1)
  const copy = store.get(copied![0]!)
  assert.equal(copy?.pinned, false, '副本不该白占一个置顶位')
  assert.equal(copy?.starred, false, '副本是新页面，星标不跟着走')
})

test('STAR-FIELD-1 星标只做标记，不改排序；置顶与星标经序列化往返都不丢', () => {
  const store = sixPages()
  store.setStarred('c', true)
  assert.deepEqual(orderedRootIds(store.snapshot()), ['a', 'b', 'c', 'd', 'e', 'f'], '星标不影响顺序')

  store.setPinned('b', true)
  const round = parseBlockGraph(serializeBlockGraph(store.snapshot()))
  assert.equal(round.get('b')?.pinned, true)
  assert.equal(round.get('c')?.starred, true)
  assert.equal(round.get('a')?.pinned, false)
})

// ── V2b: 回收站的「从本机彻底删除」/「清空回收站」（`LIFECYCLE-PURGE-*`，docs/03 §14.5 层 2）──

/** 三个页面：page（带子块 c1）/ page2 / keep —— 用来断言「整棵子树一起删、没删的不动」。 */
function trashDoc(): DomainStore {
  const page = createTextBlock({ entityId: 'page', blockUid: 'page00001', text: '待删页面', isObject: true, objectName: '待删页面' })
  const c1 = createTextBlock({ entityId: 'c1', blockUid: 'c1000001', text: '子块', parent: 'page' })
  page.children = ['c1']
  const page2 = createTextBlock({ entityId: 'page2', blockUid: 'page20001', text: '第二个待删', isObject: true, objectName: '第二个待删', now: 2000 })
  const keep = createTextBlock({ entityId: 'keep', blockUid: 'keep00001', text: '留着的页面', isObject: true, objectName: '留着的页面', now: 3000 })
  return new DomainStore([page, c1, page2, keep])
}

test('LIFECYCLE-PURGE-1 从本机彻底删除：整棵子树消失、进待删集合、不产生 transaction', () => {
  const store = trashDoc()
  store.deleteSelection(['page'])
  assert.equal(store.snapshot().get('page')?.deleted, true, '先软删除（层 1）')

  const removed = store.purge(['page', 'c1'])
  assert.equal(removed, 2, '整棵子树都摘掉')
  assert.equal(store.snapshot().has('page'), false, '块图里彻底没有它')
  assert.equal(store.snapshot().has('c1'), false)
  assert.deepEqual(store.takePurged().sort(), ['c1', 'page'], '落盘方据此删行')
  assert.deepEqual(store.takePurged(), [], '取过就清空——否则同一批会被反复删')
})

test('LIFECYCLE-PURGE-3 现在没有墓碑：删掉的是整行消失，不是 deleted=1', () => {
  const store = trashDoc()
  store.deleteSelection(['page'])
  store.purge(['page', 'c1'])
  const map = store.snapshot()
  assert.equal([...map.values()].some((block) => block.entityId === 'page'), false,
    '同步落地前每个用户都是单机用户（docs/03 §14.5 规则 3）→ 真删，不留墓碑')
  assert.equal(map.has('keep'), true, '没被删的页面不受影响')
})

test('LIFECYCLE-PURGE-1 彻底删除把涉及它的历史步骤踢出撤销栈（撤销不会撞到已删块）', () => {
  const store = trashDoc()
  store.deleteSelection(['page']) // 这步的逆操作是 restore(page)，它引用即将被删的块
  assert.equal(store.canUndo(), true)

  store.purge(['page', 'c1'])
  assert.equal(store.canUndo(), false, '涉及已删块的历史步骤必须踢掉——否则撤销会 mustGet 抛错')
  assert.doesNotThrow(() => store.undo())
  assert.doesNotThrow(() => store.redo())
  assert.equal(store.snapshot().has('keep'), true, '撤销不会把别的页面也弄丢')
})

test('LIFECYCLE-PURGE-1 删不在块图里的 id 是 no-op（不记待删、不报错）', () => {
  const store = trashDoc()
  assert.equal(store.purge(['nope']), 0)
  assert.deepEqual(store.takePurged(), [])
})

test('LIFECYCLE-PURGE-2 清空回收站：一次删掉多个页面，存活页面不受影响', () => {
  const store = trashDoc()
  store.deleteSelection(['page', 'page2'])
  assert.equal(store.purge(['page', 'c1', 'page2']), 3)
  assert.deepEqual(orderedRootIds(store.snapshot()), ['keep'])
  assert.deepEqual(store.takePurged().sort(), ['c1', 'page', 'page2'])
})

test('LIFECYCLE-PURGE-1 只摘根不摘子树会留下孤儿——所以调用方必须给整棵子树', () => {
  // 这条是安全网的反面：store.purge 会替父块清掉死引用，但**摘了一半的子树**仍然是
  // 结构性错误（子块的 parent 指向已不存在的块）。测试锁住「给全子树就干净」这个契约。
  const store = trashDoc()
  const removed = store.purge(['page', 'c1'])
  assert.equal(removed, 2)
  const issues = validateBlockGraph(store.snapshot()).filter((issue) => issue.code === 'missing-parent')
  assert.deepEqual(issues, [], '整棵子树一起删 → 没有指向不存在父块的子块')
  assert.doesNotThrow(() => assertValidBlockGraph(store.snapshot()), '删干净之后块图仍然自洽（不是只读）')
})

test('LIFECYCLE-PURGE-5 彻底删除的子树按 parent 链收，包含父块 children 已摘掉的软删除子块', () => {
  const page = createTextBlock({ entityId: 'page', blockUid: 'page00005', text: '页面', isObject: true, objectName: '页面' })
  const live = createTextBlock({ entityId: 'live', blockUid: 'live00001', text: '活着', parent: 'page' })
  const soft = createTextBlock({ entityId: 'soft', blockUid: 'soft00001', text: '更早删除', parent: 'page' })
  soft.deleted = true
  const grand = createTextBlock({ entityId: 'grand', blockUid: 'grand0001', text: '软删除块的子块', parent: 'soft' })
  grand.deleted = true
  // 父块的可见 children 只有 live；soft 与 grand 只靠 parent 链挂在这棵树上。
  page.children = ['live']
  const blocks = new Map([page, live, soft, grand].map((block) => [block.entityId, block]))

  assert.deepEqual(
    new Set(purgeSubtreeIds(blocks.values(), ['page'])),
    new Set(['page', 'live', 'soft', 'grand']),
    '软删除后代必须一起收，否则数据库外键会让彻底删除回滚（D-091）',
  )
})

test('LIFECYCLE-PURGE-4 保留期到期判定：严格过 30 天才算过期，老数据退回 modified', () => {
  const DAY = 24 * 60 * 60 * 1000
  const now = 1_000_000_000_000
  const trashed = (id: string, deletedAt: number | null, modified: number) => {
    const block = createTextBlock({ entityId: id, blockUid: `${id}000001`, text: id, isObject: true, objectName: id, now: modified })
    block.deleted = true
    block.deletedAt = deletedAt
    return block
  }
  const fresh = trashed('fresh', now - 29 * DAY, now)
  const exact = trashed('exact', now - TRASH_RETENTION_DAYS * DAY, now)
  const stale = trashed('stale', now - 31 * DAY, now)
  // 老数据（软删除早于 deletedAt 字段）没有 deletedAt —— 退回 modified，
  // 口径与 remainingDays 一致；否则「剩余 0 天」的条目会永远留在回收站里。
  const legacy = trashed('legacy', null, now - 40 * DAY)

  assert.deepEqual(expiredTrashIds([fresh, exact, stale, legacy], now).sort(), ['legacy', 'stale'],
    '严格小于才过期——正好第 30 天还没到点，界面显示「剩余 0 天」的第 30 天才该被清掉')
})

// ── V2b: 变更日志的地基（`SYNC-QUEUE-1`，docs/03 §14.2）──────────────────
// 此前 `oplog` / `transaction_history` 只存在于设计文档里——没有任何代码写它们。
// 这一组锁住「每一次会改块图的路径都排进待写日志」这个契约。

test('SYNC-QUEUE-1 四条会改块图的路径都排进待写日志（应用 / 镜像 / 撤销 / 重做）', () => {
  const store = trashDoc()
  assert.deepEqual(store.takeCommittedTransactions(), [], '初始没有待写事务')

  store.deleteSelection(['page'])
  const afterDelete = store.takeCommittedTransactions()
  assert.equal(afterDelete.length, 1, '一次领域动作 = 一条待写事务')
  assert.equal(afterDelete[0].source, 'user')
  assert.ok(afterDelete[0].inverse.length > 0, '事务必须带逆操作——「留旧版」靠它')
  assert.deepEqual(store.takeCommittedTransactions(), [], '取过就清空，避免同一批被反复写')

  store.undo()
  assert.equal(store.takeCommittedTransactions().length, 1, '撤销也是一次要同步的变化')
  store.redo()
  assert.equal(store.takeCommittedTransactions().length, 1, '重做同理')

  store.applyMirror(tx([{ type: 'collapse', opId: crypto.randomUUID(), blockId: 'keep', collapsed: true }]))
  assert.equal(store.takeCommittedTransactions().length, 1, '打字走镜像路径——它同样必须进日志')
})

test('SYNC-QUEUE-1 空事务不进日志（no-op 不该在 oplog 里留痕）', () => {
  const store = trashDoc()
  store.applyMirror(tx([]))
  assert.deepEqual(store.takeCommittedTransactions(), [], '没有操作的事务不占 seq')
})

test('STORE-HEAL-3 分隔线不承载正文：线上那份挪到紧随其后的新块（父子两档都覆盖）', () => {
 // 用户实测：转换路径只改当前节点，镜像又把正文写回线上——线上与下面各留一份。
  const page = createTextBlock({ entityId: 'dpage', blockUid: 'dpage001', isObject: true, objectName: '分隔线检查' })
  const rootDivider = createTextBlock({ entityId: 'dr', blockUid: 'dr000001', parent: null, text: '根上的正文' })
  rootDivider.type = 'divider'
  const childDivider = createTextBlock({ entityId: 'dc', blockUid: 'dc000001', parent: 'dpage', text: '子层正文' })
  childDivider.type = 'divider'
  page.children = ['dc']

  const result = adoptDividerBodies([page, rootDivider, childDivider])
  assert.equal(result.adopted.length, 2)

  const clearedRoot = result.blocks.find((block) => block.entityId === 'dr')!
  const clearedChild = result.blocks.find((block) => block.entityId === 'dc')!
  assert.deepEqual(clearedRoot.content, [], '线上的正文必须挪走')
  assert.deepEqual(clearedChild.content, [])

  // 根级：新块紧跟其后（数组顺序 + position 在半格之后）
  const rootIndex = result.blocks.findIndex((block) => block.entityId === 'dr')
  const rootSibling = result.blocks[rootIndex + 1]
  assert.equal(rootSibling.content[0].v, '根上的正文')
  assert.equal(rootSibling.parent, null)
  assert.ok(rootSibling.position > clearedRoot.position)

  // 子层：父块的 children 里插在分隔线后面，新块挂在同一个父级
  const parentAfter = result.blocks.find((block) => block.entityId === 'dpage')!
  assert.deepEqual(parentAfter.children, ['dc', result.adopted[1].movedInto])
  const childSibling = result.blocks.find((block) => block.entityId === result.adopted[1].movedInto)!
  assert.equal(childSibling.content[0].v, '子层正文')
  assert.equal(childSibling.parent, 'dpage')

  // 块图仍然自洽；再跑一次是恒等
  assert.deepEqual(validateBlockGraph(new Map(result.blocks.map((block) => [block.entityId, block]))), [])
  assert.equal(adoptDividerBodies(result.blocks).adopted.length, 0)
})

test('R09-AIB-11 / R09-AIPANEL-3：每一条 AI 指令的动作都要过领域校验（新增动作必须同步三处白名单）', () => {
  // 这个坑踩过两次：AiAction 加了新值、而「合法动作」的三处白名单（`validation.ts` 的 validAction、
  // `serialization.ts` 的载入 actions、`AI_ACTION_LABEL` 的键）没跟上——症状不是报错，
  // 而是载入时整条 aiMeta 被判非法、**静默丢成 null**（R09-AIB-11），或者新指令生成出来的块
  // 被 `ai-meta-invalid` 挡掉（V2c 加四项指令时当场撞上）。这条用例把三者钉在一起：
  // 往 AI_UI_OPS 里加指令、却忘了同步白名单，它就会红。
  const blocks = new Map<string, ReturnType<typeof createTextBlock>>()
  let index = 0
  for (const op of AI_UI_OPS) {
    if (!op.action) continue
    index += 1
    const block = createTextBlock({ entityId: `ai-${op.action}`, blockUid: `ai${String(index).padStart(6, '0')}`, parent: null })
    block.content = [{ t: 'text', v: '生成的正文' }]
    block.aiMeta = { action: op.action, sourceBlockIds: ['src'], sourceScope: 'selection', status: 'needs-confirmation' }
    blocks.set(block.entityId, block)
    assert.equal(AI_ACTION_LABEL[op.action]?.length > 0, true, `${op.action} 要有用户可见的名字`)
  }
  const source = createTextBlock({ entityId: 'src', blockUid: 'src00001', parent: null })
  source.content = [{ t: 'text', v: '来源' }]
  blocks.set(source.entityId, source)
  const issues = validateBlockGraph(blocks)
  assert.deepEqual(issues.filter((issue) => issue.code === 'ai-meta-invalid'), [], '每条指令的 aiMeta 都必须合法')
  assert.equal(issues.length, 0, `AI 指令的块图应当整体自洽，实际：${JSON.stringify(issues)}`)
})

// ---------------------------------------------------------------------------
// Markdown 导出（13-导出与媒体设计（已归档） §2–§5；规则 `09-桌面端交互规范` §6.4 R09-EXPORT-1…6）
// 命名用规则 ID（`R09-` 前缀）而不是行为 ID——行为 ID 那种形状会被「行为登记门」要求进 `11`，
// 而 `11` 卡在体量棘轮上（见 `05` 的欠账行）。
// ---------------------------------------------------------------------------
const mkPageBlock = (id: string, name: string, extra: Partial<Block> = {}) => ({
  ...createTextBlock({ entityId: id, blockUid: `${id}-uid`, text: name, isObject: true, objectName: name || null }),
  ...extra,
})
const mkChild = (id: string, text: string, parent: string, extra: Partial<Block> = {}) => ({
  ...createTextBlock({ entityId: id, blockUid: `${id}-uid`, text, parent }),
  ...extra,
})
const graphOf = (blocks: Block[]) => new DomainStore(blocks).snapshot()
const planOf = (blocks: Block[], registry: MetadataRegistry, scope: ExportScope, existing: string[] = []) =>
  planMarkdownExport(graphOf(blocks), registry, scope, { today: '2026-10-06', existingNames: existing })

test('R09-EXPORT-2 逐块映射：十二种块 × 嵌套 2 空格 × 空块跳过 × 引用块每行带前缀 × 页名行只出一次 × 未采用 AI 块（五个未采用态）不导出', () => {
  const page = mkPageBlock('pg', '映射页', {
    children: ['t', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'aiDraft', 'aiComplete', 'aiConfirm', 'aiCancel', 'aiError', 'aiOk', 'bul', 'num1', 'num2', 'q', 'todo', 'done', 'code', 'div', 'empty', 'emptyParent'],
  })
  const blocks = [
    page,
    mkChild('t', '正文一段', 'pg'),
    mkChild('h1', '一级', 'pg', { type: 'heading1' }),
    mkChild('h2', '二级', 'pg', { type: 'heading2' }),
    mkChild('h3', '三级', 'pg', { type: 'heading3' }),
    mkChild('h4', '四级', 'pg', { type: 'heading4' }),
    mkChild('h5', '五级', 'pg', { type: 'heading5' }),
    mkChild('h6', '六级', 'pg', { type: 'heading6' }),
    mkChild('aiDraft', '草稿内容', 'pg', { aiMeta: { action: 'summary', status: 'generating', sourceBlockIds: ['t'] } }),
    mkChild('aiComplete', '完成未采用内容', 'pg', { aiMeta: { action: 'summary', status: 'complete', sourceBlockIds: ['t'] } }),
    mkChild('aiConfirm', '待确认内容', 'pg', { aiMeta: { action: 'summary', status: 'needs-confirmation', sourceBlockIds: ['t'] } }),
    mkChild('aiCancel', '已取消内容', 'pg', { aiMeta: { action: 'summary', status: 'cancelled', sourceBlockIds: ['t'] } }),
    mkChild('aiError', '出错内容', 'pg', { aiMeta: { action: 'summary', status: 'error', sourceBlockIds: ['t'] } }),
    mkChild('aiOk', '已采用', 'pg', { aiMeta: { action: 'summary', status: 'accepted', sourceBlockIds: ['t'] } }),
    mkChild('bul', '项目', 'pg', { type: 'bullet', children: ['bul-kid'] }),
    mkChild('bul-kid', '子项', 'bul', { type: 'bullet' }),
    mkChild('num1', '第一', 'pg', { type: 'numbered' }),
    mkChild('num2', '第二', 'pg', { type: 'numbered' }),
    mkChild('q', '引用', 'pg', { type: 'quote', children: ['q-kid'] }),
    mkChild('q-kid', '引用里的子块', 'q', { type: 'bullet' }),
    mkChild('todo', '待办', 'pg', { type: 'todo' }),
    mkChild('done', '已办', 'pg', { type: 'todo', checked: true }),
    mkChild('code', 'const a = 1\n```\nconst b = 2', 'pg', { type: 'code' }),
    mkChild('div', '', 'pg', { type: 'divider' }),
    mkChild('empty', '', 'pg'),
    mkChild('emptyParent', '', 'pg', { type: 'bullet', children: ['ep-kid'] }),
    mkChild('ep-kid', '空壳的子块', 'emptyParent', { type: 'bullet' }),
  ]
  const plan = planOf(blocks, emptyRegistry(), { kind: 'page', pageId: 'pg' })
  assert.ok(plan)
  const content = plan.files[0].content
  assert.equal((content.match(/^# 映射页$/gm) ?? []).length, 1, `页名行只许出一行\n${content}`)
  for (const expected of [
    '\n正文一段\n',
    '\n# 一级\n', '\n## 二级\n', '\n### 三级\n',
    '\n#### 四级\n', '\n##### 五级\n', '\n###### 六级\n',
    '\n已采用\n',
    '\n- 项目\n  - 子项\n',
    '\n1. 第一\n\n2. 第二\n',
    '\n> 引用\n>   - 引用里的子块\n',
    '\n- [ ] 待办\n',
    '\n- [x] 已办\n',
    // 空壳列表项（无正文、有子块）：记号后**保留尾空格**（`- `）——裸 `-` 解析侧的记号表
  // （「记号 + 空格」）认不出，自家导出的空壳列表项会读不回来（ 属性测试抓到；台账 `D-062`）。
    '\n- \n  - 空壳的子块\n',
    '\n---\n',
  ]) {
    assert.ok(content.includes(expected), `缺少片段：${JSON.stringify(expected)}\n实际：\n${content}`)
  }
  assert.ok(content.includes('````\nconst a = 1\n```\nconst b = 2\n````'), `代码围栏要按内容加长\n${content}`)
  // 五个未采用态逐一断言：实现判据是 `status !== 'accepted'`（非枚举）——本断言防将来把它改成枚举时静默回归。
  for (const draft of ['草稿内容', '完成未采用内容', '待确认内容', '已取消内容', '出错内容']) {
    assert.ok(!content.includes(draft), `未采用的 AI 块（五态）整块不导出（草稿非内容，指令 §6.14.2）：${draft}\n${content}`)
  }
})

test('R09-EXPORT-4 引用落点：降级到目标页 / 自链接 / 悬空保留原文 / 空锚文本回退 / 范围外照常链接 / 目标搬页跟随', () => {
  const ref = (kind: 'object' | 'block', targetId: string, text: string): ContentFragment => ({
    t: 'inline-ref', v: text, ref: { kind, targetId },
  })
  const pageA = mkPageBlock('a', '甲页', { children: ['a-body'] })
  const pageB = mkPageBlock('b', '乙页', { children: ['b-body', 'b-target', 'b-target-kid'] })
  const pageC = mkPageBlock('c', '丙页', { children: ['c-body'] })
  const trashed = mkPageBlock('z', '回收站页', { deleted: true })
  const blocks = [
    pageA, pageB, pageC, trashed,
    mkChild('a-body', '', 'a', { content: [
      ref('object', 'b', '乙页'),
      { t: 'text', v: ' 与 ' },
      ref('block', 'b-target', '乙块'),
      { t: 'text', v: ' 与 ' },
      ref('block', 'b-target-kid', ''),
      { t: 'text', v: ' 与 ' },
      ref('object', 'missing', '没了的页'),
      { t: 'text', v: ' 与 ' },
      ref('object', 'z', '回收站页'),
      { t: 'text', v: ' 与 ' },
      ref('block', 'a-body', '本页块'),
    ] }),
    mkChild('b-body', '乙的正文', 'b'),
    mkChild('b-target', '被引用的块', 'b', { children: ['b-target-kid'] }),
    mkChild('b-target-kid', '被引用的子块', 'b-target'),
    mkChild('c-body', '丙的正文', 'c'),
  ]
  const content = planOf(blocks, emptyRegistry(), { kind: 'page', pageId: 'a' })!.files[0].content
  assert.ok(content.includes('[乙页](<乙页.md>)'), content)
  assert.ok(content.includes('[乙块](<乙页.md>)'), '块引用降级到目标页')
  assert.ok(content.includes('[被引用的子块](<乙页.md>)'), '空锚文本回退到目标标签')
  assert.ok(content.includes('[[没了的页]]'), '悬空保留原文')
  assert.ok(content.includes('[[回收站页]]'), '目标在回收站 = 悬空')
  assert.ok(content.includes('[本页块](<甲页.md>)'), '本页块引用 = 自链接')

  // 目标搬页跟随：b-target 搬到丙页 → 引用指向丙页文件
  const moved = blocks.map((block) => {
    if (block.entityId === 'b-target') return { ...block, parent: 'c' }
    if (block.entityId === 'b') return { ...block, children: ['b-body'] }
    if (block.entityId === 'c') return { ...block, children: ['c-body', 'b-target'] }
    return block
  })
  const after = planOf(moved, emptyRegistry(), { kind: 'page', pageId: 'a' })
  assert.ok(after!.files[0].content.includes('[乙块](<丙页.md>)'), after!.files[0].content)
})

test('R09-EXPORT-3 行内：六种标记 / 文字颜色不导出 / 外部链接（含空格括号用 <>）/ 未知片段按正文', () => {
  const page = mkPageBlock('pg', '行内页', { children: ['body'] })
  const blocks = [page, mkChild('body', '', 'pg', { content: [
    { t: 'text', v: '粗', marks: [{ type: 'bold' }] },
    { t: 'text', v: '斜', marks: [{ type: 'italic' }] },
    { t: 'text', v: '删', marks: [{ type: 'strike' }] },
    { t: 'text', v: '下', marks: [{ type: 'underline' }] },
    { t: 'text', v: '亮', marks: [{ type: 'highlight' }] },
    { t: 'text', v: '码', marks: [{ type: 'code' }] },
    { t: 'text', v: '色', marks: [{ type: 'color', attrs: { color: 'red' } }] },
    { t: 'link', v: '文档', url: 'https://example.com/a b(c)' },
    { t: 'link', v: '直的', url: 'https://example.com/plain' },
    { t: 'mention', v: '老片段' },
  ] })]
  const content = planOf(blocks, emptyRegistry(), { kind: 'page', pageId: 'pg' })!.files[0].content
  for (const expected of ['**粗**', '*斜*', '~~删~~', '<u>下</u>', '==亮==', '`码`', '色']) {
    assert.ok(content.includes(expected), `缺少 ${expected}\n${content}`)
  }
  assert.ok(content.includes('[文档](<https://example.com/a b(c)>)'), '含空格括号的 URL 用 <> 包裹')
  assert.ok(content.includes('[直的](https://example.com/plain)'), '普通 URL 原样')
  assert.ok(content.includes('老片段'), 'mention 按正文出口')
})

test('R09-EXPORT-5 命名：非法字符 / 保留名 / 尾部点空格 / 截断 / 同名 (2) / sanitize 冲突 / 未命名页 / 不覆盖', () => {
  assert.equal(sanitizeExportName('a/b:c*d?e"f<g>h|i'), 'a-b-c-d-e-f-g-h-i')
  assert.equal(sanitizeExportName('CON'), 'CON-')
  assert.equal(sanitizeExportName('com1'), 'com1-')
  assert.equal(sanitizeExportName('名字...  '), '名字')
  assert.equal(sanitizeExportName(''), '未命名页面')
  assert.equal(sanitizeExportName('x'.repeat(80)).length, 60)

  const blocks = [
    mkPageBlock('p1', '同名'),
    mkPageBlock('p2', '同名'),
    mkPageBlock('p3', 'A:B'),
    mkPageBlock('p4', 'A?B'),
    mkPageBlock('p5', ''),
  ]
  const plan = planOf(blocks, emptyRegistry(), { kind: 'all' })
  assert.deepEqual(plan!.files.map((file) => file.path), ['同名.md', '同名 (2).md', 'A-B.md', 'A-B (2).md', '未命名页面.md'])
  const again = planOf([mkPageBlock('p1', '同名')], emptyRegistry(), { kind: 'page', pageId: 'p1' }, ['同名.md'])
  assert.equal(again!.artifactName, '同名 (2).md', '同名文件不覆盖')
  const zipAgain = planOf([mkPageBlock('p1', '同名')], emptyRegistry(), { kind: 'all' }, ['同名.md', '墨契-导出-2026-10-06.zip'])
  assert.equal(zipAgain!.artifactName, '墨契-导出-2026-10-06 (2).zip', 'zip 同名也不覆盖')
})

test('R09-EXPORT-6 front-matter：五种类型写法 / 保留键改名 / 定义缺失 / 无属性无标签省略', () => {
  const now = Date.UTC(2026, 9, 6, 1, 31, 0)
  const registry: MetadataRegistry = {
    properties: [
      { id: 'd-text', name: '备注', type: 'text', created: now, modified: now },
      { id: 'd-num', name: '进度', type: 'number', created: now, modified: now },
      { id: 'd-date', name: '截止', type: 'date', created: now, modified: now },
      { id: 'd-check', name: '归档', type: 'checkbox', created: now, modified: now },
      { id: 'd-select', name: '状态', type: 'select', options: [{ id: 'o1', label: '进行中' }], created: now, modified: now },
      { id: 'd-tags', name: 'tags', type: 'text', created: now, modified: now },
    ],
    tags: [{ id: 't1', name: '副业', created: now, modified: now }],
  }
  const page = mkPageBlock('pg', '属性页', {
    tags: ['t1', 't1'],
    properties: [
      { defId: 'd-text', type: 'text', value: '含 "引号" 与 \\ 反斜杠\n换行' },
      { defId: 'd-num', type: 'number', value: 3.5 },
      { defId: 'd-date', type: 'date', value: '2026-10-06' },
      { defId: 'd-check', type: 'checkbox', value: true },
      { defId: 'd-select', type: 'select', optionId: 'o1' },
      { defId: 'd-tags', type: 'text', value: '与保留键同名' },
      { defId: 'gone', type: 'text', value: '定义没了的旧值' },
      { defId: 'd-check', type: 'checkbox', value: false },
    ],
    created: now,
    modified: now,
  })
  const plan = planOf([page], registry, { kind: 'page', pageId: 'pg' })
  const content = plan!.files[0].content
  assert.ok(content.startsWith('---\n'), content)
  assert.ok(content.includes('tags: ["副业"]'), '标签写名字、去重')
  assert.ok(content.includes('"备注": "含 \\"引号\\" 与 \\\\ 反斜杠\\n换行"'), content)
  assert.ok(content.includes('"进度": 3.5'), content)
  assert.ok(content.includes('"截止": 2026-10-06'), content)
  assert.ok(content.includes('"归档": true'), content)
  assert.ok(content.includes('"状态": "进行中"'), 'select 写选项显示名')
  assert.ok(content.includes('"tags（2）": "与保留键同名"'), '与保留键同名 → 改名')
  assert.ok(content.includes('"gone": "定义没了的旧值"'), '定义缺失 → 键名回退 defId')
  assert.ok(content.includes('"归档（2）": false'), '防御：历史 / 手改数据里同一 def 出现两条值时也得去重（正常写入路径不可能有）')
  assert.equal(plan!.renamedKeys.length, 2)
  assert.ok(/created: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/.test(content), content)

  const bare = planOf([mkPageBlock('p', '干净页')], emptyRegistry(), { kind: 'page', pageId: 'p' })
  assert.equal(bare!.files[0].content.startsWith('---'), false, '无属性无标签 → 省略 front-matter')
})

test('R09-EXPORT-6 空串写 ""、未设不写键、非有限数跳过', () => {
  const now = Date.now()
  const registry: MetadataRegistry = {
    properties: [
      { id: 'd-text', name: '备注', type: 'text', created: now, modified: now },
      { id: 'd-num', name: '进度', type: 'number', created: now, modified: now },
    ],
    tags: [],
  }
  const page = mkPageBlock('pg', '边界页', {
    properties: [
      { defId: 'd-text', type: 'text', value: '' },
      { defId: 'd-num', type: 'number', value: Number.NaN },
    ],
  })
  const content = planOf([page], registry, { kind: 'page', pageId: 'pg' })!.files[0].content
  assert.ok(content.includes('"备注": ""'), content)
  assert.equal(content.includes('进度'), false, '非有限数跳过该键')
})

test('R09-EXPORT-5 范围：全部页面排除回收站 / 按标签过滤 / 单页 / 空范围返回 null', () => {
  const now = Date.now()
  const registry: MetadataRegistry = { properties: [], tags: [{ id: 't1', name: '工程', created: now, modified: now }] }
  const blocks = [
    mkPageBlock('p1', '打标页', { tags: ['t1'] }),
    mkPageBlock('p2', '普通页'),
    mkPageBlock('p3', '回收站页', { deleted: true }),
  ]
  const all = planOf(blocks, registry, { kind: 'all' })
  assert.deepEqual(all!.files.map((file) => file.path), ['打标页.md', '普通页.md'])
  assert.equal(all!.artifactName, '墨契-导出-2026-10-06.zip')
  const byTag = planOf(blocks, registry, { kind: 'tag', tagId: 't1' })
  assert.deepEqual(byTag!.files.map((file) => file.path), ['打标页.md'])
  assert.equal(byTag!.artifactName, '墨契-导出-工程-2026-10-06.zip')
  const single = planOf(blocks, registry, { kind: 'page', pageId: 'p1' })
  assert.equal(single!.kind, 'file')
  assert.equal(single!.artifactName, single!.files[0].path)
  assert.equal(planOf(blocks, registry, { kind: 'page', pageId: 'p3' }), null, '已删页不可导')
  assert.equal(planOf(blocks, registry, { kind: 'page', pageId: 'nope' }), null)
  assert.equal(planOf(blocks, registry, { kind: 'tag', tagId: 'none' }), null)
})

test('R09-SET-5 改属性名：与建属性共用同一套判据（重名 / 保留键 / 空名一律拒绝），defId 不变——页面上的取值跟着走', () => {
  const now = Date.now()
  const created = createPropertyDef('状态', 'select', emptyRegistry(), now)
  assert.ok(created)
  const renamed = renamePropertyDef(created.def.id, ' 阶段 ', created.registry, now + 1)
  assert.equal(renamed?.properties[0].name, '阶段', '首尾空白裁掉')
  assert.equal(renamed?.properties[0].modified, now + 1)
  assert.equal(renamed?.properties[0].id, created.def.id, 'defId 不变——值按 defId 挂，改名不动数据')

  const second = createPropertyDef('优先级', 'number', renamed!, now + 2)
  assert.ok(second)
  assert.equal(renamePropertyDef(second.def.id, '阶段', second.registry), null, '与别的定义重名')
  assert.equal(renamePropertyDef(second.def.id, ' 阶段 ', second.registry), null, '重名判据忽略首尾空白')
  assert.equal(renamePropertyDef(second.def.id, 'tags', second.registry), null, '保留键（本设计自己的）')
  assert.equal(renamePropertyDef(second.def.id, 'aliases', second.registry), null, '保留键（Obsidian 的默认名）')
  assert.equal(renamePropertyDef(second.def.id, '   ', second.registry), null, '空名')
  assert.equal(renamePropertyDef('missing', '任意', second.registry), null, '找不到定义')
  assert.equal(renamePropertyDef(second.def.id, second.def.name, second.registry), null, '改成自己 = 无操作')

  // 建属性那把闸也认保留键；判据只有一份（propertyNameProblem），界面拿它说清原因
  assert.equal(createPropertyDef('created', 'text', second.registry), null, '建属性同样挡保留键')
  assert.equal(propertyNameProblem('tags', second.registry), 'reserved')
  assert.equal(propertyNameProblem('阶段', second.registry), 'taken')
  assert.equal(propertyNameProblem('阶段', second.registry, second.registry.properties.find((def) => def.name === '阶段')?.id), null, '改名时排除自己后可用')
  assert.equal(propertyNameProblem('  ', second.registry), 'empty')
})

test('R09-MD-3 记号表：行首识别（含长度）/ 打字触发只看整行 / 表外与句中一律不动 / 转义往返无歧义', () => {
  // 行首识别（粘贴与输入层共用）：类型 + 被吞掉的长度
  assert.deepEqual(blockMarkerOf('# '), { type: 'heading1', checked: undefined, length: 2, handled: undefined })
  assert.deepEqual(blockMarkerOf('### 标题'), { type: 'heading3', checked: undefined, length: 4, handled: undefined })
  assert.deepEqual(blockMarkerOf('[x] '), { type: 'todo', checked: true, length: 4, handled: undefined })
  assert.deepEqual(blockMarkerOf('[ ] '), { type: 'todo', checked: undefined, length: 4, handled: undefined })
  assert.deepEqual(blockMarkerOf('- '), { type: 'bullet', checked: undefined, length: 2, handled: undefined })
  assert.deepEqual(blockMarkerOf('* '), { type: 'bullet', checked: undefined, length: 2, handled: undefined })
  assert.deepEqual(blockMarkerOf('12. '), { type: 'numbered', checked: undefined, length: 4, handled: undefined })
  assert.deepEqual(blockMarkerOf('---'), { type: 'divider', checked: undefined, length: 3, handled: undefined })
  assert.equal(blockMarkerOf('```')?.handled, 'fence')
 // 表外与句中：不动（`5 - 3` / `` / `[文字](url)` 都不该被认成记号）
  assert.equal(blockMarkerOf('-'), null, '光一个减号不是记号')
  assert.equal(blockMarkerOf('5 - 3'), null)
  assert.equal(blockMarkerOf('2026-10-04 上线'), null)
  assert.equal(blockMarkerOf('[文字](https://x)'), null, '外链语法不做（R09-MD-3 的「不做」）')
  assert.equal(blockMarkerOf('#标签'), null, '井号标签不做')
  assert.equal(splitBlockMarker('- 买牛奶')?.rest, '买牛奶')
  assert.equal(splitBlockMarker('## 二级')?.marker.type, 'heading2')

  // 转义：只动行首，已经是 \ 开头的不重复加；句中不加
  assert.equal(escapeLeadingMarker('- 买牛奶'), '\\- 买牛奶')
  assert.equal(escapeLeadingMarker('5 - 3'), '5 - 3')
  assert.equal(escapeLeadingMarker('\\- 已经转义过'), '\\- 已经转义过')
  assert.equal(escapeLeadingMarker(''), '')
  // 往返：导出转义 → 粘贴/导入读回，语义不漂
  for (const line of ['- 买牛奶', '# 不是标题', '> 不是引用', '1. 不是编号', '---', '[ ] 不是待办']) {
    assert.equal(unescapeLeadingMarker(escapeLeadingMarker(line)), line, `${line} 的往返要不丢字`)
  }
  assert.equal(unescapeLeadingMarker('\\不是记号'), '\\不是记号', '表外的反斜杠照旧')
})

test('R09-EXPORT-3 行首记号转义：正文里写的 `- x` 导出成 `\\- x`；块的记号与正文的记号分得清；块内换行按行处理', () => {
  const page = mkPageBlock('pg', '转义页', { children: ['plain', 'mid', 'bul', 'multi'] })
  const blocks = [
    page,
    mkChild('plain', '- 记着买牛奶', 'pg'),
    mkChild('mid', '算一下 5 - 3', 'pg'),
    mkChild('bul', '- 二级说明', 'pg', { type: 'bullet' }),
    mkChild('multi', '# 这行不是标题\n> 这行也不是引用', 'pg'),
  ]
  const content = planOf(blocks, emptyRegistry(), { kind: 'page', pageId: 'pg' })!.files[0].content
  assert.ok(content.includes('\\- 记着买牛奶'), `正文里的减号要转义\n${content}`)
  assert.ok(content.includes('算一下 5 - 3'), '句中的减号不动')
  assert.ok(content.includes('- \\- 二级说明'), '项目符号块的记号是块类型写的、正文那个要转义')
  assert.ok(content.includes('\\# 这行不是标题') && content.includes('\\> 这行也不是引用'), `块内换行按行转义\n${content}`)
})

test('R09-MD-3 粘贴即转换（域层）：解析成树 + 整棵插入是**一个事务**（⌘Z 一次整批退回），转义读回字面', () => {
  const md = [
    '# 周报',
    '- 导出保真',
    '  - 转义也做了',
    '1. 第一步',
    '[x] 已办',
    '```',
    'const a = 1',
    '```',
    '\\- 字面减号',
  ].join('\n')
  const drafts = parseMarkdownOutline(md)
  assert.ok(drafts, '含记号行 ⇒ 认成 Markdown 大纲')
  assert.deepEqual(drafts.map((draft) => draft.type), ['heading1', 'bullet', 'numbered', 'todo', 'code', 'text'])
  assert.deepEqual(drafts[1].children.map((child) => child.text), ['转义也做了'], '每级 2 空格 → 父子')
  assert.equal(drafts[3].checked, true)
  assert.equal(drafts[4].text, 'const a = 1', '围栏收进同一个代码块')
  assert.equal(drafts[5].text, '- 字面减号', '转义读回字面——导出 → 粘贴的往返无歧义')
  assert.equal(parseMarkdownOutline('只是两行普通文字\n第二行'), null, '没有记号行 ⇒ 放行走默认粘贴')

  const page = mkPageBlock('pg', '粘贴页', { children: ['a1'] })
  const anchor = mkChild('a1', '锚点', 'pg')
  const store = new DomainStore([page, anchor])
  const ids = store.insertOutline('a1', drafts!)
  assert.ok(ids)
  assert.equal(ids.length, 7, '六个顶层 + bullet 的一个子块')
  const snapshot = store.snapshot()
  assert.equal(snapshot.get(ids[0])?.type, 'heading1')
  assert.equal(snapshot.get(ids[0])?.parent, 'pg', '插在锚点所在列表、锚点之后')
  assert.equal(snapshot.get(ids[2])?.parent, ids[1], '子块挂在 bullet 下')
  assert.equal(snapshot.get(ids[2])?.content[0].v, '转义也做了')
  store.undo()
  const after = store.snapshot()
  assert.equal(after.get(ids[0])?.deleted, true, '一次撤销整批退回（删除是软删：标 deleted，界面按活跃块重建）')
  assert.equal(after.get('a1')?.content[0].v, '锚点')
})

// 媒体块（13-媒体设计（已归档） §2；命名用行为 ID —— 先登记在 09 / accept 项名，`11` 行为行走 EXPORT-* 先例的欠账）
test('R09-BLOCK-19/20 图片 / 附件必须有 payload；非媒体不许带；字段要合法——四条只报告、不进写入闸', () => {
  const imageBlock = { ...createTextBlock({ entityId: 'img', blockUid: 'img00001' }), type: 'image' as const }
  assert.deepEqual(validateBlockShape(imageBlock).map((issue) => issue.code), ['image-payload-required'])
  const fileBlock = { ...createTextBlock({ entityId: 'fil', blockUid: 'fil00001' }), type: 'file' as const }
  assert.deepEqual(validateBlockShape(fileBlock).map((issue) => issue.code), ['file-payload-required'])

  const asset = { fileName: 'a1b2c3.png', originalName: '截图 2026-10-06.png', mime: 'image/png', size: 1234, width: 800, height: 450 }
  assert.deepEqual(validateBlockShape({ ...imageBlock, asset }), [], '带齐 payload 的图片块合法')
  assert.deepEqual(validateBlockShape({ ...imageBlock, asset: { ...asset, fileName: '' } }).map((issue) => issue.code), ['asset-fields-invalid'])
  assert.deepEqual(validateBlockShape({ ...imageBlock, asset: { ...asset, size: -1 } }).map((issue) => issue.code), ['asset-fields-invalid'])
  assert.deepEqual(validateBlockShape({ ...imageBlock, asset: { ...asset, width: 0 } }).map((issue) => issue.code), ['asset-fields-invalid'])
  assert.deepEqual(validateBlockShape({ ...createTextBlock({ entityId: 'txt', blockUid: 'txt00001' }), asset }).map((issue) => issue.code), ['asset-fields-invalid'], '只有媒体块能带 payload')
})

test('R09-BLOCK-24 嵌入块至多一条 embed 引用（0 条 = 还没选来源的空态，合法）', () => {
  const embedBlock = { ...createTextBlock({ entityId: 'emb', blockUid: 'emb00001' }), type: 'embed' as const }
  assert.deepEqual(validateBlockShape(embedBlock), [], '空嵌入块合法（原型「选择来源」态）')
  const one = { ...embedBlock, blockRefs: [{ targetBlockId: 'src', fromBlockId: 'emb', type: 'embed' as const }] }
  assert.deepEqual(validateBlockShape(one), [], '一条引用合法')
  const two = { ...embedBlock, blockRefs: [...one.blockRefs, { targetBlockId: 'other', fromBlockId: 'emb', type: 'embed' as const }] }
  assert.deepEqual(validateBlockShape(two).map((issue) => issue.code), ['embed-ref-invalid'])
})

test('R09-EXPORT-2 媒体块导出：图片 `![](assets/<原名>)` / 附件 `[原名](…)` / 缺文件降级成文字；资产按 from→to 记账、重名去重', () => {
  const page = mkPageBlock('pg', '带图页', { children: ['img', 'fil', 'gone'] })
  const blocks = [
    page,
    mkChild('img', '图注一', 'pg', { type: 'image', asset: { fileName: 'disk1.png', originalName: '截图.png', mime: 'image/png', size: 10, width: 2, height: 1 } }),
    mkChild('fil', '', 'pg', { type: 'file', asset: { fileName: 'disk2.pdf', originalName: '报告.pdf', mime: 'application/pdf', size: 20 } }),
    mkChild('gone', '', 'pg', { type: 'image', asset: { fileName: 'missing.png', originalName: '没了.png', mime: 'image/png', size: 1 } }),
  ]
  const plan = planMarkdownExport(graphOf(blocks), emptyRegistry(), { kind: 'page', pageId: 'pg' }, {
    today: '2026-10-06',
    existingAssets: ['disk1.png', 'disk2.pdf'],
  })
  assert.ok(plan)
  const content = plan.files[0].content
  assert.ok(content.includes('![图注一](assets/截图.png)'), content)
  assert.ok(content.includes('[报告.pdf](assets/报告.pdf)'), content)
  assert.ok(content.includes('（图片缺失：没了.png）'), '缺文件降级成文件名文字，不静默丢')
  assert.deepEqual(plan.assets, [
    { from: 'disk1.png', to: 'assets/截图.png' },
    { from: 'disk2.pdf', to: 'assets/报告.pdf' },
  ], '只搬磁盘上真有的，目标名 = 原名')

  // 两张同名图 → 包内去重（原名 + ` (2)`）；同一张图被两页引用只搬一次
  const dup = planMarkdownExport(graphOf([
    mkPageBlock('p1', '甲页', { children: ['i1'] }),
    mkPageBlock('p2', '乙页', { children: ['i2'] }),
    mkChild('i1', '', 'p1', { type: 'image', asset: { fileName: 'd1.png', originalName: '图.png', mime: 'image/png', size: 1 } }),
    mkChild('i2', '', 'p2', { type: 'image', asset: { fileName: 'd1.png', originalName: '图.png', mime: 'image/png', size: 1 } }),
  ]), emptyRegistry(), { kind: 'all' }, { today: '2026-10-06', existingAssets: ['d1.png'] })
  assert.deepEqual(dup!.assets, [{ from: 'd1.png', to: 'assets/图.png' }], '同一张图只搬一次')
})

// ---------------------------------------------------------------------------
// 嵌入块（13-媒体设计（已归档） §8、`R09-BLOCK-24`）：来源写入 / 只读视图 / 导出快照 / 环的兜底
// 命名同样用规则 ID（`R09-` 前缀），理由与导出那一组相同（见上）。
// ---------------------------------------------------------------------------
const embedPage = () => {
  const page = mkPageBlock('pg1', '甲页', { children: ['name1', 'sec', 'slot'] })
  const name1 = mkChild('name1', '甲页', 'pg1')
  const sec = mkChild('sec', '小节', 'pg1', { children: ['sec-kid'] })
  const secKid = mkChild('sec-kid', '小节里的子块', 'sec')
  const slot = mkChild('slot', '嵌在这里', 'pg1', { type: 'embed' })
  const other = mkPageBlock('pg2', '乙页', { children: ['name2'] })
  const name2 = mkChild('name2', '乙页正文', 'pg2')
  const store = new DomainStore([page, name1, sec, secKid, slot, other, name2])
  return { store, page, sec, secKid, slot, other }
}

test('R09-BLOCK-24 选源 / 换源 / 清除都只占一个撤销步，且自引用与祖先被拒', () => {
  const { store, page, sec, other } = embedPage()

  assert.ok(store.setEmbedSource('slot', 'sec'))
  assert.deepEqual(store.snapshot().get('slot')!.blockRefs.map((ref) => [ref.type, ref.targetBlockId]), [['embed', 'sec']])
  assert.deepEqual(store.snapshot().get('sec')!.blockBackRefs.map((ref) => ref.fromBlockId), ['slot'], '反链一起写上（面板与计数读它）')

  // 换源：**一次事务**——旧引用摘掉、新引用写上，一次撤销就该回到「上一个来源」，不是回到空态。
  assert.ok(store.setEmbedSource('slot', other.entityId))
  assert.deepEqual(store.snapshot().get('slot')!.blockRefs.map((ref) => ref.targetBlockId), [other.entityId])
  store.undo()
  assert.deepEqual(store.snapshot().get('slot')!.blockRefs.map((ref) => ref.targetBlockId), ['sec'], '一次撤销回到上一个来源')
  store.redo()
  assert.deepEqual(store.snapshot().get('slot')!.blockRefs.map((ref) => ref.targetBlockId), [other.entityId])

  // 清除来源：回到空态（0 条 embed 引用）。
  assert.ok(store.setEmbedSource('slot', null))
  assert.deepEqual(store.snapshot().get('slot')!.blockRefs, [])
  store.undo()
  assert.deepEqual(store.snapshot().get('slot')!.blockRefs.map((ref) => ref.targetBlockId), [other.entityId], '清除也是一步')

  // 自引用与祖先：嵌入块指向自己 / 指向自己所在的页面或小节 ⇒ 无限递归，一律拒。
  assert.equal(store.setEmbedSource('slot', 'slot'), false)
  assert.equal(store.setEmbedSource('slot', 'pg1'), false, '自己所在的页面是祖先')
  assert.equal(store.setEmbedSource('slot', sec.entityId), true, '同级的其它块照旧能选（小节不是 slot 的祖先）')
  // 目标没变 / 不是嵌入块 / 目标已删：契约 no-op。
  assert.equal(store.setEmbedSource('slot', 'sec'), false, '目标没变 = no-op')
  assert.equal(store.setEmbedSource('name1', 'sec'), false, '普通块不是嵌入块')
  assert.equal(store.setEmbedSource('slot', 'missing'), false, '目标不存在')
  assert.equal(store.setEmbedSource('slot', null), true)
  assert.equal(store.setEmbedSource('slot', null), false, '本来就是空态 = no-op')
  void page
})

test('R09-BLOCK-24 只读视图：标题两段 + 源子树逐行（子块缩进）+ 源被删降级为悬空', () => {
  const { store } = embedPage()
  assert.equal(store.embedView('slot'), null, '还没选来源 ⇒ 空态（由卡片自己画，不是数据）')
  assert.equal(store.embedView('name1'), null, '不是嵌入块 ⇒ null')

  store.setEmbedSource('slot', 'sec')
  const view = store.embedView('slot')
  assert.equal(view?.state, 'ok')
  assert.equal(view?.pageLabel, '甲页')
  assert.equal(view?.blockLabel, '小节')
  assert.deepEqual(view?.lines, ['小节', '  小节里的子块'], '块自己的文字 + 子块缩进两格')
  assert.equal(view?.sourcePageId, 'pg1', '「来源 ↗」跳的是源块所在页面')

  // 目标是整页：标题只有页名（不写「页 › 页」），正文是页子树。
  store.setEmbedSource('slot', 'pg2')
  const pageView = store.embedView('slot')
  assert.equal(pageView?.blockLabel, '', '整页做来源时后半段为空')
  assert.deepEqual(pageView?.lines, ['乙页', '  乙页正文'])

  // 源被移入回收站 ⇒ 悬空（数据合法、界面降级；反链计数照旧含这条引用）。
  const store2 = new DomainStore([...store.snapshot().values()].map((block) => structuredClone(block)))
  store2.setEmbedSource('slot', 'sec')
  const page = store2.get('pg1')!
  store2.deleteSelection([page.entityId])
  assert.equal(store2.embedView('slot')?.state, 'dangling', '源没了 ⇒ 悬空占位')
})

test('R09-BLOCK-24 正文上限：超过 24 行只出前 24 行并报出隐藏行数', () => {
  const kids = Array.from({ length: 40 }, (_, index) => `k${index}`)
  const page = mkPageBlock('pg', '大页', { children: ['big', 'slot'] })
  const big = mkChild('big', '大块', 'pg', { children: kids })
  const children = kids.map((id, index) => mkChild(id, `第 ${index + 1} 行`, 'big'))
  const slot = mkChild('slot', '', 'pg', { type: 'embed' })
  const store = new DomainStore([page, big, slot, ...children])
  store.setEmbedSource('slot', 'big')
  const view = store.embedView('slot')!
  assert.equal(view.lines.length, 24)
  assert.equal(view.hiddenLines, 41 - 24, '块自己那行 + 40 个子块，截断后报出余下行数')
})

test('R09-BLOCK-24 导出：嵌入就地展开快照（引用行 + 引用内容都进引用块，源删则一行说明）', () => {
  const page = mkPageBlock('pg', '甲页', { children: ['sec', 'slot'] })
  const sec = mkChild('sec', '小节', 'pg', { children: ['kid'] })
  const kid = mkChild('kid', '小节里的子块', 'sec')
  const slot = mkChild('slot', '', 'pg', { type: 'embed' })
  const store = new DomainStore([page, sec, kid, slot])
  store.setEmbedSource('slot', 'sec')
  const plan = planMarkdownExport(store.snapshot(), emptyRegistry(), { kind: 'page', pageId: 'pg' }, { today: '2026-10-06' })!
  const content = plan.files[0].content
  assert.ok(content.includes('> **嵌入自 [小节](<甲页.md>)**'), content)
  assert.ok(content.includes('> 小节'), '快照展开源块自己的文字')
  assert.ok(content.includes('>   小节里的子块'), '子块缩进也进引用块')

  // 源被删除 ⇒ 一行「嵌入来源已删除」，不静默丢。
  const store2 = new DomainStore([...store.snapshot().values()].map((block) => structuredClone(block)))
  store2.deleteSelection(['sec'])
  const plan2 = planMarkdownExport(store2.snapshot(), emptyRegistry(), { kind: 'page', pageId: 'pg' }, { today: '2026-10-06' })!
  assert.ok(plan2.files[0].content.includes('（嵌入来源已删除）'), plan2.files[0].content)
})

test('R09-BLOCK-24 环的兜底：嵌入指向自己 / 祖先时 validateBlockGraph 报 embed-ref-invalid', () => {
  const { store } = embedPage()
  const blocks = store.snapshot()
  // 直接手写一条非法引用（模拟外部文件 / 旧版本写进来的数据）：写入侧拦不住它。
  blocks.get('slot')!.blockRefs.push({ fromBlockId: 'slot', targetBlockId: 'pg1', type: 'embed' })
  const issues = validateBlockGraph(blocks).filter((issue) => issue.code === 'embed-ref-invalid')
  assert.equal(issues.length, 1)
  assert.match(issues[0].message, /祖先/)

  // 两条 embed 引用同样报（至多一条）。
  const blocks2 = store.snapshot()
  const slot = blocks2.get('slot')!
  slot.blockRefs.push({ fromBlockId: 'slot', targetBlockId: 'sec', type: 'embed' }, { fromBlockId: 'slot', targetBlockId: 'name1', type: 'embed' })
  assert.equal(validateBlockGraph(blocks2).filter((issue) => issue.code === 'embed-ref-invalid').length, 1)
})

test('PROPS-PANEL-1 属性面板两档：缺省补 []、往返保留；行显示规则一句（§0-1/§0-3/§0-10）', () => {
  // 旧块（缺两个字段）→ normalizeBlock 补成 []；往返（serialize → parse）原样保留
  const legacy = { ...createTextBlock({ entityId: 'legacy-1', blockUid: 'legacy-1' }) } as unknown as Record<string, unknown>
  delete legacy.propertyShown
  delete legacy.propertyHidden
  const healed = normalizeBlock(legacy as unknown as Block)
  assert.deepEqual(healed.propertyShown, [])
  assert.deepEqual(healed.propertyHidden, [])
  const round = { ...createTextBlock({ entityId: 'round-1', blockUid: 'round-1' }), propertyShown: ['sys:tags'], propertyHidden: ['def-1'] }
  const parsed = parseBlock(serializeBlock(round))
  assert.deepEqual(parsed.propertyShown, ['sys:tags'])
  assert.deepEqual(parsed.propertyHidden, ['def-1'])
  // 行显示规则：默认字段要加才出；用户属性有值就出；「从本页删除」不显示而值还在；再加回来（无值也行）
  assert.equal(propertyRowVisible({ id: 'sys:tags', hasValue: false, shown: [], hidden: [] }), false, '默认字段没加过：不显示')
  assert.equal(propertyRowVisible({ id: 'sys:tags', hasValue: false, shown: ['sys:tags'], hidden: [] }), true, '加过：显示（哪怕还没有值）')
  assert.equal(propertyRowVisible({ id: 'def-1', hasValue: true, shown: [], hidden: [] }), true, '用户属性有值：显示（零迁移）')
  assert.equal(propertyRowVisible({ id: 'def-1', hasValue: true, shown: [], hidden: ['def-1'] }), false, '从本页删除：不显示（值保留）')
  assert.equal(propertyRowVisible({ id: 'def-1', hasValue: false, shown: ['def-1'], hidden: [] }), true, '添加无值属性：显示「未设置」行')
})

test('PROPS-TAGPICK-1 标签用量读数：全量含 0 用的定义 ＋ 未删除页计数、按用量降序（§5-12）', () => {
  const tag = (id: string, name: string) => ({ id, name, created: 1, modified: 1 })
  const page = (id: string, tags: string[], deleted = false) => {
    const block = createTextBlock({ entityId: id, blockUid: id.padEnd(8, '0') })
    block.tags = tags
    block.deleted = deleted
    return block
  }
  const usages = tagUsages(
    [page('pg-a', ['tag-1', 'tag-2']), page('pg-b', ['tag-1']), page('pg-c', ['tag-1'], true)],
    [tag('tag-1', '副业'), tag('tag-2', '写作'), tag('tag-3', '未用')],
  )
  assert.deepEqual(usages.map((entry) => [entry.name, entry.count]), [['副业', 2], ['写作', 1], ['未用', 0]], '未删除页计数、降序、0 用的也在列')
  assert.equal(usages.find((entry) => entry.name === '未用')?.count, 0, '含 0 用的定义（选择器要能复用未用的）')
})

test('PROPS-USED-1 属性用量读数：每页计一次（有值 ∨ 只挂着显示）、值条目另计——checkbox false 算一条、未删除页', () => {
  const def = (id: string, type: 'select' | 'checkbox') => ({ id, name: id, type, created: 1, modified: 1 })
  const page = (id: string, props: unknown[], shown: string[] = [], deleted = false) => {
    const block = createTextBlock({ entityId: id, blockUid: id.padEnd(8, '0') })
    block.properties = props as Block['properties']
    block.propertyShown = shown
    block.deleted = deleted
    return block
  }
  const usage = propertyUsages(
    [
      page('pg-a', [{ defId: 'd-sel', type: 'select', optionId: 'o1' }], ['d-sel']),
      page('pg-b', [], ['d-sel']),
      page('pg-c', [{ defId: 'd-chk', type: 'checkbox', value: false }]),
      page('pg-d', [{ defId: 'd-sel', type: 'select', optionId: 'o1' }], [], true),
    ],
    [def('d-sel', 'select'), def('d-chk', 'checkbox')],
  )
  /* θ4：读数带上**每个选项**的用量（删选项的影响清单「用在 N 页」）——非单选型为空对象。 */
  assert.deepEqual(usage['d-sel'], { pages: 2, values: 1, options: { o1: 1 } }, '有值 + 只挂显示 = 两页；值只算一条；软删除页不计；选项 o1 一处取值（软删除页不计）')
  assert.deepEqual(usage['d-chk'], { pages: 1, values: 1, options: {} }, 'checkbox false 算一条值；勾选型无选项读数')
})

test('PROPS-DEL-1 deletePropertyDef：删定义；未知 id → null（默认字段不在册 = 天然不可删，§3.2/§0-2）', () => {
  const created = createPropertyDef('状态', 'select', emptyRegistry())
  assert.ok(created)
  const next = deletePropertyDef(created.def.id, created.registry)
  assert.deepEqual(next?.properties, [], '定义从注册表移除')
  assert.equal(deletePropertyDef(created.def.id, next!), null, '再删 = 无操作')
})

test('ENTER-CODEBLOCK-1 导出：代码块里的多行（\\n）落在同一个围栏里', () => {
  const page = createTextBlock({ entityId: 'ec-p', blockUid: 'ecp00001', isObject: true, objectName: '代码页' })
  const code = createTextBlock({ entityId: 'ec-b', blockUid: 'ecb00001' })
  code.type = 'code'
  code.parent = 'ec-p'
  code.content = [{ t: 'text', v: 'const a = 1\nconst b = 2' }]
  page.children = ['ec-b']
  const blocks = new Map([[page.entityId, page], [code.entityId, code]])
  const plan = planMarkdownExport(blocks, emptyRegistry(), { kind: 'page', pageId: 'ec-p' }, { today: '2026-10-10' })
  const md = plan?.files?.[0]?.content ?? ''
  assert.match(md, /^```[\w-]*\nconst a = 1\nconst b = 2\n^```/m, '两行在同一对围栏里')
  assert.equal((md.match(/^```/gm) ?? []).length % 2, 0, '围栏成对，不把第二行甩到围栏外')
})

test('LOAD-TOLERANT-1 载入面只挡结构性码：报告级形状问题随块放行（桌面不再整屏「无法恢复项目 B」）', () => {
  // 报告级（媒体四条其一）：图片块没有 payload——按设计「用户该能删掉那块来修」，
  // 此前 `parseBlock` 对它也抛 ⇒ TauriStoragePort.loadBlocks 整库载入失败、应用打不开
 // （ 审计；写入面本来就由 `assertValidBlockGraph` 过滤，不挡修）。
  const image = createTextBlock({ entityId: 'img', blockUid: 'img00001', text: '' })
  image.type = 'image'
  assert.deepEqual(validateBlockShape(image).map((issue) => issue.code), ['image-payload-required'], '前提：这是报告级码')
  assert.throws(() => parseBlock(JSON.stringify(image)), /payload/, '严格面（既有语义）不变：`parseBlock` 照旧抛')
  assert.equal(parseBlockForLoad(JSON.stringify(image)).entityId, 'img', '载入面放行——进得去才修得了')

  // 结构性码（unsupported-type）照旧抛：块图不自洽时不许带病载入
  const broken = { ...createTextBlock({ entityId: 'b1', blockUid: 'b1000001', text: '' }), type: 'nope' } as unknown as Block
  assert.throws(() => parseBlockForLoad(JSON.stringify(broken)), /不支持的 Block 类型/)

 // 边界电池（）：**根本解析不了的 JSON 行**是 fail-closed——载入整体失败、
  // 界面进失败屏（`LOAD-RECOVER-1` 给快照恢复出路）。存储侧原样读出（`list_all_returns_broken_json_rows_verbatim`），
  // 「怎么处置」刻意不在解析层发明宽容档：一个坏行静默消失比"看得见的失败"更糟。
  assert.throws(() => parseBlockForLoad('{oops'), SyntaxError)
})

// ── 侧栏统计（`R09-PRIN-13` / `SIDE-STATS-*`）──

test('SIDE-STATS-1 侧栏统计只算存活页面 / 标签 / 正文，字数按用户可见字符', () => {
  const page = createTextBlock({ entityId: 'sp', blockUid: 'sp000001', text: '墨契', isObject: true, objectName: '墨契' })
  page.tags = ['tag-a']
  const child = createTextBlock({ entityId: 'sc', blockUid: 'sc000001', text: '笔记 📝', parent: 'sp' })
  child.tags = ['tag-b']
  const gone = createTextBlock({ entityId: 'sd', blockUid: 'sd000001', text: '不该算', isObject: true })
  gone.deleted = true
  const goneChild = createTextBlock({ entityId: 'sg', blockUid: 'sg000001', text: '也不该算', parent: 'sp' })
  goneChild.deleted = true
  const stats = buildSidebarStats([page, child, gone, goneChild], new Date(2026, 9, 24, 12).getTime())

  assert.equal(stats.pages, 1, '回收站页面不算')
  assert.equal(stats.tags, 2, '标签按 id 去重，回收站里的标签不算')
  assert.equal(stats.chars, Array.from('墨契').length + Array.from('笔记 📝').length, '正文可见字符；emoji 算一个')
})

test('SIDE-STATS-2 统计数字简写：千位 k、万位 万、亿位 亿', () => {
  assert.equal(formatCompactCount(999), '999')
  assert.equal(formatCompactCount(1_000), '1k')
  assert.equal(formatCompactCount(1_234), '1.2k')
  assert.equal(formatCompactCount(12_345), '1.2万')
  assert.equal(formatCompactCount(123_456_789), '1.2亿')
})

test('SIDE-HEAT-1 热力图按天统计有改动的页面，同一页面多块只算一次，未来格子不计数', () => {
  const now = new Date(2026, 9, 24, 12).getTime() //  周六
  const day = (d: number, h = 12) => new Date(2026, 9, d, h).getTime()
  const a = createTextBlock({ entityId: 'ha', blockUid: 'ha000001', text: 'A', isObject: true, objectName: 'A', now: day(24) })
  const aChild = createTextBlock({ entityId: 'hac', blockUid: 'hac00001', text: 'A 子块', parent: 'ha', now: day(24) })
  const b = createTextBlock({ entityId: 'hb', blockUid: 'hb000001', text: 'B', isObject: true, objectName: 'B', now: day(23) })
  const gone = createTextBlock({ entityId: 'hg', blockUid: 'hg000001', text: '回收站', isObject: true, objectName: '回收站', now: day(24) })
  gone.deleted = true

  const stats = buildSidebarStats([a, aChild, b, gone], now)
  const flat = stats.weeks.flat()
  const today = flat.find((entry) => entry.key === '2026-10-24')
  const yesterday = flat.find((entry) => entry.key === '2026-10-23')
  assert.equal(today?.count, 1, '同页面的两个块当天只算一次')
  assert.equal(yesterday?.count, 1)
  assert.equal(stats.activeDays, 2)
  assert.equal(stats.peak, 1)
  assert.equal(stats.weeks.length, 12, '固定 12 周')
  assert.equal(flat.length, 84, '12 × 7 天')
  assert.ok(flat.some((entry) => entry.future), '当前周今天之后有占位格')
  assert.equal(flat.filter((entry) => entry.future).every((entry) => entry.count === 0), true, '未来格子不计入')
})

test('LIFECYCLE-PURGE-5 彻底删除先落盘后摘内存：子树收全、成功后切页并重建，失败保留页面', async () => {
  const page = createTextBlock({ entityId: 'rp', blockUid: 'rp000001', text: '待删', isObject: true, objectName: '待删' })
  const live = createTextBlock({ entityId: 'rl', blockUid: 'rl000001', text: '活的子块', parent: 'rp' })
  const soft = createTextBlock({ entityId: 'rs', blockUid: 'rs000001', text: '更早删除的子块', parent: 'rp' })
  soft.deleted = true
  page.children = ['rl']
  const other = createTextBlock({ entityId: 'ro', blockUid: 'ro000001', text: '另一页', isObject: true, objectName: '另一页' })
  const store = new DomainStore([page, live, soft, other])
  const batches: Array<{ purged: string[] }> = []
  const storage = {
    commitPersistBatch: async (batch: { purged: string[] }) => { batches.push(batch) },
    purgeBlocks: async () => undefined,
  } as unknown as PurgeDeps['storage']
  const assetPort = {
    listNames: async () => [],
    remove: async () => undefined,
  } as unknown as PurgeDeps['assetPort']
  const states: string[] = []
  const notices: string[] = []
  const reloads: Array<{ pageId: string | null; persistAll: boolean }> = []
  const activated: Array<string | null> = []
  let refreshed = 0
  const deps = (overrides: Partial<PurgeDeps> = {}): PurgeDeps => ({
    store, storage, assetPort,
    flushPendingPersist: async () => undefined,
    reloadFromStore: (pageId, persistAll) => { reloads.push({ pageId, persistAll }) },
    setAssetNames: () => undefined,
    setSaveState: (state) => { states.push(state) },
    notify: (message) => { notices.push(message) },
    getActivePageId: () => 'rp',
    setActivePageId: (id) => { activated.push(id) },
    setView: () => undefined,
    refresh: () => { refreshed += 1 },
    ...overrides,
  })

  await runPurge(['rp'], deps())
  assert.deepEqual(batches[0]?.purged.slice().sort(), ['rl', 'rp', 'rs'], '软删除后代必须一起落盘')
  assert.equal(store.snapshot().has('rp'), false)
  assert.equal(store.snapshot().has('ro'), true)
  assert.deepEqual(states, ['saving', 'saved'])
  assert.deepEqual(activated, ['ro'], '删掉当前页 → 切到下一张')
  assert.deepEqual(reloads, [{ pageId: 'ro', persistAll: false }], '数据库已是终态，重建时不再全库写回')
  assert.equal(refreshed, 1, '直接改 store 后显式刷新派生数据')
  assert.deepEqual(notices, [])

  const failedPage = createTextBlock({ entityId: 'fp', blockUid: 'fp000001', text: '失败页', isObject: true, objectName: '失败页' })
  const failedStore = new DomainStore([failedPage])
  const failedStates: string[] = []
  const failedNotices: string[] = []
  let failedReload = false
  await runPurge(['fp'], {
    ...deps(),
    store: failedStore,
    storage: { commitPersistBatch: async () => { throw new Error('FOREIGN KEY constraint failed') } } as unknown as PurgeDeps['storage'],
    setSaveState: (state) => { failedStates.push(state) },
    notify: (message) => { failedNotices.push(message) },
    reloadFromStore: () => { failedReload = true },
  })
  assert.equal(failedStore.snapshot().has('fp'), true, '落盘失败 → 页面原样保留')
  assert.deepEqual(failedStates, ['saving', 'error'])
  assert.match(failedNotices[0] ?? '', /删除失败：FOREIGN KEY constraint failed.*没有改动任何内容/)
  assert.equal(failedReload, false, '失败不重建、不切页')
})
