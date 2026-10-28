import { danglingRefCount } from '@moqi/editor'
import type { Block, BlockMap } from '@moqi/editor'

/** 块删除的确认判据：单块且无子块直接删；多块或带子块先弹确认。 */
export type BlockDeletePlan = {
  count: number
  refs: number
  hasChildren: boolean
  needsConfirm: boolean
}

export function planBlockDelete(
  ids: string[],
  get: (id: string) => Block | undefined,
  snapshot: BlockMap,
): BlockDeletePlan {
  const count = ids.length
  const hasChildren = ids.some((id) => (get(id)?.children.length ?? 0) > 0)
  return {
    count,
    refs: count > 0 ? danglingRefCount(snapshot, ids) : 0,
    hasChildren,
    needsConfirm: count > 1 || hasChildren,
  }
}
