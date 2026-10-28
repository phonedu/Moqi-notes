import assert from 'node:assert/strict'
import test from 'node:test'
import { $createParagraphNode, $createRangeSelection, $createTextNode, $getRoot, $getSelection, $isLineBreakNode, $isRangeSelection, $getNodeByKey, $setSelection, RootNode, type LexicalEditor, type LexicalNode } from 'lexical'
import { MemoryStorage } from '../../src/adapters/ports'
import { SerialPersistQueue } from '../../src/application/persistQueue'
import { DomainStore, type Operation } from '../../src/application/store'
import { createTextBlock, splitContentAtOffset, type Block, type PropertyDef } from '@moqi/editor'
import { applyPropertyValue, coercePropertyValue, emptyRegistry, ensureTagDef, getPropertyValue } from '@moqi/editor'
import { validateBlockGraph } from '@moqi/editor'
import { $ensureNameLineAnchor, $inlineTextChildren, $isBlockNode, $isInlineFragmentNode, $isNameLineAnchor, $trimInlineRef, ownLineFlag, type BlockNode } from '@moqi/editor'
import { $caretOffsetInBlock, $selectOffsetInBlock } from '@moqi/editor'
import { blocksFromEditor, blocksFromEditorState, createMoqiEditor, editorBlockIds, editorStateFromBlocks, findBlockNodeByEntityId, loadBlocksIntoEditor, $adoptRootContent } from '@moqi/editor'

// D 类：将用户行为映射为核心 API 序列；DOM 光标与 IME 由桌面验收覆盖。
function openDocument(text = '') {
  const root = createTextBlock({ entityId: 'page', blockUid: 'page00001', text: '页面', isObject: true, objectName: '页面' })
  const paragraph = createTextBlock({ entityId: 'paragraph', blockUid: 'para00001', text, parent: root.entityId })
  const following = createTextBlock({ entityId: 'following', blockUid: 'next00001', text: '后续段落', parent: root.entityId })
  root.children = [paragraph.entityId, following.entityId]
  return new DomainStore([root, paragraph, following])
}

/**
 * 同 `openDocument`，另加**一页别的页面**（`other`）。对象引用的用例要拿它当目标：
 * D-014（2026-10-04）之后「本篇」不再是合法目标，而这份夹具里唯一那页就是本篇自己。
 */
function openDocumentWithOtherPage(text = '') {
  const base = openDocument(text)
  const other = createTextBlock({ entityId: 'other', blockUid: 'other0001', text: '另一页', isObject: true, objectName: '另一页' })
  return new DomainStore([...base.snapshot().values(), other])
}

function apply(store: DomainStore, operations: Operation[]) {
  store.apply({ id: crypto.randomUUID(), operations, timestamp: Date.now(), source: 'user' })
  assert.deepEqual(validateBlockGraph(store.snapshot()), [])
}

function replaceText(store: DomainStore, id: string, text: string) {
  const previous = store.get(id)!
  apply(store, [{ type: 'update', opId: crypto.randomUUID(), blockId: id,
    changes: { content: text ? [{ t: 'text', v: text }] : [] }, previous: { content: previous.content } }])
}

function splitParagraph(store: DomainStore, id: string, offset: number): string {
  const block = store.get(id)!
  const [before, after] = splitContentAtOffset(block.content, offset)
  const parentId = block.parent ?? (block.isObject ? block.entityId : null)
  const parent = parentId ? store.get(parentId)! : undefined
  const next = createTextBlock({ entityId: crypto.randomUUID(), blockUid: crypto.randomUUID().replaceAll('-', '').slice(0, 9), text: '', parent: parentId })
  next.content = after
  apply(store, [
    { type: 'update', opId: crypto.randomUUID(), blockId: id, changes: { content: before }, previous: { content: block.content } },
    { type: 'insert', opId: crypto.randomUUID(), block: next, parentId,
      index: parentId === id ? 0 : (parent?.children.indexOf(id) ?? -1) + 1 },
  ])
  return next.entityId
}

function textOf(store: DomainStore, id: string): string {
  const block = store.get(id)
  assert.ok(block, `Missing block: ${id}`)
  return block.content.map((fragment) => fragment.v).join('')
}

async function reopen(storage: MemoryStorage): Promise<DomainStore> {
  const store = new DomainStore(await storage.loadBlocks())
  assert.deepEqual(validateBlockGraph(store.snapshot()), [])
  // 恢复路径包含生产 Lexical 映射，防止空段/顺序在适配层丢失。
  const editor = createMoqiEditor()
  editorStateFromBlocks(editor, store.snapshot())
  const roundTrip = blocksFromEditor(editor, store.snapshot())
  // Lexical represents an empty paragraph as no text node. Treat that as the
  // same persisted value as a zero-length text fragment.
  const normalize = (blocks: Map<string, Block>) => [...blocks].map(([id, block]) => [id, {
    ...block,
    content: block.content.filter((fragment) => fragment.v.length > 0),
  }])
  assert.deepEqual(normalize(roundTrip), normalize(store.snapshot()))
  return store
}

test('LIFECYCLE-SAVE-1: open → type → save → reopen preserves content and identity', async () => {
  const storage = new MemoryStorage()
  const store = openDocument()
  await storage.saveBlocks([...store.snapshot().values()])
  replaceText(store, 'paragraph', '开始写作，中文与 emoji 🙂')
  await storage.saveBlockChanges([store.get('paragraph')!])
  const restored = await reopen(storage)
  assert.deepEqual(restored.snapshot(), store.snapshot())
  assert.equal(textOf(restored, 'paragraph'), '开始写作，中文与 emoji 🙂')
  assert.equal(textOf(restored, 'following'), '后续段落')
})

for (const [position, offset, expected] of [
  ['start', 0, ['', '前半后半']],
  ['middle', 2, ['前半', '后半']],
  ['end', 4, ['前半后半', '']],
] as const) {
  test(`D: type → Enter at ${position} → save → reopen keeps each side once and adjacent`, async () => {
    const storage = new MemoryStorage()
    const store = openDocument()
    replaceText(store, 'paragraph', '前半后半')
    const nextId = splitParagraph(store, 'paragraph', offset)
    await storage.saveBlocks([...store.snapshot().values()])
    const restored = await reopen(storage)
    assert.deepEqual([textOf(restored, 'paragraph'), textOf(restored, nextId)], expected)
    assert.deepEqual(restored.get('page')!.children, ['paragraph', nextId, 'following'])
    assert.equal(textOf(restored, 'following'), '后续段落')
    assert.equal(restored.snapshot().size, 4)
  })
}

test('D: empty paragraph → repeated Enter → save → reopen retains empty paragraphs without duplicating text', async () => {
  const storage = new MemoryStorage()
  const store = openDocument()
  const first = splitParagraph(store, 'paragraph', 0)
  const second = splitParagraph(store, first, 0)
  await storage.saveBlocks([...store.snapshot().values()])
  const restored = await reopen(storage)
  assert.deepEqual(restored.get('page')!.children, ['paragraph', first, second, 'following'])
  assert.deepEqual(['paragraph', first, second].map((id) => textOf(restored, id)), ['', '', ''])
  assert.equal(textOf(restored, 'following'), '后续段落')
  assert.equal(restored.snapshot().size, 5)
})

