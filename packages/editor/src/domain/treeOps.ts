/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createTextBlock, orderedRootIds } from './block'
import type { Block, BlockMap } from './block'
import type { Operation, Transaction } from './operation'
import type { OutlineDraft } from './mdSyntax'

/**
 * 一页的子树快照（深拷贝、剔除已删块）。编辑器整篇重建（换页 / 撤销 / 同步应用）
 * 与「读整篇」的 AI 入口都按它取正文——**原件留在 store 里**，把它铺进 Lexical 之后
 * 编辑器改的是这份副本。原住在 `ui/EditorShell.tsx`， 还债 #2 模块③
 * 抽出 AI 运行时时下沉到领域（两个模块都要用，纯函数，本来就该在这里）。
 */
export function subtreeMap(blocks: BlockMap, pageId: string): BlockMap {
  const output: BlockMap = new Map()
  const visit = (id: string) => {
    const block = blocks.get(id)
    if (!block || block.deleted) return
    output.set(id, structuredClone(block))
    for (const childId of block.children) visit(childId)
  }
  visit(pageId)
  return output
}

/** 一页的子树 id（文档序）；没有当前页时为空。 */
export function activePageSubtreeIds(blocks: BlockMap, pageId: string | null): string[] {
  if (!pageId) return []
  return [...subtreeMap(blocks, pageId).keys()]
}

/**
 * 彻底删除要用的整棵子树：**按 `parent` 链收，不依赖父块的 `children`**。
 *
 * 页面进回收站前删掉的子块会从父块的 `children` 里摘掉（软删除），但 `parent` 仍指向父块；
 * 只按 `children` 收集会漏掉它们，SQLite 的自引用外键随后让整批删除回滚（`D-091`）。
 * 同时把 `children` 边也算进来：数据一侧断链时仍尽量收全；`seen` 防环。
 */
export function purgeSubtreeIds(blocks: Iterable<Block>, roots: Iterable<string>): string[] {
  const all = [...blocks]
  const edges = new Map<string, Set<string>>()
  const link = (parentId: string, childId: string) => {
    const set = edges.get(parentId)
    if (set) set.add(childId)
    else edges.set(parentId, new Set([childId]))
  }
  for (const block of all) {
    if (block.parent) link(block.parent, block.entityId)
    for (const childId of block.children) link(block.entityId, childId)
  }
  const seen = new Set<string>()
  const queue: string[] = []
  const visit = (id: string) => {
    if (seen.has(id)) return
    seen.add(id)
    queue.push(id)
  }
  for (const id of roots) visit(id)
  while (queue.length > 0) {
    const id = queue.shift()!
    for (const childId of edges.get(id) ?? []) visit(childId)
  }
  return [...seen]
}

/** 目标块所属的页面（向上找最近的对象块）；块本身是页面时返回自身。 */
export function owningPageId(blocks: BlockMap, blockId: string): string | null {
  let cursor = blocks.get(blockId)
  while (cursor) {
    if (cursor.isObject) return cursor.entityId
    cursor = cursor.parent ? blocks.get(cursor.parent) : undefined
  }
  return null
}

/**
 * `candidateId` 是不是 `nodeId` 自己或它的祖先（含面自引用与环）。
 *
 * 两个消费者：嵌入块拒收「自己 / 自己的祖先」做来源（源子树摊开渲染时里面就有这个嵌入块，
 * 指向祖先 = 无限递归，13-媒体设计（已归档） §8）；`validation` 载入外部文件时用同一条判据兜底
 * （不再各写一份向上的循环——这正是「单一所有者」要避免的那种重复）。
 */
export function isSelfOrAncestor(blocks: BlockMap, nodeId: string, candidateId: string): boolean {
  let cursor: string | null = nodeId
  while (cursor) {
    if (cursor === candidateId) return true
    cursor = blocks.get(cursor)?.parent ?? null
  }
  return false
}

/**
 * T20: ancestors of `targetId` whose `collapsed` flag hides it, nearest
 * ancestor first. Jump navigation expands these before scrolling.
 */
export function collapsedAncestors(blocks: BlockMap, targetId: string): string[] {
  const result: string[] = []
  let cursor = blocks.get(targetId)?.parent ?? null
  while (cursor !== null) {
    const parent = blocks.get(cursor)
    if (!parent) break
    if (parent.collapsed) result.push(parent.entityId)
    cursor = parent.parent
  }
  return result
}

