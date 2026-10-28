import type { AssetPort } from '../application/assets'
import { cleanupUnreferencedAssets } from '../application/assetSync'
import type { DomainStore } from '../application/store'
import type { TransactionStoragePort } from '../composition'
import { purgeSubtreeIds } from '@moqi/editor'
import { firstPageId } from './shellSupport'
import type { SaveState } from './types'

export type PurgeDeps = {
  store: DomainStore
  storage: TransactionStoragePort
  assetPort: AssetPort
  flushPendingPersist: () => Promise<void>
  reloadFromStore: (pageId: string | null, persistAll: boolean) => void
  setAssetNames: (names: Set<string>) => void
  setSaveState: (state: SaveState) => void
  notify: (message: string) => void
  getActivePageId: () => string | null
  setActivePageId: (id: string | null) => void
  setView: (view: 'editor') => void
  /** store 已直接变更，必须让外壳的 snapshot / 派生数据重算（否则回收站 Sheet 仍显示旧行）。 */
  refresh: () => void
}

/**
 * 回收站「从本机彻底删除」/「清空回收站」的唯一执行路径（`D-091`）。
 *
 * **先落盘、后摘内存**：数据库失败时页面原样保留，不再出现「界面已删、库里还在」；
 * 资产清理也只在落盘成功后执行，避免事务回滚时图片文件已经被删。
 *
 * 子树按 `parent` 链收集（`purgeSubtreeIds`），包含页面进回收站前就软删除的子块；
 * 与 Rust 侧 `expand_purge_ids` 是同一份语义（UI 收全 / DB 兜底）。
 */
export async function runPurge(pageIds: string[], deps: PurgeDeps): Promise<void> {
  const {
    store, storage, assetPort, flushPendingPersist, reloadFromStore,
    setAssetNames, setSaveState, notify, getActivePageId, setActivePageId, setView, refresh,
  } = deps
  const subtree = purgeSubtreeIds(store.read().values(), pageIds)
  if (subtree.length === 0) return

  // 在途编辑先落完；失败由落盘路径提示，这里不再叠一条。
  try { await flushPendingPersist() } catch { return }
  setSaveState('saving')
  try {
    if (storage.commitPersistBatch) {
      await storage.commitPersistBatch({ batchId: crypto.randomUUID(), blocks: [], purged: subtree, transactions: [] })
    } else {
      await storage.purgeBlocks(subtree)
    }
  } catch (error) {
    setSaveState('error')
    notify(`删除失败：${error instanceof Error ? error.message : String(error)}；没有改动任何内容`)
    return
  }

  const removed = store.purge(subtree)
  if (removed === 0) {
    setSaveState('saved')
    return
  }
  // 这一批已经直接落盘；清掉 store 的待删/待写集合，避免下一次自动保存重复删。
  store.takePurged()
  store.takeTouched()
  // store 是直接改的，不走 persist 的 revision 自增；显式刷新 snapshot / 回收站列表。
  refresh()
  // 落盘成功后才清资产：失败回滚时图片文件已经没了是另一类数据损失。
  void cleanupUnreferencedAssets(assetPort, store.read().values(), setAssetNames)

  const activePageId = getActivePageId()
  const nextPageId = activePageId && !store.get(activePageId) ? firstPageId(store.read()) : activePageId
  if (nextPageId !== activePageId) {
    setActivePageId(nextPageId)
    setView('editor')
  }
  setSaveState('saved')
  // 数据库已是终态，重建编辑器时不要再把整库写回一遍。
  reloadFromStore(nextPageId, false)
}