test('D: split object body → save → reopen places new paragraph before existing children', async () => {
  const storage = new MemoryStorage()
  const store = openDocument('已有第一段')
  replaceText(store, 'page', '对象正文')
  const nextId = splitParagraph(store, 'page', 2)
  await storage.saveBlocks([...store.snapshot().values()])
  const restored = await reopen(storage)
  assert.deepEqual(restored.get('page')!.children, [nextId, 'paragraph', 'following'])
  assert.deepEqual([textOf(restored, 'page'), textOf(restored, nextId)], ['对象', '正文'])
  assert.equal(textOf(restored, 'paragraph'), '已有第一段')
})

test('D: save old text → delete → retype → Enter → save → reopen never resurrects deleted text', async () => {
  const storage = new MemoryStorage()
  const store = openDocument('已经删除的旧文字')
  await storage.saveBlocks([...store.snapshot().values()])
  replaceText(store, 'paragraph', '')
  replaceText(store, 'paragraph', '新的内容')
  const nextId = splitParagraph(store, 'paragraph', 2)
  await storage.saveBlockChanges([store.get('page')!, store.get('paragraph')!, store.get(nextId)!])
  const restored = await reopen(storage)
  assert.deepEqual([textOf(restored, 'paragraph'), textOf(restored, nextId)], ['新的', '内容'])
  assert.deepEqual(restored.get('page')!.children, ['paragraph', nextId, 'following'])
  assert.equal(JSON.stringify([...restored.snapshot()]).includes('已经删除的旧文字'), false)
})

test('D: delayed save → delete and retype during save → flush → reopen restores latest edit', { timeout: 5000 }, async () => {
  const storage = new MemoryStorage()
  const store = openDocument()
  await storage.saveBlocks([...store.snapshot().values()])
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const writes: string[] = []
  const queue = new SerialPersistQueue<Block[]>(async (blocks) => {
    writes.push(blocks[0].content.map((fragment) => fragment.v).join(''))
    if (writes.length === 1) await blocked
    await storage.saveBlockChanges(blocks)
  })
  replaceText(store, 'paragraph', '旧内容')
  queue.enqueue([store.get('paragraph')!])
  try {
    replaceText(store, 'paragraph', '')
    queue.enqueue([store.get('paragraph')!])
    replaceText(store, 'paragraph', '保存期间继续输入')
    queue.enqueue([store.get('paragraph')!])
    assert.equal(textOf(store, 'paragraph'), '保存期间继续输入')
    assert.equal(textOf(await reopen(storage), 'paragraph'), '')
  } finally {
    release()
    await queue.flush()
  }
  const restored = await reopen(storage)
  assert.deepEqual(writes, ['旧内容', '保存期间继续输入'])
  assert.equal(textOf(restored, 'paragraph'), '保存期间继续输入')
  assert.equal(textOf(restored, 'following'), '后续段落')
})

test('BLOCK-TAB-7: Tab indent → save → reopen keeps the block under the previous sibling with its subtree', async () => {
  const storage = new MemoryStorage()
  const store = openDocument()
  // Give `following` its own subtree, then indent it under the previous sibling `paragraph`.
  const nested = createTextBlock({ entityId: 'nested', blockUid: 'nest00001', text: '嵌套子级', parent: 'following' })
  apply(store, [{ type: 'insert', opId: crypto.randomUUID(), block: nested, parentId: 'following', index: 0 }])
  await storage.saveBlocks([...store.snapshot().values()])
  assert.equal(store.indent('following'), true)
  await storage.saveBlockChanges([store.get('page')!, store.get('paragraph')!, store.get('following')!, store.get('nested')!])
  const restored = await reopen(storage)
  assert.deepEqual(restored.get('page')!.children, ['paragraph'])
  assert.deepEqual(restored.get('paragraph')!.children, ['following'])
  assert.deepEqual(restored.get('following')!.children, ['nested'])
  assert.equal(restored.get('nested')!.parent, 'following')
  assert.equal(textOf(restored, 'nested'), '嵌套子级')
})

test('BLOCK-FOLD-1: collapse → indent → save → reopen preserves collapsed flag and structure', async () => {
  const storage = new MemoryStorage()
  const store = openDocument('带子级的段落')
  const nested = createTextBlock({ entityId: 'nested', blockUid: 'nest00002', text: '嵌套子级', parent: 'paragraph' })
  apply(store, [{ type: 'insert', opId: crypto.randomUUID(), block: nested, parentId: 'paragraph', index: 0 }])
  apply(store, [{ type: 'collapse', opId: crypto.randomUUID(), blockId: 'paragraph', collapsed: true }])
  await storage.saveBlocks([...store.snapshot().values()])
  assert.equal(store.indent('following'), true)
  await storage.saveBlockChanges([store.get('page')!, store.get('paragraph')!, store.get('following')!, store.get('nested')!])
  const restored = await reopen(storage)
  assert.deepEqual(restored.get('page')!.children, ['paragraph'])
  assert.equal(restored.get('paragraph')!.collapsed, true)
  assert.deepEqual(restored.get('paragraph')!.children, ['nested', 'following'])
  assert.equal(textOf(restored, 'paragraph'), '带子级的段落')
})

// The outline plugin applies the domain operation first, then mirrors the same
// move on the Lexical tree. These tests exercise that mirror mapping directly,
// since the React command wiring itself is covered by desktop acceptance.
function mirrorMove(editor: LexicalEditor, id: string, move: 'indent' | 'outdent') {
  const key = findBlockNodeByEntityId(editor, id)!.getKey()
  let moved = false
  editor.update(() => {
    const node = $getNodeByKey(key)
    if (!$isBlockNode(node)) return
    if (move === 'indent') {
      const previous = node.getPreviousSibling()
      if ($isBlockNode(previous)) { previous.append(node); moved = true }
    } else {
      const parent = node.getParent()
      if ($isBlockNode(parent)) { parent.insertAfter(node); moved = true }
    }
  }, { discrete: true })
  assert.equal(moved, true, `mirror ${move} should move the block`)
}

function withNestedChild(store: DomainStore) {
  const nested = createTextBlock({ entityId: 'nested', blockUid: 'nest00003', text: '嵌套子级', parent: 'following' })
  apply(store, [{ type: 'insert', opId: crypto.randomUUID(), block: nested, parentId: 'following', index: 0 }])
}

function mirrorDrop(editor: LexicalEditor, id: string, targetId: string, position: 'before' | 'after' | 'into') {
  const key = findBlockNodeByEntityId(editor, id)!.getKey()
  const targetKey = findBlockNodeByEntityId(editor, targetId)!.getKey()
  let moved = false
  editor.update(() => {
    const node = $getNodeByKey(key)
    const target = $getNodeByKey(targetKey)
    if (!$isBlockNode(node) || !$isBlockNode(target)) return
    if (position === 'into') target.append(node)
    else if (position === 'before') target.insertBefore(node)
    else target.insertAfter(node)
    moved = true
  }, { discrete: true })
  assert.equal(moved, true, `mirror drop ${position} should move the block`)
}

test('BLOCK-MIRROR-1: editor mirror → indent carries the whole subtree and reads back the new parent', () => {
  const store = openDocument()
  withNestedChild(store)
  const editor = createMoqiEditor()
  editorStateFromBlocks(editor, store.snapshot())
  mirrorMove(editor, 'following', 'indent')
  const next = blocksFromEditor(editor, store.snapshot())
  assert.deepEqual(next.get('page')!.children, ['paragraph'])
  assert.deepEqual(next.get('paragraph')!.children, ['following'])
  assert.deepEqual(next.get('following')!.children, ['nested'])
  assert.equal(next.get('following')!.parent, 'paragraph')
  assert.equal(next.get('nested')!.parent, 'following')
})