/**
 * V2a D-012: indent/outdent are compositions of the existing `move`
 * operation. Each helper validates against the V2a contract (spec §4.1)
 * and returns null when the action is a defined no-op, so the caller never
 * creates an empty transaction:
 *   - Tab on a root Block or a first child does nothing.
 *   - Shift+Tab on a root Block does nothing.
 *   - Shift+Tab on a Block whose parent is the page container does nothing
 *     （docs/09 §409 页面容器不是缩进层级）：领域里那会生成一个新的根块，
 *     等于把正文块移出本篇——编辑器里掉到页面末尾，刷新后整块从页面与页面库消失。
 * The moved Block keeps its whole subtree; per-node `collapsed` states stay
 * untouched because children arrays travel with the moved Block.
 */
export function indentBlock(blocks: BlockMap, blockId: string, now = Date.now()): Omit<Transaction, 'inverse'> | null {
  const block = blocks.get(blockId)
  if (!block || block.deleted || block.parent === null) return null
  const parent = blocks.get(block.parent)
  if (!parent) return null
  const index = parent.children.indexOf(blockId)
  if (index <= 0) return null
  const prevSiblingId = parent.children[index - 1]
  const prevSibling = blocks.get(prevSiblingId)
  if (!prevSibling || prevSibling.deleted) return null
  const operation: Operation = {
    type: 'move',
    opId: crypto.randomUUID(),
    blockId,
    oldParentId: parent.entityId,
    oldIndex: index,
    newParentId: prevSiblingId,
    newIndex: prevSibling.children.length,
  }
  return { id: crypto.randomUUID(), operations: [operation], timestamp: now, source: 'user' }
}

export function outdentBlock(blocks: BlockMap, blockId: string, now = Date.now()): Omit<Transaction, 'inverse'> | null {
  const block = blocks.get(blockId)
  if (!block || block.deleted || block.parent === null) return null
  const parent = blocks.get(block.parent)
  if (!parent) return null
  const oldIndex = parent.children.indexOf(blockId)
  if (oldIndex < 0) return null
  // 页面对象块是页面容器（docs/09 §409）：它的直接子块已经在最左边缘，反缩进没有可去的层级。
  const grandparentId = parent.parent
  if (grandparentId === null) return null
  const operation: Operation = {
    type: 'move',
    opId: crypto.randomUUID(),
    blockId,
    oldParentId: parent.entityId,
    oldIndex,
    newParentId: grandparentId,
    newIndex: blocks.get(grandparentId)!.children.indexOf(parent.entityId) + 1,
  }
  return { id: crypto.randomUUID(), operations: [operation], timestamp: now, source: 'user' }
}

function rootIndex(blocks: BlockMap, blockId: string): number {
  return orderedRootIds(blocks).indexOf(blockId)
}

/**
 * V2a D-012: a desktop drag becomes a single `move` transaction (spec §3.3).
 * Returns null for a defined no-op so a cancelled or invalid drop never
 * produces an operation:
 *   - dropping onto the dragged Block or into its own subtree (would create a cycle);
 *   - dropping back into the same slot it already occupies.
 * T15: root order is explicit via `position`, so a root `before/after` drop
 * reorders roots by index instead of being ignored.
 */
export function moveBlock(
  blocks: BlockMap,
  blockId: string,
  newParentId: string | null,
  newIndex: number,
  now = Date.now(),
): Omit<Transaction, 'inverse'> | null {
  const block = blocks.get(blockId)
  if (!block || block.deleted) return null
 // D13 顺带审计（）：**页面容器不能被移进别的块**——它能做的只有根级重排。
  // 缩进 / 反缩进本来就靠 `parent === null` 拦住，这里补上移动这一条（域层把关，界面只是第一道）。
  if (block.isObject && newParentId !== null) return null
  if (newParentId === blockId) return null
  let cursor = newParentId
  while (cursor) {
    if (cursor === blockId) return null
    cursor = blocks.get(cursor)?.parent ?? null
  }
  if (newParentId !== null) {
    const parent = blocks.get(newParentId)
    if (!parent || parent.deleted) return null
  }
  const oldParentId = block.parent
  const oldIndex = oldParentId ? blocks.get(oldParentId)!.children.indexOf(blockId) : rootIndex(blocks, blockId)
  if (oldParentId === newParentId && (newIndex === oldIndex || newIndex === oldIndex + 1)) return null
  const operation: Operation = {
    type: 'move',
    opId: crypto.randomUUID(),
    blockId,
    oldParentId,
    oldIndex,
    newParentId,
    newIndex,
  }
  return { id: crypto.randomUUID(), operations: [operation], timestamp: now, source: 'user' }
}

