/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Block, BlockMap, BlockRef } from './block'

export function rebuildReverseRefs(blocks: BlockMap): void {
  for (const block of blocks.values()) {
    block.blockBackRefs = []
    block.objectBackRefs = []
  }
  for (const block of blocks.values()) {
    if (block.deleted) continue
    for (const ref of block.blockRefs) {
      const target = blocks.get(ref.targetBlockId)
      if (target && !target.deleted && !target.blockBackRefs.some((item) => item.fromBlockId === block.entityId && item.type === ref.type)) {
        target.blockBackRefs.push({ ...ref, fromBlockId: block.entityId })
      }
    }
    for (const targetId of block.objectRefs) {
      const target = blocks.get(targetId)
      if (target && !target.deleted && !target.objectBackRefs.includes(block.entityId)) target.objectBackRefs.push(block.entityId)
    }
  }
}

export function validateReverseRefs(blocks: BlockMap): string[] {
  const expected = new Map<string, { block: BlockRef[]; object: string[] }>()
  for (const block of blocks.values()) expected.set(block.entityId, { block: [], object: [] })
  for (const source of blocks.values()) {
    if (source.deleted) continue
    for (const ref of source.blockRefs) {
      const target = blocks.get(ref.targetBlockId)
      if (target && !target.deleted) expected.get(target.entityId)!.block.push({ ...ref, fromBlockId: source.entityId })
    }
    for (const targetId of source.objectRefs) {
      const target = blocks.get(targetId)
      if (target && !target.deleted) expected.get(target.entityId)!.object.push(source.entityId)
    }
  }
  const issues: string[] = []
  for (const block of blocks.values()) {
    const item = expected.get(block.entityId)!
    const actualBlock = [...block.blockBackRefs].sort(refOrder)
    const expectedBlock = [...item.block].sort(refOrder)
    const actualObject = [...block.objectBackRefs].sort()
    const expectedObject = [...item.object].sort()
    if (JSON.stringify(actualBlock) !== JSON.stringify(expectedBlock)) issues.push(`blockBackRefs 不一致: ${block.entityId}`)
    if (JSON.stringify(actualObject) !== JSON.stringify(expectedObject)) issues.push(`objectBackRefs 不一致: ${block.entityId}`)
  }
  return issues
}

export function addBlockRef(blocks: BlockMap, fromId: string, targetId: string, type: BlockRef['type'], context?: string): void {
  const from = mustGet(blocks, fromId)
  const target = mustGet(blocks, targetId)
  if (from.deleted || target.deleted) throw new Error('已删除 Block 不能建立引用')
  if (!from.blockRefs.some((ref) => ref.targetBlockId === targetId && ref.type === type)) {
    from.blockRefs.push({ fromBlockId: fromId, targetBlockId: targetId, type, context })
    if (!target.blockBackRefs.some((ref) => ref.fromBlockId === fromId && ref.targetBlockId === targetId && ref.type === type)) {
      target.blockBackRefs.push({ fromBlockId: fromId, targetBlockId: targetId, type, context })
    }
  }
}

export function removeBlockRef(blocks: BlockMap, fromId: string, targetId: string, type?: BlockRef['type']): void {
  const from = mustGet(blocks, fromId)
  from.blockRefs = from.blockRefs.filter((ref) => !(ref.targetBlockId === targetId && (!type || ref.type === type)))
  const target = blocks.get(targetId)
  if (target) target.blockBackRefs = target.blockBackRefs.filter((ref) => !(ref.fromBlockId === fromId && (!type || ref.type === type)))
}

export function addObjectRef(blocks: BlockMap, fromId: string, targetId: string): void {
  const from = mustGet(blocks, fromId)
  const target = mustGet(blocks, targetId)
  if (from.deleted || target.deleted) throw new Error('已删除 Block 不能建立引用')
  if (!from.objectRefs.includes(targetId)) {
    from.objectRefs.push(targetId)
    if (!target.objectBackRefs.includes(fromId)) target.objectBackRefs.push(fromId)
  }
}

export function removeObjectRef(blocks: BlockMap, fromId: string, targetId: string): void {
  const from = mustGet(blocks, fromId)
  from.objectRefs = from.objectRefs.filter((id) => id !== targetId)
  const target = blocks.get(targetId)
  if (target) target.objectBackRefs = target.objectBackRefs.filter((id) => id !== fromId)
}

function refOrder(left: BlockRef, right: BlockRef): number {
  return `${left.fromBlockId}:${left.targetBlockId}:${left.type}`.localeCompare(`${right.fromBlockId}:${right.targetBlockId}:${right.type}`)
}

function mustGet(blocks: BlockMap, id: string): Block {
  const block = blocks.get(id)
  if (!block) throw new Error(`Block 不存在: ${id}`)
  return block
}
