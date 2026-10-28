import { HISTORIC_TAG } from 'lexical'
import { $findBlockNode } from './blockNode'

type BlockMovePosition = 'before' | 'after' | 'into'

type EditorUpdateHandle = {
  update(updateFn: () => void, options?: { tag?: string | string[]; discrete?: boolean }): void
}

/**
 * 块组拖拽的 **Lexical 结构同步**（模块化 M2-2b）：领域事务已经落完，这里只把节点搬到
 * 与领域一致的位置。落点解析与 `store.moveBlocks` 留在 `ui/shellSupport.ts`（它是 UI 的
 * 落点规则），UI 不再直接 import `HISTORIC_TAG` / `$findBlockNode`。
 *
 * 保序：`into` = 依次 append；`before` = 逐个插在目标前（顺插即保序）；
 * `after` = 滚动锚点（每插一块后锚点移到刚插的那块，否则后插的会挤到前面）。
 */
export function syncBlockGroupMove(
  editor: EditorUpdateHandle,
  ids: string[],
  targetId: string,
  position: BlockMovePosition,
): void {
  editor.update(() => {
    const targetNode = $findBlockNode(targetId)
    if (!targetNode) return
    let anchor = targetNode
    for (const id of ids) {
      const node = $findBlockNode(id)
      if (!node || node === targetNode) continue
      if (position === 'into') targetNode.append(node)
      else if (position === 'before') targetNode.insertBefore(node)
      else { anchor.insertAfter(node); anchor = node }
    }
  }, { tag: [HISTORIC_TAG, 'moqi-move-group'], discrete: true })
}
