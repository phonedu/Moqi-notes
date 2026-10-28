/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { cloneBlock, cloneBlockMap, orderedRootIds, type Block, type BlockMap, type BlockRef } from './block'
import { addBlockRef, addObjectRef, rebuildReverseRefs, removeBlockRef, removeObjectRef } from './refs'
import { assertValidBlockGraph } from './validation'

export type Operation =
  | { type: 'insert'; opId: string; block: Block; parentId: string | null; index?: number }
  | { type: 'update'; opId: string; blockId: string; changes: Partial<Block>; previous: Partial<Block> }
  | { type: 'delete'; opId: string; blockId: string; descendantIds: string[]; snapshots: DeleteSnapshot[] }
  | { type: 'restore'; opId: string; blockId: string; snapshots: DeleteSnapshot[] }
  | { type: 'move'; opId: string; blockId: string; oldParentId: string | null; oldIndex: number; newParentId: string | null; newIndex: number }
  | { type: 'collapse'; opId: string; blockId: string; collapsed: boolean }
  | { type: 'block-ref'; opId: string; fromId: string; targetId: string; refType: BlockRef['type']; context?: string }
  | { type: 'block-unref'; opId: string; fromId: string; targetId: string; refType?: BlockRef['type'] }
  | { type: 'object-ref'; opId: string; fromId: string; targetId: string }
  | { type: 'object-unref'; opId: string; fromId: string; targetId: string }

export type DeleteSnapshot = { blockId: string; prevParent: string | null; prevIndex: number }
export type Transaction = { id: string; operations: Operation[]; inverse: Operation[]; timestamp: number; source: 'user' | 'ai' | 'sync' | 'migration' | 'system' }

/**
 * 一次交易里「需要重新落盘」的块：操作直接改动的块，**加上因它们而改变 `children` 的父块**。
 *
 * 落盘是按块增量写的（`ui/EditorShell` 的 `persist`）。漏一个父块，库里的 `children` 就少一条；
 * 下次载入时块图不自洽，之后**每一次**领域写入都会被校验拒绝——用户看到的是
 * 「缩进 / 反缩进 / 行尾 ＋ / 转类型全都没反应，字却还能敲」
 * （：行尾 ＋ 连续插入几个空块后，父块的 children 没跟着落盘，整篇变成只读）。
 * 所以「谁动了 children，谁就必须落盘」这条规则放在领域里，由 store 自动记账，
 * 写入点不需要各自记得补父块 id。
 */
export function touchedBlockIds(operations: Operation[]): string[] {
  const ids = new Set<string>()
  const add = (id: string | null | undefined): void => { if (id) ids.add(id) }
  for (const operation of operations) {
    switch (operation.type) {
      case 'insert':
        add(operation.block.entityId)
        add(operation.parentId)
        break
      case 'update':
        add(operation.blockId)
        // 直接改写 children / parent 的 update（批量同步）也要把新列表里的子块算进来
        if (Array.isArray(operation.changes.children)) for (const childId of operation.changes.children) add(childId)
        add(operation.changes.parent)
        break
      case 'delete':
        add(operation.blockId)
        for (const id of operation.descendantIds) add(id)
        for (const snapshot of operation.snapshots) add(snapshot.prevParent)
        break
      case 'restore':
        add(operation.blockId)
        for (const snapshot of operation.snapshots) {
          add(snapshot.blockId)
          add(snapshot.prevParent)
        }
        break
      case 'move':
        add(operation.blockId)
        add(operation.oldParentId)
        add(operation.newParentId)
        break
      case 'collapse':
        add(operation.blockId)
        break
      case 'block-ref':
      case 'block-unref':
      case 'object-ref':
      case 'object-unref':
        add(operation.fromId)
        add(operation.targetId)
        break
    }
  }
  return [...ids]
}