/**
 * γ2（）：**块组拖拽** —— 把一组（父级去重后的）根块**一次事务**移到同一个落点，
 * **保持组内相对顺序**、**一步撤销**（与 `copy` / `deleteSelection` 同一写法：数组入参 → 一个 transaction）。
 *
 * 下标口径（关键）：`applyMove` 按 id 移除、但 `newIndex` 是「**块仍在原位**那份列表的空位」
 * （同父且 `oldIndex < newIndex` 时它自己减 1）⇒ 这里用一份**只覆盖被触及父块**的影子 children / root 序，
 * **逐笔递进**算 `oldIndex` / `newIndex`；否则组内第二块起会互相挤位（不做全库克隆：性能纪律）。
 *
 * 返回 `null` = 定义好的 no-op（**整组都不动**）：任一成员落点非法（自身 / 自身子树 / 页面容器进别的块 /
 * 父块已删）或整组落回原槽。**不做「部分生效」**——界面的「回弹」语义靠它。
 */
export function moveBlocks(
  blocks: BlockMap,
  rootIds: string[],
  newParentId: string | null,
  newIndex: number,
  now = Date.now(),
): Omit<Transaction, 'inverse'> | null {
  const selected = new Set(rootIds)
  // 父级去重：祖先也在集合里的块不再单独移动（整棵跟着父走）
  const roots = rootIds.filter((id) => {
    const block = blocks.get(id)
    if (!block || block.deleted) return false
    let cursor = block.parent
    while (cursor) {
      if (selected.has(cursor)) return false
      cursor = blocks.get(cursor)?.parent ?? null
    }
    return true
  })
  if (roots.length === 0) return null

  const ROOT_KEY = '\u0000root'
  const shadow = new Map<string, string[]>()
  const listOf = (parentId: string | null): string[] => {
    const key = parentId ?? ROOT_KEY
    let list = shadow.get(key)
    if (!list) {
      list = parentId === null ? orderedRootIds(blocks) : [...(blocks.get(parentId)?.children ?? [])]
      shadow.set(key, list)
    }
    return list
  }

  const operations: Operation[] = []
  for (let i = 0; i < roots.length; i += 1) {
    const id = roots[i]
    const block = blocks.get(id)!
    if (block.isObject && newParentId !== null) return null
    if (newParentId === id) return null
    let cursor: string | null = newParentId
    while (cursor) {
      if (cursor === id) return null
      cursor = blocks.get(cursor)?.parent ?? null
    }
    if (newParentId !== null) {
      const parent = blocks.get(newParentId)
      if (!parent || parent.deleted) return null
    }
    const oldParentId = block.parent
    const oldIndex = listOf(oldParentId).indexOf(id)
    const desired = newIndex + i // 最终位置（「块已不在列表里」的口径）
    const payloadIndex = oldParentId === newParentId && oldIndex >= 0 && oldIndex < desired ? desired + 1 : desired
    if (oldParentId === newParentId && oldIndex === payloadIndex) return null // 整组落回原槽 ⇒ no-op
    operations.push({ type: 'move', opId: crypto.randomUUID(), blockId: id, oldParentId, oldIndex, newParentId, newIndex: payloadIndex })
    // 影子推进：从原父移除、插到目标父（供下一笔的下标参考）
    const from = listOf(oldParentId)
    const at = from.indexOf(id)
    if (at >= 0) from.splice(at, 1)
    listOf(newParentId).splice(desired, 0, id)
  }
  if (operations.length === 0) return null
  return { id: crypto.randomUUID(), operations, timestamp: now, source: 'user' }
}

/**
 * 把一棵**草稿树**（`mdSyntax.parseMarkdownOutline` 的产物）整棵插到某个块之后——**一个事务**
 * （粘贴即转换要「一次撤销」回来，`R09-MD-4.4`）。
 *
 * 位置规则：锚点本身是页面容器 → 落进页面内部（追加到末尾）；否则插在锚点所在列表里、锚点之后。
 * 草稿没有 entityId（那是插入时才分配的），所以这里生成 id 与 blockUid、按父子的顺序建 children。
 */