test('D: editor mirror → outdent lifts the node after its former parent and keeps order', () => {
  const store = openDocument()
  withNestedChild(store)
  const editor = createMoqiEditor()
  editorStateFromBlocks(editor, store.snapshot())
  mirrorMove(editor, 'following', 'indent')
  mirrorMove(editor, 'following', 'outdent')
  const next = blocksFromEditor(editor, store.snapshot())
  assert.deepEqual(next.get('page')!.children, ['paragraph', 'following'])
  assert.deepEqual(next.get('following')!.children, ['nested'])
  assert.equal(next.get('following')!.parent, 'page')
})

test('D: editor mirror → toggle collapse reads back the flag without touching data', () => {
  const store = openDocument('带子级的段落')
  const nested = createTextBlock({ entityId: 'nested', blockUid: 'nest00002', text: '嵌套子级', parent: 'paragraph' })
  apply(store, [{ type: 'insert', opId: crypto.randomUUID(), block: nested, parentId: 'paragraph', index: 0 }])
  const editor = createMoqiEditor()
  editorStateFromBlocks(editor, store.snapshot())
  const key = findBlockNodeByEntityId(editor, 'paragraph')!.getKey()
  editor.update(() => {
    const node = $getNodeByKey(key)
    if ($isBlockNode(node)) node.setCollapsed(true)
  }, { discrete: true })
  const collapsed = blocksFromEditor(editor, store.snapshot())
  assert.equal(collapsed.get('paragraph')!.collapsed, true)
  assert.deepEqual(collapsed.get('paragraph')!.children, ['nested'])
  assert.equal(collapsed.get('nested')!.content.map((fragment) => fragment.v).join(''), '嵌套子级')
  editor.update(() => {
    const node = $getNodeByKey(key)
    if ($isBlockNode(node)) node.setCollapsed(false)
  }, { discrete: true })
  assert.equal(blocksFromEditor(editor, store.snapshot()).get('paragraph')!.collapsed, false)
})

test('D: editor mirror → drag into a target appends the subtree and reads back the new parent', () => {
  const store = openDocument()
  withNestedChild(store)
  const editor = createMoqiEditor()
  editorStateFromBlocks(editor, store.snapshot())
  mirrorDrop(editor, 'paragraph', 'following', 'into')
  const next = blocksFromEditor(editor, store.snapshot())
  assert.deepEqual(next.get('page')!.children, ['following'])
  assert.deepEqual(next.get('following')!.children, ['nested', 'paragraph'])
  assert.equal(next.get('paragraph')!.parent, 'following')
})

test('D: editor mirror → drag before a sibling reorders and reads back', () => {
  const store = openDocument()
  const editor = createMoqiEditor()
  editorStateFromBlocks(editor, store.snapshot())
  mirrorDrop(editor, 'following', 'paragraph', 'before')
  const next = blocksFromEditor(editor, store.snapshot())
  assert.deepEqual(next.get('page')!.children, ['following', 'paragraph'])
  assert.equal(next.get('following')!.parent, 'page')
})

test('D: drag move → save → reopen keeps the new parent and subtree', async () => {
  const storage = new MemoryStorage()
  const store = openDocument()
  withNestedChild(store)
  await storage.saveBlocks([...store.snapshot().values()])
  const beforeInvalid = JSON.stringify([store.get('page'), store.get('paragraph'), store.get('following'), store.get('nested')])
  assert.equal(store.move('page', 'nested', 0), false)
  assert.equal(store.move('paragraph', 'paragraph', 0), false)
  assert.equal(JSON.stringify([store.get('page'), store.get('paragraph'), store.get('following'), store.get('nested')]), beforeInvalid)
  assert.equal(store.move('following', 'paragraph', 1), true)
  await storage.saveBlockChanges([store.get('page')!, store.get('paragraph')!, store.get('following')!, store.get('nested')!])
  const restored = await reopen(storage)
  assert.deepEqual(restored.get('page')!.children, ['paragraph'])
  assert.deepEqual(restored.get('paragraph')!.children, ['following'])
  assert.deepEqual(restored.get('following')!.children, ['nested'])
  assert.equal(restored.get('following')!.parent, 'paragraph')
  assert.equal(restored.get('nested')!.parent, 'following')
})

// T12 mirrors the `/` menu: the domain applies the type update first, then the
// Lexical tree clears inline content and switches the BlockNode type. These
// tests exercise that mapping; DOM keyboard/IME is covered by desktop acceptance.
function mirrorConvert(editor: LexicalEditor, id: string, type: Block['type']) {
  const key = findBlockNodeByEntityId(editor, id)!.getKey()
  editor.update(() => {
    const node = $getNodeByKey(key)
    if (!$isBlockNode(node)) return
    for (const child of node.getChildren()) if (!$isBlockNode(child)) child.remove()
    node.setBlockType(type)
  }, { discrete: true })
}

test('BLOCK-TYPE-4: editor mirror → type conversion reads back the new type and keeps the subtree', () => {
  const store = openDocument('待转换')
  const nested = createTextBlock({ entityId: 'type-child', blockUid: 'type00001', text: '嵌套子级', parent: 'paragraph' })
  apply(store, [{ type: 'insert', opId: crypto.randomUUID(), block: nested, parentId: 'paragraph', index: 0 }])
  const editor = createMoqiEditor()
  editorStateFromBlocks(editor, store.snapshot())
  assert.deepEqual(store.convertType('paragraph', 'todo', []), ['paragraph'])
  mirrorConvert(editor, 'paragraph', 'todo')
  const next = blocksFromEditor(editor, store.snapshot())
  assert.equal(next.get('paragraph')!.type, 'todo')
  assert.deepEqual(next.get('paragraph')!.content, [])
  assert.deepEqual(next.get('paragraph')!.children, ['type-child'])
  assert.equal(next.get('type-child')!.parent, 'paragraph')
  assert.equal(next.get('type-child')!.content.map((fragment) => fragment.v).join(''), '嵌套子级')
})

test('D: editor mirror → closing the `/` menu keeps the trigger as ordinary text', () => {
  const store = openDocument('/')
  const editor = createMoqiEditor()
  editorStateFromBlocks(editor, store.snapshot())
  const next = blocksFromEditor(editor, store.snapshot())
  assert.equal(next.get('paragraph')!.type, 'text')
  assert.equal(next.get('paragraph')!.content.map((fragment) => fragment.v).join(''), '/')
})

test('D: editor mirror → todo checkbox reads back checked without touching text', () => {
  const store = openDocument('行动项')
  store.convertType('paragraph', 'todo')
  const editor = createMoqiEditor()
  editorStateFromBlocks(editor, store.snapshot())
  const key = findBlockNodeByEntityId(editor, 'paragraph')!.getKey()
  editor.update(() => {
    const node = $getNodeByKey(key)
    if ($isBlockNode(node)) node.setChecked(true)
  }, { discrete: true })
  const next = blocksFromEditor(editor, store.snapshot())
  assert.equal(next.get('paragraph')!.type, 'todo')
  assert.equal(next.get('paragraph')!.checked, true)
  assert.equal(next.get('paragraph')!.content.map((fragment) => fragment.v).join(''), '行动项')
})