/**
 * `now` 是**事务自己的时间戳**，不是 `Date.now()`。
 *
 * 为什么这件事要紧（V2b 同机双实例验收逮到的）：`block.modified` / `deletedAt` 会被同步的
 * 冲突判定拿去和远端变更的 `created` 比大小（`03` §14.3）。若这里写 `Date.now()`（本机**应用**
 * 时刻），一条远端 `insert` 落下来时它的时间戳是「现在」，紧接着同一来源的 `update`（对端写字
 * 时刻，比本机应用时刻早一点）就会被判成「本机更新」而丢掉——表现是**页面同步过来了但内容是空的**。
 * 用事务时间戳，跨端比较才在同一个时钟域里（本地事务的 `timestamp` 本来就是 `Date.now()`）。
 */
export function applyOperation(blocks: BlockMap, operation: Operation, now: number): Operation {
  switch (operation.type) {
    case 'insert': return applyInsert(blocks, operation)
    case 'update': return applyUpdate(blocks, operation, now)
    case 'delete': return applyDelete(blocks, operation, now)
    case 'restore': return applyRestore(blocks, operation)
    case 'move': return applyMove(blocks, operation)
    case 'collapse': return applyCollapse(blocks, operation)
    case 'block-ref': addBlockRef(blocks, operation.fromId, operation.targetId, operation.refType, operation.context); return { type: 'block-unref', opId: inverseId(operation.opId), fromId: operation.fromId, targetId: operation.targetId, refType: operation.refType }
    case 'block-unref': removeBlockRef(blocks, operation.fromId, operation.targetId, operation.refType); return { type: 'block-ref', opId: inverseId(operation.opId), fromId: operation.fromId, targetId: operation.targetId, refType: operation.refType ?? 'link' }
    case 'object-ref': addObjectRef(blocks, operation.fromId, operation.targetId); return { type: 'object-unref', opId: inverseId(operation.opId), fromId: operation.fromId, targetId: operation.targetId }
    case 'object-unref': removeObjectRef(blocks, operation.fromId, operation.targetId); return { type: 'object-ref', opId: inverseId(operation.opId), fromId: operation.fromId, targetId: operation.targetId }
  }
}

export function applyTransaction(blocks: BlockMap, transaction: Transaction): Transaction {
  const working = cloneBlockMap(blocks)
  const inverse: Operation[] = []
  for (const operation of transaction.operations) inverse.unshift(applyOperation(working, operation, transaction.timestamp))
  // 页面名 = 首行（docs/04 §3）：**任何**写入都可能在改首行（包括 insert 新页面、restore 恢复、update 内容），
  // 所以在提交前的唯一出口统一重算，不依赖各条操作自己记得做。
  normalizeObjectNames(working)
  assertValidBlockGraph(working)
  blocks.clear()
  for (const [id, block] of working) blocks.set(id, block)
  return { ...transaction, inverse }
}

function applyInsert(blocks: BlockMap, operation: Extract<Operation, { type: 'insert' }>): Operation {
  const existing = blocks.get(operation.block.entityId)
  if (existing && !existing.deleted) throw new Error(`entityId 已存在: ${operation.block.entityId}`)
  if ([...blocks.values()].some((block) => block.entityId !== operation.block.entityId && block.blockUid === operation.block.blockUid)) throw new Error(`blockUid 已存在: ${operation.block.blockUid}`)
  if (existing?.deleted) blocks.delete(operation.block.entityId)
  const block = cloneBlock(operation.block)
  block.parent = operation.parentId
  blocks.set(block.entityId, block)
  if (operation.parentId !== null) {
    const parent = mustGet(blocks, operation.parentId)
    parent.children.splice(operation.index ?? parent.children.length, 0, block.entityId)
  } else {
    reorderRoots(blocks, block.entityId, operation.index ?? Number.MAX_SAFE_INTEGER)
  }
  normalizePositions(blocks, operation.parentId)
  return { type: 'delete', opId: inverseId(operation.opId), blockId: block.entityId, descendantIds: [], snapshots: [{ blockId: block.entityId, prevParent: block.parent, prevIndex: operation.index ?? 0 }] }
}

