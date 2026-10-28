import type { BlockMap } from '../domain/block'

/** 拖拽落点相对目标块的位置（docs/09 §6.2）。 */
export type DropPosition = 'before' | 'after' | 'into'

export type DropDestination = { parentId: string | null; index: number }

/**
 * 拖拽落点的唯一规则（docs/04 §3）：把「拖到某个块的哪个位置」解析成领域的 `(parentId, index)`。
 * 返回 null 表示**无效落点**：调用方不改数据、不产生 transaction。
 *
 * - 拖到自身或自身的后代里会形成环 → 无效。
 * - **根块只接受 `into`**：根块在本篇里就是页面对象块（页面容器，docs/09 §409），
 *   「落在根块之前 / 之后」没有可表达的位置——领域里那会生成一个新的根块，等于把正文块
 *   移出本篇（编辑器里掉到页面末尾，刷新后整块从页面与页面库消失）。所以根块的前后一律按无效落点处理。
 */
export function resolveDropDestination(
  blocks: BlockMap,
  dragId: string,
  targetId: string,
  position: DropPosition,
): DropDestination | null {
  const dragged = blocks.get(dragId)
  const target = blocks.get(targetId)
  if (!dragged || !target || dragged.deleted || target.deleted) return null
  if (dragId === targetId) return null
  let cursor: string | null = targetId
  while (cursor) {
    if (cursor === dragId) return null
    cursor = blocks.get(cursor)?.parent ?? null
  }
  if (position === 'into') {
    return { parentId: targetId, index: target.children.filter((id) => id !== dragId).length }
  }
  if (target.parent === null) return null
  const siblings = blocks.get(target.parent)?.children
  if (!siblings) return null
  const at = siblings.indexOf(targetId)
  if (at < 0) return null
  return { parentId: target.parent, index: position === 'after' ? at + 1 : at }
}
