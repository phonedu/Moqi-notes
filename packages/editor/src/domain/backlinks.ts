/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { textContent, type Block, type BlockMap, type RefKind } from './block'

export type BacklinkEntry = {
  sourceId: string
  kind: RefKind
  preview: string
}

const PREVIEW_LIMIT = 60

/** Short read-time label for a Block; renames never touch the stored ref target. */
export function summarizeBlock(block: Block): string {
  const text = textContent(block).replace(/\s+/g, ' ').trim()
  if (text.length > 0) return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text
  if (block.isObject && block.objectName) return block.objectName
  return '（空段落）'
}

/**
 * 被删的这棵子树，在**当前活跃块图**里被引用了多少个**引用点**
 * （`09-桌面端交互规范` §6.13 `R09-DANGLE-1`：删完给一条 toast「已删除 · N 处引用」）。
 *
 * 口径与 `collectBacklinks` 同一组「什么算引用」，计数按**引用点**（不是来源块）：
 * 一个活跃、且自己不在被删集合里的块，指向被删集合的 `objectRefs` 元素与 `blockRefs`
 * 元素各算一个点（inline-ref 片段不另计——同 `05` 的「链」计数口径）。
 * 悬空本身**合法**（`R04-WRITE-1`），这里只负责把「你可能刚弄断了几条链」如实说出来。
 */
export function danglingRefCount(blocks: BlockMap, removedIds: Iterable<string>): number {
  const removed = new Set(removedIds)
  let count = 0
  for (const source of blocks.values()) {
    if (source.deleted || removed.has(source.entityId)) continue
    count += source.objectRefs.filter((id) => removed.has(id)).length
    count += source.blockRefs.filter((ref) => removed.has(ref.targetBlockId)).length
  }
  return count
}

/**
 * 全库**一次扫描**的「来源块计数」：与 `collectBacklinks(blocks, id, options).length` 逐条同义
 * （来源去重、排除自指、默认略过已删来源）。页面库每张卡都要一个反链数——逐卡调
 * `collectBacklinks` 是「页数 × 全库」的扫描（200 页 × 5000 块 / 每次变动，性能批 ⓒ ②）。
 */
export function backlinkSourceCounts(blocks: BlockMap, options: { includeDeleted?: boolean } = {}): Map<string, number> {
  const includeDeleted = options.includeDeleted ?? false
  const counts = new Map<string, number>()
  for (const source of blocks.values()) {
    if (!includeDeleted && source.deleted) continue
    const targets = new Set<string>()
    for (const ref of source.blockRefs) targets.add(ref.targetBlockId)
    for (const id of source.objectRefs) targets.add(id)
    targets.delete(source.entityId)
    for (const id of targets) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return counts
}

/**
 * T14: reverse-link sources for a target Block. Derived from forward refs so the
 * soft-delete filter stays correct even though deleting a source prunes its
 * entries from the target's backRefs. Deleted sources are hidden by default;
 * `includeDeleted` scans them explicitly.
 */
export function collectBacklinks(blocks: BlockMap, targetId: string, options: { includeDeleted?: boolean } = {}): BacklinkEntry[] {
  if (!blocks.has(targetId)) return []
  const includeDeleted = options.includeDeleted ?? false
  const entries: BacklinkEntry[] = []
  for (const source of blocks.values()) {
    if (source.entityId === targetId) continue
    if (!includeDeleted && source.deleted) continue
    const kind: RefKind | null = source.blockRefs.some((ref) => ref.targetBlockId === targetId)
      ? 'block'
      : source.objectRefs.includes(targetId)
        ? 'object'
        : null
    if (!kind) continue
    entries.push({ sourceId: source.entityId, kind, preview: summarizeBlock(source) })
  }
  entries.sort((left, right) => {
    const createdLeft = blocks.get(left.sourceId)?.created ?? 0
    const createdRight = blocks.get(right.sourceId)?.created ?? 0
    return createdLeft - createdRight || left.sourceId.localeCompare(right.sourceId)
  })
  return entries
}