function applyUpdate(blocks: BlockMap, operation: Extract<Operation, { type: 'update' }>, now: number): Operation {
  const block = mustGet(blocks, operation.blockId)
  const previous: Partial<Block> = {}
  for (const [key, value] of Object.entries(operation.changes) as [keyof Block, Block[keyof Block]][]) {
    previous[key] = structuredClone(block[key]) as never
    block[key] = structuredClone(value) as never
  }
  block.modified = now
  return { type: 'update', opId: inverseId(operation.opId), blockId: operation.blockId, changes: previous, previous: operation.changes }
}

/**
 * 页面名的推导规则（docs/04 §3「页面名 = 正文首行」）：取对象块自己内容的纯文本、去首尾空白，
 * 空则回落「未命名页面」。它是**只读索引**（页面库 / 侧栏 / 回收站 / `[[` 候选读取），
 * 不再有独立标题控件写入，也**不做唯一化**——同名是合法的，链接靠 `targetId` 指向，不靠名字。
 */
/** 把块图里所有对象块的 objectName 重算到「首行派生」的现状（原地改 working 副本，供 applyTransaction 调用）。 */
export function normalizeObjectNames(blocks: BlockMap): void {
  for (const block of blocks.values()) {
    if (!block.isObject) continue
    const next = derivedObjectName(block)
    if (block.objectName !== next) block.objectName = next
  }
}

export function derivedObjectName(block: Block): string {
  const own = block.content.map((fragment) => fragment.v).join('').trim()
  return own.length > 0 ? own : '未命名页面'
}

function applyDelete(blocks: BlockMap, operation: Extract<Operation, { type: 'delete' }>, now: number): Operation {
  const ids = [operation.blockId, ...operation.descendantIds]
  const snapshots = operation.snapshots.length ? operation.snapshots : ids.map((id) => {
    const block = mustGet(blocks, id)
    return { blockId: id, prevParent: block.parent, prevIndex: block.parent ? mustGet(blocks, block.parent).children.indexOf(id) : 0 }
  })
  const root = mustGet(blocks, operation.blockId)
  const deletedParentId = root.parent
  if (root.parent) mustGet(blocks, root.parent).children = mustGet(blocks, root.parent).children.filter((id) => id !== root.entityId)
  for (const id of ids) {
    const block = mustGet(blocks, id)
    const snapshot = snapshots.find((item) => item.blockId === id)
    block.deleted = true
    block.deletedAt = now
    block.prevParent = snapshot?.prevParent ?? null
    block.prevIndex = snapshot?.prevIndex ?? 0
  }
  normalizePositions(blocks, deletedParentId)
  rebuildReverseRefs(blocks)
  return { type: 'restore', opId: inverseId(operation.opId), blockId: operation.blockId, snapshots }
}

function applyRestore(blocks: BlockMap, operation: Extract<Operation, { type: 'restore' }>): Operation {
  const root = mustGet(blocks, operation.blockId)
  for (const snapshot of operation.snapshots) {
    const block = mustGet(blocks, snapshot.blockId)
    block.deleted = false
    block.deletedAt = null
  }
  const parentId = root.prevParent && blocks.get(root.prevParent)?.deleted === false ? root.prevParent : null
  root.parent = parentId
  if (parentId) mustGet(blocks, parentId).children.splice(Math.min(root.prevIndex ?? 0, mustGet(blocks, parentId).children.length), 0, root.entityId)
  else reorderRoots(blocks, root.entityId, root.prevIndex ?? Number.MAX_SAFE_INTEGER)
  normalizePositions(blocks, parentId)
  rebuildReverseRefs(blocks)
  return { type: 'delete', opId: inverseId(operation.opId), blockId: operation.blockId, descendantIds: operation.snapshots.filter((item) => item.blockId !== operation.blockId).map((item) => item.blockId), snapshots: operation.snapshots }
}