test('BLOCK-TYPE-3: todo convert → check → save → reopen keeps type, text and checked', async () => {
  const storage = new MemoryStorage()
  const store = openDocument('行动项')
  await storage.saveBlocks([...store.snapshot().values()])
  assert.ok(store.convertType('paragraph', 'todo'))
  apply(store, [{ type: 'update', opId: crypto.randomUUID(), blockId: 'paragraph', changes: { checked: true }, previous: { checked: false } }])
  await storage.saveBlockChanges([store.get('page')!, store.get('paragraph')!])
  const restored = await reopen(storage)
  assert.equal(restored.get('paragraph')!.type, 'todo')
  assert.equal(restored.get('paragraph')!.checked, true)
  assert.equal(textOf(restored, 'paragraph'), '行动项')
  assert.deepEqual(restored.get('page')!.children, ['paragraph', 'following'])
})

// T13 maps the `[[`/`((` menus: the domain writes the content + ref transaction
// first, then the Lexical mirror rebuilds inline content. The DOM menu, IME and
// click-to-jump are covered by desktop acceptance.
test('D: type [[ → accept object link → save → reopen keeps inline-ref binding and backRefs', async () => {
  const storage = new MemoryStorage()
  const store = openDocumentWithOtherPage('参见 [[页')
  await storage.saveBlocks([...store.snapshot().values()])
  const affected = store.insertRef('paragraph', 'object', 'other', { trigger: '[[', query: '页', displayText: '另一页' })
  assert.ok(affected)
  await storage.saveBlockChanges([store.get('other')!, store.get('paragraph')!])
  const restored = await reopen(storage)
  assert.deepEqual(restored.get('paragraph')!.content, [
    { t: 'text', v: '参见 ' },
    { t: 'inline-ref', v: '另一页', ref: { kind: 'object', targetId: 'other' } },
  ])
  assert.deepEqual(restored.get('other')!.objectBackRefs, ['paragraph'])
  assert.deepEqual(restored.get('page')!.children, ['paragraph', 'following'])
})

/**
 * D-011（2026-10-05）：**行内高亮要落领域层**——它是 Lexical 的 format 位（不是 style），
 * 曾经只做了「编辑器里看得见」：`marksFromTextNode` / `applyMarks` 两侧都没有 `highlight`，
 * 于是切页或重载就丢（界面在承诺、数据没有）。这条锁的就是「写得出、读得回」。
 */
test('D-011: 行内高亮经编辑器 ↔ 领域往返后仍在（含与其它格式共存）', () => {
  const store = openDocument()
  store.apply({ id: crypto.randomUUID(), timestamp: Date.now(), source: 'user', operations: [{
    type: 'update', opId: crypto.randomUUID(), blockId: 'paragraph',
    changes: { content: [
      { t: 'text', v: '高亮', marks: [{ type: 'highlight' }] },
      { t: 'text', v: '并在', marks: [{ type: 'bold' }, { type: 'highlight' }] },
      { t: 'text', v: '普通' },
    ] },
    previous: { content: store.get('paragraph')!.content },
  }] })
  const editor = createMoqiEditor()
  editorStateFromBlocks(editor, store.snapshot())
  const next = blocksFromEditor(editor, store.snapshot())
  const content = next.get('paragraph')!.content
  assert.deepEqual(content.map((f) => f.v).join(''), '高亮并在普通')
  assert.deepEqual(content[0].marks?.map((m) => m.type), ['highlight'], '高亮要原样读回来（这就叫「落领域层」）')
  assert.deepEqual([...(content[1].marks ?? [])].map((m) => m.type).sort(), ['bold', 'highlight'], '高亮与加粗共存')
  assert.equal(content[2].marks, undefined, '没标的地方不许被带上格式')
})

test('D: type (( → accept block link → Lexical round trip keeps the target binding', () => {
  const store = openDocument('见 ((')
  const affected = store.insertRef('paragraph', 'block', 'following', { trigger: '((', query: '', displayText: '后续段落' })
  assert.ok(affected)
  const editor = createMoqiEditor()
  editorStateFromBlocks(editor, store.snapshot())
  const next = blocksFromEditor(editor, store.snapshot())
  assert.deepEqual(next.get('paragraph')!.content, [
    { t: 'text', v: '见 ' },
    { t: 'inline-ref', v: '后续段落', ref: { kind: 'block', targetId: 'following' } },
  ])
  assert.deepEqual(next.get('following')!.blockBackRefs.map((ref) => ref.fromBlockId), ['paragraph'])
})

// T14: the panel reads reverse links from forward refs, so soft-deleting a
// source hides it by default and restoring it brings the entry back.
test('REF-BACK-2: accept link → panel lists source → delete hides → restore shows again', () => {
  const store = openDocumentWithOtherPage('[[页')
  const snapshots = [{ blockId: 'paragraph', prevParent: 'page', prevIndex: 0 }]
  assert.ok(store.insertRef('paragraph', 'object', 'other', { trigger: '[[', query: '页', displayText: '另一页' }))
  assert.deepEqual(store.backlinks('other').map((entry) => entry.sourceId), ['paragraph'])

  apply(store, [{ type: 'delete', opId: crypto.randomUUID(), blockId: 'paragraph', descendantIds: [], snapshots }])
  assert.deepEqual(store.backlinks('other'), [])
  assert.deepEqual(store.backlinks('other', true).map((entry) => entry.sourceId), ['paragraph'])

  apply(store, [{ type: 'restore', opId: crypto.randomUUID(), blockId: 'paragraph', snapshots }])
  assert.deepEqual(store.backlinks('other').map((entry) => entry.sourceId), ['paragraph'])
})

// T15: property edits are ordinary `update` operations; the registry lives
// outside Block JSON, so it round-trips through the metadata port.
test('PROPS-VALUE-2: set property and tag → save registry → reopen keeps typed value and tag id', async () => {
  const storage = new MemoryStorage()
  const store = openDocument('任务')
  await storage.saveBlocks([...store.snapshot().values()])

  const status: PropertyDef = { id: 'def-status', name: '状态', type: 'select', options: [{ id: 'opt-doing', label: '进行中' }], created: 1, modified: 1 }
  const registry = { ...emptyRegistry(), properties: [status] }
  const { id: tagId, registry: withTag } = ensureTagDef('工程', registry)
  await storage.saveMetadata(withTag)

  assert.equal(store.setProperty('paragraph', 'def-status', coercePropertyValue(status, 'opt-doing')), true)
  assert.equal(store.addTag('paragraph', tagId), true)
  await storage.saveBlockChanges([store.get('paragraph')!])

  const restored = await reopen(storage)
  assert.deepEqual(getPropertyValue(restored.get('paragraph')!.properties, 'def-status'), { defId: 'def-status', type: 'select', optionId: 'opt-doing' })
  assert.deepEqual(restored.get('paragraph')!.tags, [tagId])

  const loadedRegistry = await storage.loadMetadata()
  assert.equal(loadedRegistry?.tags.find((tag) => tag.id === tagId)?.name, '工程')
  assert.equal(applyPropertyValue(restored.get('paragraph')!.properties, null, 'def-status')?.length, 0)
})

