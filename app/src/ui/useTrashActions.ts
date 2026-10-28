import type { BlockMap } from '@moqi/editor'
import type { AssetPort } from '../application/assets'
import type { DomainStore } from '../application/store'
import type { TransactionStoragePort } from '../composition'
import { runPurge } from './purgeFlow'
import { restorePageWithLegacyName } from './shellSupport'
import type { DialogState } from './useOverlays'
import type { SaveState, ViewKind } from './types'

type TrashActionsOptions = {
  store: DomainStore
  snapshot: BlockMap
  activePageId: string | null
  storage: TransactionStoragePort
  assetPort: AssetPort
  flushPendingPersist: () => Promise<void>
  reloadFromStore: (pageId?: string | null, persistAll?: boolean) => void
  setAssetNames: (names: Set<string>) => void
  setSaveState: (state: SaveState) => void
  setActivePageId: (id: string | null) => void
  setView: (view: ViewKind) => void
  setRefPanelOpen: (open: boolean) => void
  setRevision: (update: (value: number) => number) => void
  openDialog: (dialog: DialogState) => void
  notify: (message: string) => void
  persist: (ids: Iterable<string>) => void
}

/**
 * 回收站动作（模块化 M1.2a）：从 `EditorShell` 抽出的领域写入口。
 *
 * 只做「打开确认 / 恢复 / 移入回收站 / 彻底删除」；视图渲染在 `TrashHost`，
 * 弹窗渲染仍由外壳的 `dialog` 栈负责（两个确认框共用同一套状态）。
 */
export function useTrashActions(options: TrashActionsOptions) {
  const {
    store, snapshot, activePageId, storage, assetPort, flushPendingPersist, reloadFromStore,
    setAssetNames, setSaveState, setActivePageId, setView, setRefPanelOpen, setRevision,
    openDialog, notify, persist,
  } = options

  /**
   * 弹出「从本机彻底删除」的确认（`R09-TRASH-6`）。先算出哪些页面将失去指向本页的双链。
   */
  function openPurgeDialog(pageIds: string[]) {
    const purged = new Set(pageIds)
    const loserIds = new Set<string>()
    for (const pageId of pageIds) {
      for (const entry of store.backlinks(pageId, true)) {
        let cursor: string | null = entry.sourceId
        while (cursor) {
          const block = snapshot.get(cursor)
          if (!block) break
          if (block.isObject) {
            if (!purged.has(cursor)) loserIds.add(cursor)
            break
          }
          cursor = block.parent
        }
      }
    }
    openDialog({
      kind: 'purgePages',
      pageIds,
      names: pageIds.map((id) => snapshot.get(id)?.objectName ?? '未命名页面'),
      losers: [...loserIds].map((id) => snapshot.get(id)?.objectName ?? '未命名页面'),
    })
  }

  function purgePages(pageIds: string[]) {
    void runPurge(pageIds, {
      store, storage, assetPort, flushPendingPersist, reloadFromStore, setAssetNames, setSaveState, notify,
      getActivePageId: () => activePageId,
      setActivePageId,
      setView: (next) => setView(next),
      refresh: () => setRevision((value) => value + 1),
    })
  }

  function movePageToTrash(pageId: string) {
    const roots = store.deleteSelection([pageId])
    if (!roots || roots.length === 0) return
    reloadFromStore()
    setActivePageId(null)
    setView('editor')
    setRefPanelOpen(false)
  }

  /** 回收站「恢复」（实现住 `shellSupport.restorePageWithLegacyName`）：桌面视图与手机 Sheet 共用。 */
  const restorePage = (id: string) => restorePageWithLegacyName({ store, snapshot, persist, reloadFromStore, notify }, id)

  return { openPurgeDialog, purgePages, movePageToTrash, restorePage }
}