function applyMove(blocks: BlockMap, operation: Extract<Operation, { type: 'move' }>): Operation {
  const block = mustGet(blocks, operation.blockId)
  if (operation.newParentId === operation.blockId) throw new Error('不能移动到自身')
  if (operation.newParentId && isDescendant(blocks, operation.newParentId, operation.blockId)) throw new Error('不能移动到自身后代')
  const effectiveNewIndex = operation.oldParentId === operation.newParentId && operation.oldIndex < operation.newIndex
    ? operation.newIndex - 1
    : operation.newIndex
  const previousParentId = block.parent
  if (block.parent) {
    const oldParent = mustGet(blocks, block.parent)
    oldParent.children = oldParent.children.filter((id) => id !== block.entityId)
  }
  block.parent = operation.newParentId
  if (operation.newParentId) mustGet(blocks, operation.newParentId).children.splice(effectiveNewIndex, 0, block.entityId)
  else reorderRoots(blocks, block.entityId, effectiveNewIndex)
  normalizePositions(blocks, previousParentId)
  normalizePositions(blocks, operation.newParentId)
  // 逆操作也遵守同一条索引约定（`newIndex` 是「块仍在原位」那份列表里的空位），所以同父往回插时：
  // 目标是比现在（effectiveNewIndex，块此刻占的那一格）更靠后的原索引，就要 +1 让开自己。少了这一步，
 // 「上移一步」的撤销原地不动（⌘⇧↑ → ⌘Z 不还原）、根级上移的撤销少走一格（ 实测，
  // tests/domain.test.ts 的 BLOCK-DRAG-3 覆盖）。跨父级不适用：目标父级里没有块自己那一格。
  const inverseIndex = operation.oldParentId === operation.newParentId && operation.oldIndex > effectiveNewIndex
    ? operation.oldIndex + 1
    : operation.oldIndex
  return { type: 'move', opId: inverseId(operation.opId), blockId: operation.blockId, oldParentId: operation.newParentId, oldIndex: effectiveNewIndex, newParentId: operation.oldParentId, newIndex: inverseIndex }
}

function applyCollapse(blocks: BlockMap, operation: Extract<Operation, { type: 'collapse' }>): Operation {
  const block = mustGet(blocks, operation.blockId)
  const previous = block.collapsed
  block.collapsed = operation.collapsed
  return { type: 'collapse', opId: inverseId(operation.opId), blockId: operation.blockId, collapsed: previous }
}

/** Roots have no `children` container, so their explicit order lives in `position`. */
function reorderRoots(blocks: BlockMap, movedId: string, index: number): void {
  const moved = blocks.get(movedId)
  if (!moved) return
  const roots = orderedRootIds(blocks)
    .filter((id) => id !== movedId)
    .map((id) => blocks.get(id)!)
  const at = Math.min(Math.max(index, 0), roots.length)
  roots.splice(at, 0, moved)
  roots.forEach((block, position) => { block.position = position })
}

function normalizePositions(blocks: BlockMap, parentId: string | null): void {
  if (parentId === null) {
    orderedRootIds(blocks).forEach((id, position) => { blocks.get(id)!.position = position })
    return
  }
  const parent = blocks.get(parentId)
  if (!parent) return
  parent.children.forEach((id, position) => {
    const child = blocks.get(id)
    if (child) child.position = position
  })
}

function mustGet(blocks: BlockMap, id: string): Block { const block = blocks.get(id); if (!block) throw new Error(`Block 不存在: ${id}`); return block }
function isDescendant(blocks: BlockMap, candidateId: string, ancestorId: string): boolean { let cursor = blocks.get(candidateId)?.parent ?? null; while (cursor) { if (cursor === ancestorId) return true; cursor = blocks.get(cursor)?.parent ?? null } return false }
function inverseId(opId: string): string { return `${opId}:inverse` }