// T15: the recycle bin restores a deleted subtree with its former parent and
// index instead of flattening it to the top level.
test('LIFECYCLE-RESTORE-2: delete subtree → recycle bin → restore puts the whole tree back', async () => {
  const storage = new MemoryStorage()
  const store = openDocument('父级')
  const child = createTextBlock({ entityId: 'child', blockUid: 'child0001', text: '子级', parent: 'paragraph' })
  apply(store, [{ type: 'insert', opId: crypto.randomUUID(), block: child, parentId: 'paragraph', index: 0 }])
  await storage.saveBlocks([...store.snapshot().values()])
  assert.deepEqual(store.get('paragraph')!.children, ['child'])

  apply(store, [{ type: 'delete', opId: crypto.randomUUID(), blockId: 'paragraph', descendantIds: ['child'], snapshots: [
    { blockId: 'paragraph', prevParent: 'page', prevIndex: 0 },
    { blockId: 'child', prevParent: 'paragraph', prevIndex: 0 },
  ] }])
  await storage.saveBlockChanges([store.get('paragraph')!, store.get('child')!])
  assert.deepEqual(store.deletedRoots().map((block) => block.entityId), ['paragraph'])

  assert.equal(store.restore('paragraph'), true)
  assert.deepEqual(store.get('page')!.children, ['paragraph', 'following'])
  assert.equal(store.get('child')!.parent, 'paragraph')
  assert.deepEqual([store.get('paragraph')!.position, store.get('following')!.position], [0, 1])
  await storage.saveBlockChanges([store.get('paragraph')!, store.get('child')!, store.get('following')!])

  const restored = await reopen(storage)
  assert.deepEqual(restored.get('page')!.children, ['paragraph', 'following'])
  assert.equal(restored.get('child')!.parent, 'paragraph')
  assert.equal(textOf(restored, 'child'), '子级')
})

// T16: multi-select copy is one transaction that rebuilds identity and lands
// after the source; the copy survives a save/reload cycle.
test('D: multi-select copy → save → reopen keeps a fresh identity tree after the source', async () => {
  const storage = new MemoryStorage()
  const store = openDocument('原段落')
  await storage.saveBlocks([...store.snapshot().values()])

  const rootIds = store.copy(['paragraph'])
  assert.equal(rootIds?.length, 1)
  const copyId = rootIds![0]
  await storage.saveBlockChanges([...store.snapshot().values()])

  const restored = await reopen(storage)
  assert.deepEqual(restored.get('page')!.children, ['paragraph', copyId, 'following'])
  assert.equal(textOf(restored, copyId), '原段落')
  assert.notEqual(restored.get(copyId)!.blockUid, restored.get('paragraph')!.blockUid)
  assert.equal(validateBlockGraph(restored.snapshot()).length, 0)
})

// T20: a copy whose subtree links itself must remap that internal binding to the
// copy after a save/reopen, and it must carry aiMeta unchanged.
test('D: copy internal ref → save → reopen keeps the remapped binding and aiMeta', async () => {
  const storage = new MemoryStorage()
  const store = openDocument('父级')
  const child = createTextBlock({ entityId: 'child', blockUid: 'child0002', text: '子级', parent: 'paragraph' })
  child.content = [{ t: 'inline-ref', v: '父级', ref: { kind: 'block', targetId: 'paragraph' } }]
  child.blockRefs = [{ targetBlockId: 'paragraph', fromBlockId: 'child', type: 'link' }]
  apply(store, [{ type: 'insert', opId: crypto.randomUUID(), block: child, parentId: 'paragraph', index: 0 }])
  apply(store, [{ type: 'update', opId: crypto.randomUUID(), blockId: 'paragraph',
    changes: { aiMeta: { action: 'summary', status: 'complete', sourceBlockIds: ['following'] } },
    previous: { aiMeta: null } }])
  await storage.saveBlocks([...store.snapshot().values()])

  const rootIds = store.copy(['paragraph'])
  const copyId = rootIds![0]
  await storage.saveBlockChanges([...store.snapshot().values()])
  const restored = await reopen(storage)

  const copied = restored.get(copyId)!
  const copiedChildId = copied.children[0]
  assert.deepEqual(copied.aiMeta, { action: 'summary', status: 'complete', sourceBlockIds: ['following'] })
  assert.deepEqual(restored.get(copiedChildId)!.content, [
    { t: 'inline-ref', v: '父级', ref: { kind: 'block', targetId: copyId } },
  ])
  assert.deepEqual(restored.get(copiedChildId)!.blockRefs.map((ref) => ref.targetBlockId), [copyId])
  assert.equal(validateBlockGraph(restored.snapshot()).length, 0)
})

// T16: a batch delete persists the soft-deleted subtree, and the toast undo
// (store.undo) puts the whole selection back in one step.
test('SELECT-5: multi-select delete → save → toast undo restores every selected root', async () => {
  const storage = new MemoryStorage()
  const store = openDocument('第一段')
  await storage.saveBlocks([...store.snapshot().values()])

  const deleted = store.deleteSelection(['paragraph'])
  assert.deepEqual(deleted, ['paragraph'])
  await storage.saveBlockChanges([...store.snapshot().values()])

  const afterDelete = await reopen(storage)
  assert.deepEqual(afterDelete.get('page')!.children, ['following'])
  assert.equal(afterDelete.get('paragraph')!.deleted, true)

  store.undo()
  await storage.saveBlockChanges([...store.snapshot().values()])
  const afterUndo = await reopen(storage)
  assert.deepEqual(afterUndo.get('page')!.children, ['paragraph', 'following'])
  assert.equal(afterUndo.get('paragraph')!.deleted, false)
})

// T17: an AI result persists with its provenance and leaves the source
// original untouched, even when it needs human confirmation.
test('AI-INSERT-2: AI summary → save → reopen keeps aiMeta and the original source text', async () => {
  const storage = new MemoryStorage()
  const store = openDocument('原始输入')
  await storage.saveBlocks([...store.snapshot().values()])

  const resultIds = store.insertAiResults({ sourceIds: ['paragraph'], action: 'summary', items: ['总结结果'], status: 'needs-confirmation', confidence: 0.4 })
  assert.equal(resultIds?.length, 1)
  await storage.saveBlockChanges([...store.snapshot().values()])

  const restored = await reopen(storage)
  assert.equal(textOf(restored, 'paragraph'), '原始输入')
  const result = restored.get(resultIds![0])!
  assert.equal(result.type, 'text')
  assert.equal(textOf(restored, resultIds![0]), '总结结果')
  assert.deepEqual(result.aiMeta?.sourceBlockIds, ['paragraph'])
  assert.equal(result.aiMeta?.status, 'needs-confirmation')
  assert.equal(result.aiMeta?.confidence, 0.4)
  assert.deepEqual(restored.get('paragraph')!.children, [])
  assert.equal(validateBlockGraph(restored.snapshot()).length, 0)
})

