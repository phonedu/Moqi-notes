/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { orderedRootIds, type Block, type BlockMap } from './block'
import type { DeleteSnapshot, Operation, Transaction } from './operation'

/**
 * T16 (spec §4.5/§8.2): multi-select operations always work on a
 * parent-deduplicated set. A selected Block and any selected descendant
 * collapse to the parent so a subtree is copied or deleted exactly once.
 */
export function dedupeSelection(blocks: BlockMap, blockIds: Iterable<string>): string[] {
  const selected = new Set<string>()
  for (const id of blockIds) {
    const block = blocks.get(id)
    if (block && !block.deleted) selected.add(id)
  }
  if (selected.size === 0) return []
  const ordered: string[] = []
  const visit = (id: string): void => {
    if (selected.has(id)) {
      ordered.push(id)
      return
    }
    const block = blocks.get(id)
    if (!block) return
    for (const childId of block.children) visit(childId)
  }
  for (const rootId of orderedRootIds(blocks)) visit(rootId)
  return ordered
}

export function collectSubtree(blocks: BlockMap, rootId: string): string[] {
  const result: string[] = []
  const visit = (id: string): void => {
    const block = blocks.get(id)
    if (!block) return
    result.push(id)
    for (const childId of block.children) visit(childId)
  }
  visit(rootId)
  return result
}

export type CopyResult = { transaction: Omit<Transaction, 'inverse'>; rootIds: string[] }
export type DeleteResult = { transaction: Omit<Transaction, 'inverse'>; rootIds: string[] }

/**
 * T16: copying rebuilds identity. Every node in a copied subtree gets a fresh
 * `entityId` and `blockUid`; `content`, `tags` and `properties` travel with the
 * copy while forward refs are re-registered so targets gain the new source in
 * their backRefs. Copy roots land right after their source subtree, in the same
 * parent, preserving selection order.
 *
 * T20 ruling: block-level `((…))` references pointing inside the copied set
 * are remapped to the copies, so the duplicate stays self-contained; refs
 * targeting blocks outside the copied set keep pointing at the originals.
 * `aiMeta` travels with the copy unchanged (provenance is part of the text).
 */
export function copyBlocks(
  blocks: BlockMap,
  blockIds: Iterable<string>,
  options: { now?: number; newId?: () => string } = {},
): CopyResult | null {
  const now = options.now ?? Date.now()
  const newId = options.newId ?? (() => crypto.randomUUID())
  const roots = dedupeSelection(blocks, blockIds)
  if (roots.length === 0) return null

  const inserts: Operation[] = []
  const refs: Operation[] = []
  const rootIds: string[] = []
  const insertedPerParent = new Map<string | null, number>()
  // One map across all copied subtrees so cross-subtree internal refs remap too.
  const idMap = new Map<string, string>()

  for (const sourceRootId of roots) {
    const sourceRoot = blocks.get(sourceRootId)!
    const subtree = collectSubtree(blocks, sourceRootId)
    for (const oldId of subtree) idMap.set(oldId, newId())
    rootIds.push(idMap.get(sourceRootId)!)

    const parentKey = sourceRoot.parent
    const baseIndex = parentKey === null
      ? orderedRootIds(blocks).indexOf(sourceRootId)
      : blocks.get(parentKey)!.children.indexOf(sourceRootId)
    const insertIndex = baseIndex + 1 + (insertedPerParent.get(parentKey) ?? 0)
    insertedPerParent.set(parentKey, (insertedPerParent.get(parentKey) ?? 0) + 1)

    for (const oldId of subtree) {
      const source = blocks.get(oldId)!
      const isRoot = oldId === sourceRootId
      const parentId = isRoot ? source.parent : idMap.get(source.parent!)!
      const index = isRoot ? insertIndex : blocks.get(source.parent!)!.children.indexOf(oldId)
      inserts.push({ type: 'insert', opId: newId(), block: cloneForCopy(source, idMap.get(oldId)!, parentId, newId, now, idMap), parentId, index })
    }

    for (const oldId of subtree) {
      const source = blocks.get(oldId)!
      const fromId = idMap.get(oldId)!
      for (const ref of source.blockRefs) {
        // Internal targets always exist after the inserts above; only external
        // targets need the liveness check against the pre-copy tree.
        const internalTarget = idMap.get(ref.targetBlockId)
        if (!internalTarget && !isActiveTarget(blocks, ref.targetBlockId)) continue
        refs.push({ type: 'block-ref', opId: newId(), fromId, targetId: internalTarget ?? ref.targetBlockId, refType: ref.type, context: ref.context })
      }
      for (const targetId of source.objectRefs) {
        const internalTarget = idMap.get(targetId)
        if (!internalTarget && !isActiveTarget(blocks, targetId)) continue
        refs.push({ type: 'object-ref', opId: newId(), fromId, targetId: internalTarget ?? targetId })
      }
    }
  }

  return { transaction: { id: crypto.randomUUID(), operations: [...inserts, ...refs], timestamp: now, source: 'user' }, rootIds }
}

