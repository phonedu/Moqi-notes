import { useEffect, useMemo, useState } from 'react'
import { TRASH_RETENTION_DAYS, expiredTrashIds, type Block } from '@moqi/editor'
import { purgeSubtreeIds } from '@moqi/editor'
import { adoptDividerBodies, adoptObjectNames, adoptOrphanedChildren, dropDanglingChildren } from '@moqi/editor'
import { createDefaultStoragePort, type TransactionStoragePort } from '../composition'
import { useEditorRuntime } from './useEditorRuntime'
import { EditorChrome } from './EditorChrome'
import { LoadErrorScreen } from './LoadErrorScreen'
import { loadInitialBlocks } from './shellSupport'
import './app.css'
// 设置壳（左分栏 ＋ 右栏表单）单独一份样式；**从外壳导入**（与 `app.css` 同一处）是因为
// `SettingsView` 会被单测当值 import——组件模块里带 CSS 导入会让 node 报未知扩展名。
import './settings.css'


export function EditorShell() {
  const storage = useMemo(() => createDefaultStoragePort(), [])
  const [initialBlocks, setInitialBlocks] = useState<Block[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [repairNotice, setRepairNotice] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void storage.loadBlocks()
      .then(async (blocks) => {
        if (!active) return
        if (blocks.length > 0) {
          // 载入自愈三道：清掉指向不存在块的 children 引用（保存中断会留下这种断链）；
          // 把「parent 指着父块却不在父块 children 里」的块收回去（会让之后每一次领域写入
          // 都被校验拒绝，表现是「缩进 / 反缩进 / ＋ / 转类型全失效、字却还能敲」）；
          // （页面名允许重复：链接靠 targetId 指向，见 docs/04 §3。）
          const repaired = dropDanglingChildren(blocks)
          const adopted = adoptOrphanedChildren(repaired.blocks)
          // 第四道：老数据里由标题控件写下的页面名落到正文首行（否则名字会看着丢）
          const named = adoptObjectNames(adopted.blocks)
          // 第六道：分隔线不承载正文——线上那份挪到紧随其后的新块（`02` §「类型转换」）。
     // 老数据的来历：转换路径曾经只改当前节点、镜像又把正文写回线上（ 用户实测）。
          const splitDividers = adoptDividerBodies(named.blocks)
          const notices: string[] = []
          if (repaired.removed > 0) notices.push(`已修复 ${repaired.removed} 处失效的层级引用（${repaired.repairedBlockIds.length} 个块）`)
          if (adopted.adopted > 0) notices.push(`已修复 ${adopted.adopted} 处层级记录（${adopted.adoptedBlockIds.length} 个块重新挂回父级）`)
          if (adopted.rootedBlockIds.length > 0) notices.push(`有 ${adopted.rootedBlockIds.length} 个块找不到父级，已降级为根块`)
          if (splitDividers.adopted.length > 0) notices.push(`已把 ${splitDividers.adopted.length} 处分隔线上的正文移到它下面的新块`)

          // V2b 第五道：回收站保留期到期 → 自动从本机彻底删除（`09-桌面端UI规范` `R09-TRASH-3`）。
          // **顺序要紧**：必须在下面的 `saveBlocks` 之前摘掉，否则会把刚删的块又写回库里。
          // 要删的是整棵子树——过期条目可能带子块，只摘根会留下指向不存在父块的子块。
          const expired = expiredTrashIds(splitDividers.blocks)
          let kept = splitDividers.blocks
          if (expired.length > 0) {
            // 与手动彻底删除同一条收集规则：按 parent 链，包含更早软删除的子块（D-091）。
            const doomed = new Set(purgeSubtreeIds(splitDividers.blocks, expired))
            kept = splitDividers.blocks.filter((block) => !doomed.has(block.entityId))
            await storage.purgeBlocks([...doomed])
            notices.push(`回收站里有 ${expired.length} 个页面超过 ${TRASH_RETENTION_DAYS} 天保留期，已自动从本机彻底删除`)
          }
          if (notices.length > 0) {
            await storage.saveBlocks(kept)
            setRepairNotice(notices.join('；'))
          }
          setInitialBlocks(kept)
          return
        }
        const seed = loadInitialBlocks()
        await storage.saveBlocks(seed)
        if (active) setInitialBlocks(seed)
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : String(error))
      })
    return () => { active = false }
  }, [storage])

  if (loadError) return <LoadErrorScreen message={loadError} />
  if (!initialBlocks) return <main className="editor-loading">正在打开墨契…</main>
  return <EditorApp initialBlocks={initialBlocks} storage={storage} repairNotice={repairNotice} />
}

/** V2b：保存态文案。它现在住编辑器顶栏（跟着页面走），不再住侧栏底部（那里归同步）。 */

// MenuState / DialogState 搬到了 `ui/useOverlays.ts`（浮层栈的单所有者），这里只读它的状态。
// 提示带（θ10 · `R09-STATE-1b`）的状态 / 发号 / 计时搬到了 `ui/useNotice.tsx`，这里只调 `notify`。
function EditorApp({ initialBlocks, storage, repairNotice }: { initialBlocks: Block[]; storage: TransactionStoragePort; repairNotice?: string | null }) {
  const runtime = useEditorRuntime(initialBlocks, storage, repairNotice)
  return <EditorChrome runtime={runtime} />
}