test('AI-UNDO-1: AI 一次生成只占一个撤销步——流式节拍走镜像，⌘Z 一次撤掉整块', () => {
  const store = openDocument('原始输入')
  const placeholder = createTextBlock({ entityId: 'ai-block', blockUid: 'ai000001', text: '', parent: 'page' })
  placeholder.aiMeta = { action: 'summary', status: 'generating', sourceBlockIds: ['paragraph'] }
  apply(store, [{ type: 'insert', opId: crypto.randomUUID(), block: placeholder, parentId: 'page', index: 1 }])

  /** 生产链路（EditorShell.setAiBlockStatus）：状态流转也走镜像，不是用户动作。 */
  const mirrorStatus = (status: 'generating' | 'complete') => {
    const current = store.get('ai-block')!
    const operations: Operation[] = [{
      type: 'update', opId: crypto.randomUUID(), blockId: 'ai-block',
      changes: { aiMeta: { ...current.aiMeta!, status } }, previous: { aiMeta: current.aiMeta },
    }]
    store.applyMirror({ id: crypto.randomUUID(), operations, timestamp: Date.now(), source: 'ai' })
  }

  // 落块之后，流式正文按 90ms 节拍镜像写回（EditorShell.flushAiStream）。
  let streamed = ''
  for (let tick = 0; tick < 60; tick += 1) {
    streamed += `第${tick}段`
    store.convertType('ai-block', 'text', [{ t: 'text', v: streamed }], { mirror: true })
    mirrorStatus('generating')
  }
  mirrorStatus('complete')
  assert.equal(textOf(store, 'ai-block'), streamed)
  assert.equal(store.get('page')!.children.includes('ai-block'), true)

  // 一次撤销撤掉的是整次生成（落块那一步），而不是最后一个流片段。
  store.undo()
  assert.equal(store.get('ai-block')!.deleted, true)
  assert.equal(textOf(store, 'paragraph'), '原始输入')
  assert.equal(validateBlockGraph(store.snapshot()).length, 0)

  // 重做把整段流式正文原样带回来（正文属于领域状态，不是撤销栈里的几十条中间态）。
  store.redo()
  assert.equal(store.get('ai-block')!.deleted, false)
  assert.equal(textOf(store, 'ai-block'), streamed)
})

test('D: 历史 mention 片段按纯文本加载，正文不丢字也不残留行内标签节点', () => {
  const store = openDocument()
  const paragraph = store.get('paragraph')!
  // 行内 `#标签` 裁决不做前的存量数据长这样：正文里夹着 `mention` 片段。
  apply(store, [{
    type: 'update', opId: crypto.randomUUID(), blockId: 'paragraph',
    changes: { content: [{ t: 'text', v: '整理一下 ' }, { t: 'mention', v: '#副业' }, { t: 'text', v: ' 的清单' }] },
    previous: { content: paragraph.content },
  }])

  const editor = createMoqiEditor()
  editorStateFromBlocks(editor, store.snapshot())

  // 编辑器不再注册行内标签节点，历史数据必须原样读出来。
  const serialized = JSON.stringify(editor.getEditorState().toJSON())
  assert.equal(serialized.includes('moqi-inline-tag'), false, '不应再出现行内标签节点')
  assert.equal(serialized.includes('#副业'), true, '历史正文必须保留')

  const next = blocksFromEditor(editor, store.snapshot()).get('paragraph')!
  assert.equal(next.content.map((fragment) => fragment.v).join(''), '整理一下 #副业 的清单')
  assert.ok(next.content.every((fragment) => fragment.t === 'text'), 'mention 片段应归一为 text')
})

test('D: 一次写入失败不会丢掉失败期间排队的快照，也不会卡死队列', { timeout: 5000 }, async () => {
  const storage = new MemoryStorage()
  const store = openDocument()
  await storage.saveBlocks([...store.snapshot().values()])
  const writes: string[] = []
  let failOnce = true
  const queue = new SerialPersistQueue<Block[]>(async (blocks) => {
    const text = blocks[0].content.map((fragment) => fragment.v).join('')
    if (failOnce) {
      failOnce = false
      throw new Error('模拟一次写入失败')
    }
    writes.push(text)
    await storage.saveBlockChanges(blocks)
  })

  replaceText(store, 'paragraph', '第一次')
  queue.enqueue([store.get('paragraph')!])
  let failed: unknown = null
  try {
    await queue.flush()
  } catch (error) {
    failed = error
  }
  assert.ok(failed instanceof Error, '失败必须通过 flush 上报，不能静默吞掉')

  // 失败之后继续编辑：新快照必须照常落盘
  replaceText(store, 'paragraph', '失败后继续输入')
  queue.enqueue([store.get('paragraph')!])
  await queue.flush()
  assert.deepEqual(writes, ['失败后继续输入'])
  assert.equal(textOf(await reopen(storage), 'paragraph'), '失败后继续输入')
})

test('D: 失败发生时已排队的新快照不会被丢弃', { timeout: 5000 }, async () => {
  const storage = new MemoryStorage()
  const store = openDocument()
  await storage.saveBlocks([...store.snapshot().values()])
  const writes: string[] = []
  let release!: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  let first = true
  const queue = new SerialPersistQueue<Block[]>(async (blocks) => {
    const text = blocks[0].content.map((fragment) => fragment.v).join('')
    if (first) {
      first = false
      await blocked
      throw new Error('模拟失败')
    }
    writes.push(text)
    await storage.saveBlockChanges(blocks)
  })
  replaceText(store, 'paragraph', '慢写入')
  queue.enqueue([store.get('paragraph')!])
  replaceText(store, 'paragraph', '失败期间排队')
  queue.enqueue([store.get('paragraph')!])
  const flushed = queue.flush().catch(() => undefined)
  release()
  await flushed
  await queue.flush().catch(() => undefined)
  assert.deepEqual(writes, ['失败期间排队'], '失败期间排队的快照必须在恢复后写入')
  assert.equal(textOf(await reopen(storage), 'paragraph'), '失败期间排队')
})


// ---------- 打开页面后的 selection 与根级内容收编（docs/04 §9「异常都回到可继续写作」） ----------

/** 编辑器一次只承载一个页面子树：页面对象块 + 它的后代。 */
function pageDocument() {
  const page = createTextBlock({ entityId: 'page', blockUid: 'page00001', text: '', isObject: true, objectName: '页面' })
  const body = createTextBlock({ entityId: 'b1', blockUid: 'b1000001', text: '', parent: 'page' })
  page.children = ['b1']
  return { page, body, blocks: new Map([[page.entityId, page], [body.entityId, body]]) }
}

/** 取光标所在的最内层 Block（不是顶层容器）。 */
function innermostBlock(node: LexicalNode): BlockNode | null {
  let cursor: LexicalNode | null = node
  while (cursor) {
    if ($isBlockNode(cursor)) return cursor
    cursor = cursor.getParent()
  }
  return null
}

test('打开页面后光标落在页面容器自己的那一行：新建页面后直接打字就是页面名（R04-NAME-3）', () => {
  const editor = createMoqiEditor()
  const { blocks } = pageDocument()
  loadBlocksIntoEditor(editor, blocks)
  editor.getEditorState().read(() => {
    const selection = $getSelection()
    assert.ok($isRangeSelection(selection), '加载后必须有 selection')
    const block = innermostBlock(selection.anchor.getNode())
    assert.ok(block, '光标必须落在 Block 内')
    // 2026-09-29 更正：这条用例过去断言「落在第一个正文块 b1」——它能过，靠的正是
    // 「容器自己那一行没有落脚点 ⇒ 光标被归一化下压进子块」这个缺陷（见 07 的 R04-NAME-11）。
    // 契约是 R04-NAME-3：打开 / 新建页面的落点是**页面容器自己的那一行**（页面名所在行）。
    assert.equal(block.getEntityId(), 'page', '光标落在页面容器（名字行），不是下面的正文块')
    assert.equal(selection.anchor.type, 'element', '名字行为空时是容器的 element 点（打字即写进名字）')
  })
})