/**
 * T16: a batch delete is one transaction, one `delete` per deduplicated root,
 * so the whole selection undoes together. Snapshots are captured from the
 * pre-delete tree so restore can rebuild the original parent and index.
 */
export function deleteBlocks(blocks: BlockMap, blockIds: Iterable<string>, options: { now?: number } = {}): DeleteResult | null {
  const roots = dedupeSelection(blocks, blockIds)
  if (roots.length === 0) return null
  // 同级的多个根**从后往前**记录：撤销是一次反序回放（`applyTransaction` 把 `inverse` 反着排），
  // 反序插回时才是升序，落回原位（`applyRestore` 只按 `prevIndex` 往 `children` 里 splice）。
  // 正序记录的话，删掉「甲、乙」再 ⌘Z 会得到「甲、丙、乙」（2026-10-05 实测，块选中态 ⌫ 删两块）。
  // 跨父级的先后不影响结果——各自插回各自的父级；同索引不同父级时按输入顺序（sort 稳定）。
  const inTreeOrder = [...roots].sort((left, right) => prevIndexOf(blocks, right) - prevIndexOf(blocks, left))
  const operations: Operation[] = inTreeOrder.map((rootId) => {
    const subtree = collectSubtree(blocks, rootId)
    const snapshots: DeleteSnapshot[] = subtree.map((id) => ({
      blockId: id,
      prevParent: blocks.get(id)!.parent,
      prevIndex: prevIndexOf(blocks, id),
    }))
    return { type: 'delete', opId: crypto.randomUUID(), blockId: rootId, descendantIds: subtree.slice(1), snapshots }
  })
  return { transaction: { id: crypto.randomUUID(), operations, timestamp: options.now ?? Date.now(), source: 'user' }, rootIds: roots }
}

/** 块在父级里的位置（根级用显式顺序 `position`，与 `applyDelete` / `applyRestore` 同一口径）。 */
function prevIndexOf(blocks: BlockMap, id: string): number {
  const block = blocks.get(id)
  if (!block) return 0
  return block.parent === null ? orderedRootIds(blocks).indexOf(id) : blocks.get(block.parent)?.children.indexOf(id) ?? 0
}

function cloneForCopy(source: Block, entityId: string, parent: string | null, newId: () => string, now: number, idMap: Map<string, string>): Block {
  const block = structuredClone(source)
  block.entityId = entityId
  block.blockUid = newId()
  block.parent = parent
  block.children = []
  block.position = 0
  block.deleted = false
  block.deletedAt = null
  block.prevParent = null
  block.prevIndex = null
  // V2b: a copy is a new page. It inherits neither `pinned` (that would silently
  // consume one of the 5 slots) nor `starred` (the star means "I marked *that* page").
  // Non-page copies have `parent !== null` and must stay false anyway — see the
  // shape codes `pinned-must-be-false-on-non-object` / `starred-must-be-false-on-non-object`.
  block.pinned = false
  block.starred = false
  // T20: inline `((…))` bindings pointing inside the copied set now jump to the
  // copy; external bindings keep the original target. `aiMeta` stays as-is.
  block.content = block.content.map((fragment) => {
    if (fragment.t !== 'inline-ref' || !fragment.ref) return fragment
    const remapped = idMap.get(fragment.ref.targetId)
    return remapped ? { ...fragment, ref: { ...fragment.ref, targetId: remapped } } : fragment
  })
  // Forward refs are cleared here and re-registered as operations so targets'
  // backRefs stay in sync; copied siblings never inherit stale reverse links.
  block.blockRefs = []
  block.blockBackRefs = []
  block.objectRefs = []
  block.objectBackRefs = []
  block.created = now
  block.modified = now
  return block
}

function isActiveTarget(blocks: BlockMap, targetId: string): boolean {
  const target = blocks.get(targetId)
  return Boolean(target) && !target!.deleted
}