export function insertOutlineAfter(
  blocks: BlockMap,
  anchorId: string,
  drafts: OutlineDraft[],
  now = Date.now(),
  newId: () => string = () => crypto.randomUUID(),
): { transaction: Omit<Transaction, 'inverse'>; blockIds: string[] } | null {
  const anchor = blocks.get(anchorId)
  if (!anchor || anchor.deleted) return null
  if (drafts.length === 0) return null

  const parentId = anchor.parent ?? (anchor.isObject ? anchor.entityId : null)
  const parent = parentId ? blocks.get(parentId) : null
  if (parentId !== null && (!parent || parent.deleted)) return null
  const baseIndex = parentId === anchor.entityId
    ? anchor.children.length
    : parentId === null
      ? rootIndex(blocks, anchorId) + 1
      : (parent?.children.indexOf(anchorId) ?? -1) + 1

  const operations: Operation[] = []
  const blockIds: string[] = []
  let position = baseIndex

  const visit = (draft: OutlineDraft, parentForDraft: string | null, at: number) => {
    const id = newId()
    const block = createTextBlock({ entityId: id, blockUid: newId(), text: draft.text, parent: parentForDraft, now })
    block.type = draft.type
    block.checked = draft.checked ?? false
    block.position = at
    if (draft.type === 'divider') block.content = []
    else if (draft.content) block.content = draft.content
    if (draft.asset) block.asset = draft.asset
    blockIds.push(id)
    operations.push({ type: 'insert', opId: crypto.randomUUID(), block, parentId: parentForDraft, index: at })
    // 引用点与片段**一起写**（导入还原出来的 `[名](名.md)` → `inline-ref`）：
    // 只落片段不落引用点，反链面板与悬空计数都看不到这条引用（13-导出与媒体设计（已归档） §「导入」）。
    for (const ref of draft.refs ?? []) {
      operations.push(ref.kind === 'object'
        ? { type: 'object-ref', opId: crypto.randomUUID(), fromId: id, targetId: ref.targetId }
        : { type: 'block-ref', opId: crypto.randomUUID(), fromId: id, targetId: ref.targetId, refType: 'link' })
    }
    let childAt = 0
    for (const child of draft.children) {
      visit(child, id, childAt)
      childAt += 1
    }
  }
  for (const draft of drafts) {
    visit(draft, parentId, position)
    position += 1
  }
  return { transaction: { id: crypto.randomUUID(), operations, timestamp: now, source: 'user' }, blockIds }
}

/**
 * 一篇文档 → **一个新页面**（导入 13-导出与媒体设计（已归档） §「导入」）：页面容器与正文草稿树
 * **落在同一个事务里** —— 一次撤销把整篇退回，不会留半个空页面。
 *
 * 结构约定与 `insertOutlineAfter` 一致：页面容器自己的那行文字就是页名（`R09-EDIT-3`），
 * 正文草稿是它的**子块**（对象锚点 ⇒ 往容器内部插，见 `insertOutlineAfter` 的 `parentId` 规则）。
 * `extras` 是导入读到的 front-matter（标签 id 与属性值由调用方按注册表解析好再传进来——
 * 领域层不认识「标签名」「属性名」这两件事）。`created` / `modified` 是**导出的时间戳回读**
 * （ 互通批：导出写了 `created` / `modified`，导入过去只跳过不还原，页面的创建时间
 * 静默变成"现在"）；只覆盖这两个字段，`position` 仍按追加位置算 ⇒ 页面库的排序不因导入旧笔记而跳动。
 */
export function insertOutlineAsPage(
  blocks: BlockMap,
  drafts: OutlineDraft[],
  pageName: string,
  extras: { tags?: string[]; properties?: Block['properties']; created?: number; modified?: number } = {},
  now = Date.now(),
  newId: () => string = () => crypto.randomUUID(),
): { transaction: Omit<Transaction, 'inverse'>; blockIds: string[]; pageId: string } | null {
  if (drafts.length === 0 && pageName.trim().length === 0) return null
  const pageId = newId()
  const page = createTextBlock({
    entityId: pageId,
    blockUid: newId(),
    text: pageName,
    isObject: true,
    objectName: pageName,
    now,
  })
  page.tags = [...(extras.tags ?? [])]
  page.properties = [...(extras.properties ?? [])]
  if (extras.created !== undefined) page.created = extras.created
  if (extras.modified !== undefined) page.modified = extras.modified

  const withPage: BlockMap = new Map(blocks)
  withPage.set(pageId, page)
  const inner = insertOutlineAfter(withPage, pageId, drafts, now, newId)
  const pageOperation: Operation = {
    type: 'insert',
    opId: newId(),
    block: page,
    parentId: null,
    index: orderedRootIds(blocks).length,
  }
  return {
    transaction: {
      id: crypto.randomUUID(),
      operations: [pageOperation, ...(inner?.transaction.operations ?? [])],
      timestamp: now,
      source: 'user',
    },
    blockIds: inner?.blockIds ?? [],
    pageId,
  }
}