test('根级正文被收编进页面容器：根上永远只剩页面容器，正文成为真正的 Block', async () => {
  const editor = createMoqiEditor()
  const { blocks } = pageDocument()
  loadBlocksIntoEditor(editor, blocks)
  // 与 EditorShell 注册的是同一条 transform：根上出现容器以外的内容就收编
  const adoptedIds: string[] = []
  let sequence = 0
  editor.registerNodeTransform(RootNode, (root) => {
    const container = root.getChildren().find((node) => $isBlockNode(node) && node.isPageObject())
    if (!$isBlockNode(container)) return
    if (root.getChildren().every((node) => node === container)) return
    const adopted = $adoptRootContent(container, () => ({ entityId: `adopted-${++sequence}`, blockUid: `badopt00${sequence}` }))
    adoptedIds.push(...adopted.map((item) => item.entityId))
  })
  // 用户动作：光标在根上直接打字（Lexical 会生成根级段落）
  editor.update(() => {
    const stray = $createParagraphNode()
    stray.append($createTextNode('根级正文'))
    $getRoot().append(stray)
  })
  await new Promise((resolve) => setTimeout(resolve, 50))
  editor.getEditorState().read(() => {
    const root = $getRoot()
    assert.equal(root.getChildren().length, 1, '根上只能剩下页面容器')
    const container = root.getFirstChild()
    assert.ok($isBlockNode(container))
    const kids = container.getChildren().filter($isBlockNode)
    assert.equal(kids.length, 2, '收编来的正文成为容器的第二个子块')
    assert.equal(kids[1].getTextContent(), '根级正文', '正文与行内格式一并保留')
    assert.equal(kids[1].getEntityId(), adoptedIds[0], '领域层拿到的 identity 与树里的 Block 一致')
    assert.ok(kids[1].getEntityId() && kids[1].getBlockUid() && kids[1].getBlockType(), '收编后的块带完整 identity，能直接落库')
  })
})

test('BLOCK-CARET-1: 块被搬动后 Lexical 的选择仍指向同一节点（结构操作不抢光标）', () => {
  // 缩进 / 反缩进 / 拖拽 / 转换类型都在同一个 editor.update 里搬动节点。
  // 光标位置按**节点 key** 记录，搬动不改 key，所以只要不显式 selectStart()，
  // 光标就留在用户刚写完的那个字后面（此前每次都回块首，写完一句话一缩进就跳到段首）。
  const store = openDocument()
  withNestedChild(store)
  const editor = createMoqiEditor()
  editorStateFromBlocks(editor, store.snapshot())
  let textKey = ''
  editor.update(() => {
    const block = findBlockNodeByEntityId(editor, 'following')!
    const text = block.getChildren().find((child) => 'getTextContent' in child && !$isBlockNode(child))!
    textKey = text.getKey()
    const selection = $createRangeSelection()
    selection.anchor.set(textKey, 2, 'text')
    selection.focus.set(textKey, 2, 'text')
    $setSelection(selection)
  }, { discrete: true })

  mirrorMove(editor, 'following', 'indent')
  const moved = editor.getEditorState().read(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection)) return null
    return { key: selection.anchor.key, offset: selection.anchor.offset, type: selection.anchor.type }
  })
  assert.deepEqual(moved, { key: textKey, offset: 2, type: 'text' }, '块被搬动后光标应留在原处')

  // 搬完再走一次「回块首」的老办法，确认它确实是丢光标的那一步（对照）。
  editor.update(() => {
    findBlockNodeByEntityId(editor, 'following')?.selectStart()
  }, { discrete: true })
  const afterSelectStart = editor.getEditorState().read(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection)) return null
    return { key: selection.anchor.key, offset: selection.anchor.offset, type: selection.anchor.type }
  })
  assert.notDeepEqual(afterSelectStart, { key: textKey, offset: 2, type: 'text' })
})

test('D: 块内光标偏移的读与还（领域重建之后把光标放回原处）', () => {
  // 整篇重建会换掉所有节点（key 全变），所以「保持光标」只能靠块内字符偏移表达：
  // 重建前 $caretOffsetInBlock 读一次、重建后 $selectOffsetInBlock 放回去。
  const store = openDocument()
  withNestedChild(store)
  const editor = createMoqiEditor()
  editorStateFromBlocks(editor, store.snapshot())
  const readOffset = () => editor.getEditorState().read(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection)) return null
    const block = findBlockNodeByEntityId(editor, 'following')
    if (!block) return null
    return $caretOffsetInBlock(block, selection.anchor.key, selection.anchor.offset)
  })
  editor.update(() => {
    const block = findBlockNodeByEntityId(editor, 'following')!
    $selectOffsetInBlock(block, 3)
  }, { discrete: true })
  assert.equal(readOffset(), 3, '放到第 3 个字之后应能读回 3')
  // 超出块内文字长度时钳到末尾，不会抛错也不会跑到别的块
  editor.update(() => {
    const block = findBlockNodeByEntityId(editor, 'following')!
    $selectOffsetInBlock(block, 999)
  }, { discrete: true })
  assert.equal(readOffset(), 4, '「后续段落」4 个字，越界钳到末尾')
})

test('D: 光标不在该块时读不到偏移（不猜、不串块）', () => {
  const store = openDocument()
  const editor = createMoqiEditor()
  editorStateFromBlocks(editor, store.snapshot())
  editor.update(() => {
    const other = findBlockNodeByEntityId(editor, 'paragraph')!
    $selectOffsetInBlock(other, 0)
  }, { discrete: true })
  const fromOtherBlock = editor.getEditorState().read(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection)) return null
    const block = findBlockNodeByEntityId(editor, 'following')!
    return $caretOffsetInBlock(block, selection.anchor.key, selection.anchor.offset)
  })
  assert.equal(fromOtherBlock, null)
})

// ---------- 2026-09-28：换文档格式归零 / 编辑器侧删除的镜像 ----------

test('LIFECYCLE-OPEN-2 换文档（loadBlocksIntoEditor）后行内格式归零：上一处光标的加粗不带进新文档', () => {
  const store = openDocument('加粗的字')
  const editor = createMoqiEditor()
  editorStateFromBlocks(editor, store.snapshot())
  // 先把光标处的「待输入格式」设成加粗（等价于用户在正文里按了 ⌘B）
  editor.update(() => {
    const selection = $getSelection()
    if ($isRangeSelection(selection)) selection.formatText('bold')
  }, { discrete: true })
  const before = editor.getEditorState().read(() => {
    const selection = $getSelection()
    return $isRangeSelection(selection) ? selection.hasFormat('bold') : null
  })
  assert.equal(before, true, '前置条件：换文档之前光标处是加粗态')

  // 换文档（打开另一个页面 / 新建页面走的都是这一条）
  loadBlocksIntoEditor(editor, store.snapshot())

  const after = editor.getEditorState().read(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection)) return null
    return { bold: selection.hasFormat('bold'), italic: selection.hasFormat('italic'), format: selection.format }
  })
  assert.deepEqual(after, { bold: false, italic: false, format: 0 }, '换文档后必须是「无格式」的新文档')
})

test('BLOCK-SYNC-2 editorBlockIds 只报编辑器真正承载的块：删掉的块不再出现（镜像删除的依据）', () => {
  const store = openDocument()
  const editor = createMoqiEditor()
  editorStateFromBlocks(editor, store.snapshot())
  assert.deepEqual([...editorBlockIds(editor.getEditorState())].sort(), ['following', 'page', 'paragraph'])

  // 编辑器里删掉「following」这一块（等价于 Backspace 把空块合并掉）
  const key = findBlockNodeByEntityId(editor, 'following')!.getKey()
  editor.update(() => { $getNodeByKey(key)?.remove() }, { discrete: true })
  assert.deepEqual([...editorBlockIds(editor.getEditorState())].sort(), ['page', 'paragraph'], '删掉的块必须从「编辑器承载」集合里消失')
  // 对照：blocksFromEditorState 会把 base 里遗留的块原样带回来，所以它算不出「少了什么」
  assert.ok(blocksFromEditorState(editor.getEditorState(), store.snapshot()).has('following'))
})

test('BLOCK-LINE-2 ownLineFlag：块有子块但自己没有行内内容时要补出自己那一行', () => {
  assert.equal(ownLineFlag({ inlineText: 0, blocks: 1 }), 'missing')
  assert.equal(ownLineFlag({ inlineText: 1, blocks: 1 }), 'present')
  assert.equal(ownLineFlag({ inlineText: 0, blocks: 0 }), 'present', '空块自己就有一行（Lexical 渲染 <br>），不需要补')
})

test('BLOCK-LINE-3 ownLineFlag 看的是可见文字，不是行内子节点个数（R04-NAME-11）', () => {
  assert.equal(ownLineFlag({ inlineText: 0, blocks: 0, isObject: true }), 'missing', '新建的空页面：名字行锚点零宽，仍要占位 + 空行')
  assert.equal(ownLineFlag({ inlineText: 0, blocks: 2, isObject: true }), 'missing', '名字被删光、下面还有子块')
  assert.equal(ownLineFlag({ inlineText: 3, blocks: 0, isObject: true }), 'present', '有名字就不补')
})

test('BLOCK-LINE-4 名字行锚点：页面容器永远持有零宽锚点，其它块不补（R04-NAME-11）', () => {
  const store = openDocument()
  replaceText(store, 'page', '') // 空名字的页面容器
  const editor = createMoqiEditor()
  editorStateFromBlocks(editor, store.snapshot())
  editor.getEditorState().read(() => {
    const container = findBlockNodeByEntityId(editor, 'page')!
    const children = container.getChildren()
    assert.equal(children.length, 4, '锚点 + 行盒持有者 + 两个子块')
    assert.ok($isNameLineAnchor(children[0]))
    assert.equal(children[0]!.getTextContentSize(), 0, '锚点零宽：不参与块内字符偏移')
    assert.ok($isLineBreakNode(children[1]), '空名字行带行盒持有者（`D-072`：Android WebView 靠它画光标）')
    assert.deepEqual($inlineTextChildren(container), [children[1]], '锚点不算行内文字；持有者是唯一的行内节点')
    assert.ok($isBlockNode(children[2]) && $isBlockNode(children[3]), '锚点排在行内文字之后、子块之前')
    const paragraph = findBlockNodeByEntityId(editor, 'paragraph')!
    assert.equal(paragraph.getChildren().some($isNameLineAnchor), false, '其它块不补锚点')
  })
  // 锚点不是内容：序列化回领域后首行仍是空的（不落 [{t:'text',v:''}] 这种噪声）
  const blocks = blocksFromEditorState(editor.getEditorState(), store.snapshot())
  assert.deepEqual(blocks.get('page')!.content, [])
})

test('BLOCK-LINE-5 锚点自维护：被归一化收走后能补回，且不重复补（R04-NAME-11）', () => {
  const store = openDocument()
  replaceText(store, 'page', '')
  const editor = createMoqiEditor()
  editorStateFromBlocks(editor, store.snapshot())
  editor.update(() => {
    const container = findBlockNodeByEntityId(editor, 'page')!
    const anchor = container.getChildren()[0]!
    assert.ok($isNameLineAnchor(anchor))
    anchor.remove()
    assert.equal($ensureNameLineAnchor(container), true, '缺了就补')
    assert.equal($ensureNameLineAnchor(container), false, '补过之后不再重复补（幂等）')
    assert.equal(container.getChildrenSize(), 4, '锚点 + 行盒持有者 + 两个子块')
  }, { discrete: true })
})

test('BLOCK-LINE-7 名字行为空时打字写进页面名，不掉进下面的子块（R04-NAME-11）', () => {
  const store = openDocument()
  replaceText(store, 'page', '')
  const editor = createMoqiEditor()
  editorStateFromBlocks(editor, store.snapshot())
  editor.update(() => {
    const container = findBlockNodeByEntityId(editor, 'page')!
    // 与「点名字行 / 删掉名字最后一个字之后」等价的落点：容器自己那一行
    const selection = $createRangeSelection()
    selection.anchor.set(container.getKey(), 0, 'element')
    selection.focus.set(container.getKey(), 0, 'element')
    $setSelection(selection)
    selection.insertText('新页名')
  }, { discrete: true })
  const blocks = blocksFromEditorState(editor.getEditorState(), store.snapshot())
  assert.equal(blocks.get('page')!.content.map((fragment) => fragment.v).join(''), '新页名', '敲的字要成为页面名')
  assert.equal(blocks.get('paragraph')!.content.map((fragment) => fragment.v).join(''), '', '子块不被写入')
  assert.equal(blocks.get('following')!.content.map((fragment) => fragment.v).join(''), '后续段落', '其他子块原样不动')
})

test('BLOCK-REF-1 行内引用：不可合并、首尾空白挪到链接之外（R04-CARET-5）', () => {
  const store = openDocument()
  const previous = store.get('paragraph')!
  const ref = { t: 'inline-ref' as const, v: '目标页面', ref: { kind: 'object' as const, targetId: 'page' } }
  apply(store, [{ type: 'update', opId: crypto.randomUUID(), blockId: 'paragraph',
    changes: { content: [ref] }, previous: { content: previous.content } }])
  const editor = createMoqiEditor()
  editorStateFromBlocks(editor, store.snapshot())
  editor.update(() => {
    const node = findBlockNodeByEntityId(editor, 'paragraph')!
    const refNode = node.getChildren()[0]!
    assert.ok($isInlineFragmentNode(refNode), '第一个子节点是行内引用')
    assert.equal(refNode.isUnmergeable(), true, '链接不可合并（相邻文本不并进来）')
    // 链接首尾的空白挪到链接之外，内部空格保留（页面名可以是「项目 B」）
    refNode.setTextContent(' 项目 B ')
    assert.equal($trimInlineRef(refNode), true, '首尾空白被挪走')
    assert.equal(refNode.getTextContent(), '项目 B', '链接文字只留中间的')
    const texts = node.getChildren().filter((child) => !$isBlockNode(child)).map((child) => (($isInlineFragmentNode(child) ? 'ref' : 'text') + ':' + child.getTextContent()))
    assert.deepEqual(texts, ['text: ', 'ref:项目 B', 'text: '], '空白成为链接之外的普通文本，链接仍是链接')
  }, { discrete: true })
  // 链接首尾不留空白：改写后仍然只有一个链接、且文字不带首尾空白
  const after = blocksFromEditorState(editor.getEditorState(), store.snapshot()).get('paragraph')!
  const refs = after.content.filter((fragment) => fragment.t === 'inline-ref')
  assert.equal(refs.length, 1, '只有一个链接')
  assert.equal(refs[0]!.v, '项目 B', '链接文字不带首尾空白（下划线不跟着空格长）')
})
