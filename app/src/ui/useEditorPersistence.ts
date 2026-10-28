import { useEffect, useMemo, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { EditorState, LexicalEditor } from '@moqi/editor'
import { createTextBlock, type Block, type BlockMap, type MetadataRegistry } from '@moqi/editor'
import type { DomainStore } from '../application/store'
import { OrderedPersistQueue } from '../application/persistQueue'
import { touchedBlockIds, type Operation, type Transaction } from '@moqi/editor'
import { editorBaseOf, reloadEditorFromStore, syncEditorChanges as syncEditorChangesInEditor } from '@moqi/editor'
import type { AssetPort, TransactionStoragePort } from '../composition'
import { useSyncEngine } from './useSyncEngine'
import type { SaveState } from './types'
import { ownerOfUpdate, type UndoOwner } from './undoRouting'

export type PersistenceDeps = {
  store: DomainStore
  storage: TransactionStoragePort
  activePageId: string | null
  activePageIdRef: MutableRefObject<string | null>
  editorRef: MutableRefObject<LexicalEditor | null>
  undoOwnerRef: MutableRefObject<UndoOwner>
  registry: MetadataRegistry
  updateRegistry: (next: MetadataRegistry) => void
  assetPort: AssetPort
  setAssetNames: Dispatch<SetStateAction<Set<string>>>
  setRevision: Dispatch<SetStateAction<number>>
  setSaveState: Dispatch<SetStateAction<SaveState>>
  notify: (message: string, actionLabel?: string, onAction?: () => void) => void
  refreshPinyin: (blocks: Map<string, Block>) => Promise<unknown>
}

/**
 * 保存队列、编辑器→领域镜像与同步触发（模块化 M1.6）。
 *
 * 原先这些函数直接长在 `EditorShell.tsx` 里，靠函数声明提升互相调用；搬出来后用
 * 同一个 hook 内的函数声明保持原有调用关系。`useSyncEngine` 也在这里接线，因为
 * 同步要读的 `persist` / `reloadFromStore` 就是本 hook 的产物。
 */
export function useEditorPersistence(deps: PersistenceDeps) {
  const {
    store, storage, activePageId, activePageIdRef, editorRef, undoOwnerRef,
    registry, updateRegistry, assetPort, setAssetNames, setRevision, setSaveState, notify, refreshPinyin,
  } = deps

  const persistVersionRef = useRef(0)
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingPersistRef = useRef<{ version: number; blocks: Map<string, Block>; purged: string[]; transactions: Transaction[] } | null>(null)
  const changeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingEnterRef = useRef<Map<string, Block>>(new Map())
  const persistQueue = useMemo(() => new OrderedPersistQueue(), [storage])

  const { syncState, syncStatus, deviceIdLabel, deviceId: resolveDeviceId, isSyncConfigured, setSyncDirectory, runSyncOnce, scheduleSync } = useSyncEngine({
    storage, store, persist, reloadFromStore, activePageIdRef,
    // A1：定义随同步走——读当下注册表；远端并进来之后写回（`updateRegistry` 自带落盘）。
    registry: () => registry,
    applyRegistry: updateRegistry,
  // 资产随同步（）：读名册算推 / 拉计划；拉回新文件后刷新名册并重建编辑器（占位变真图）。
    assetPort,
    onAssetsPulled: () => { void assetPort.listNames().then((names) => { setAssetNames(new Set(names)); reloadFromStore() }).catch(() => undefined) },
  })

  useEffect(() => () => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    if (changeTimerRef.current) clearTimeout(changeTimerRef.current)
  }, [])

  /**
   * 把收编来的根级正文写进领域：identity 由收编时生成，这里只做 insert。
   * 行内内容随后由 syncEditorChanges 按同一 identity 写回（与 Enter 建块同一条通路）。
   */
  function adoptRootContent(containerBlockId: string, items: { entityId: string; blockUid: string }[]) {
    const container = store.get(containerBlockId)
    if (!container) return
    const fresh = items.filter((item) => !store.get(item.entityId))
    if (fresh.length === 0) return
    const baseIndex = container.children.length
    store.apply({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      source: 'user',
      operations: fresh.map((item, index) => ({
        type: 'insert' as const,
        opId: crypto.randomUUID(),
        block: createTextBlock({
          entityId: item.entityId,
          blockUid: item.blockUid,
          parent: containerBlockId,
          text: '',
        }),
        parentId: containerBlockId,
        index: baseIndex + index,
      })),
    })
    persist(fresh.map((item) => item.entityId))
  }

  /**
   * V2b：把这一拍里应用过的事务写进 `transaction_history` + `oplog`——**同步只读那份日志**，
   * 漏记一条就是一次永远同步不出去的变化。每个事务连同**它自己改动过的块**一起提交，
   * Rust 侧把两者放进同一个 SQLite 事务，所以不会出现「块更新了、日志没有」的静默不同步。
   */
  async function commitTransactions(transactions: Transaction[], snapshots: Map<string, Block>): Promise<void> {
    if (transactions.length === 0) return
    const deviceId = await resolveDeviceId()
    for (const transaction of transactions) {
      const blocks = touchedBlockIds(transaction.operations)
        .map((id) => snapshots.get(id))
        .filter((block): block is Block => Boolean(block))
      await storage.commitTransaction({
        transactionId: transaction.id,
        source: transaction.source,
        deviceId,
        operations: transaction.operations.map((operation) => ({ opId: operation.opId, json: JSON.stringify(operation) })),
        inverseJson: JSON.stringify(transaction.inverse),
        created: transaction.timestamp,
      }, blocks)
    }
  }

  /** 把节拍里排队的快照立刻入队并记录保存态——节拍到点与「关闭前落盘」共用这一段。 */
  function commitPendingPersist() {
    const pending = pendingPersistRef.current ? structuredClone(pendingPersistRef.current) : null
    pendingPersistRef.current = null
    if (!pending) return
    setSaveState('saving')
    // Capture identity and payload once; retries must reuse both, including after a lost IPC response.
    const steps: Array<() => Promise<void>> = []
    if (storage.commitPersistBatch) {
      const batchId = crypto.randomUUID()
      const commitBatch = storage.commitPersistBatch.bind(storage)
      let batch: Parameters<NonNullable<TransactionStoragePort['commitPersistBatch']>>[0] | null = null
      steps.push(async () => {
        if (!batch) {
          const deviceId = await resolveDeviceId()
          batch = {
            batchId, blocks: [...pending.blocks.values()], purged: pending.purged,
            transactions: pending.transactions.map((transaction) => ({
              transactionId: transaction.id, source: transaction.source, deviceId,
              operations: transaction.operations.map((operation) => ({ opId: operation.opId, json: JSON.stringify(operation) })),
              inverseJson: JSON.stringify(transaction.inverse), created: transaction.timestamp,
            })),
          }
        }
        await commitBatch(batch)
      })
    } else {
      if (pending.blocks.size > 0) steps.push(() => storage.saveBlockChanges([...pending.blocks.values()]))
      for (const transaction of pending.transactions) {
        steps.push(() => commitTransactions([transaction], pending.blocks))
      }
      if (pending.purged.length > 0) steps.push(() => storage.purgeBlocks(pending.purged))
    }
    persistQueue.enqueue(steps)
    void persistQueue.flush()
      .then(() => {
        if (pending.version === persistVersionRef.current) setSaveState('saved')
        // V2c 路线 B：这一批落盘之后顺手刷新它们的拼音索引（派生数据，失败只吞掉、不影响编辑）。
        void refreshPinyin(pending.blocks)
        // 落盘之后排一次同步（延后 2 秒；重复调用只保留最后一次）——同步只读**已落盘**的
        // oplog，所以必须等这一拍落完才有得同步（`docs/03` §14.1 的时序约束）。
        if (isSyncConfigured()) scheduleSync()
      }).catch((error: unknown) => {
        if (pending.version !== persistVersionRef.current) return
        setSaveState('error')
        // 保存失败必须显性提示：否则界面会一直显示「已保存」，而内容只留在内存里。
        notify(`保存失败：${error instanceof Error ? error.message : String(error)}；后续编辑会自动重试`)
      })
  }

  /**
   * 关闭窗口前的落盘（docs/03 保存契约：这是生命周期动作，不放按键路径）。两步都要做，缺一不可：
   * ① 补上编辑器 → 领域的 220ms 防抖——不补这一步，刚敲的字还在 Lexical 里，落盘的是旧内容；
   * ② 把 600ms 节拍里的保存任务立刻入队，等待快照、日志和删除全部完成。
   */
  async function flushPendingPersist(): Promise<void> {
    if (changeTimerRef.current) {
      clearTimeout(changeTimerRef.current)
      changeTimerRef.current = null
      const editor = editorRef.current
      if (editor) syncEditorChanges(editor, editor.getEditorState())
    }
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current)
      persistTimerRef.current = null
    }
    commitPendingPersist()
    await persistQueue.flush()
  }

  function persist(changedIds: Iterable<string>) {
    setRevision((value) => value + 1)
    const version = ++persistVersionRef.current
    const blocks = pendingPersistRef.current?.blocks ?? new Map<string, Block>()
    // 领域自报的改动块必须一起落盘：插入/移动会改父块的 children，只写调用方点名的块
    // 会让库里的父子关系缺一条，下次载入后整个编辑器变成只读（见 domain/operation.ts touchedBlockIds）。
    for (const id of [...changedIds, ...store.takeTouched()]) {
      const block = store.get(id)
      if (block) blocks.set(id, block)
    }
    // V2b「从本机彻底删除」走另一条路：它们已经不在块图里了，落盘要**删行**而不是存行。
    const purged = store.takePurged()
    for (const id of purged) blocks.delete(id)
    const queuedPurged = [...new Set([...(pendingPersistRef.current?.purged ?? []), ...purged])]
    // V2b：这一拍里应用过的事务——它们要进 `oplog`（同步只读那份日志）。与块同一批取走，
    // 保证「写日志」和「写块状态」不会被拆到两拍里。
    const transactions = [...(pendingPersistRef.current?.transactions ?? []), ...store.takeCommittedTransactions()]
    if (blocks.size === 0 && queuedPurged.length === 0 && transactions.length === 0) return
    pendingPersistRef.current = { version, blocks, purged: queuedPurged, transactions }
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null
      commitPendingPersist()
    }, 600)
  }

  function onChange(_editorState: EditorState, editor: LexicalEditor, tags: Set<string>) {
    // 结构更新带 moqi- 标签 → 领域负责；纯输入不带标签 → Lexical 负责（docs/04 §5）。
    const owner = ownerOfUpdate(tags)
    if (owner) undoOwnerRef.current = owner
    if (tags.has('moqi-load')) return
    if (changeTimerRef.current) clearTimeout(changeTimerRef.current)
    changeTimerRef.current = setTimeout(() => {
      changeTimerRef.current = null
      syncEditorChanges(editor, editor.getEditorState())
    }, 220)
  }

  function syncEditorChanges(editor: LexicalEditor, editorState = editor.getEditorState()) {
    syncEditorChangesInEditor(editor, editorState, { store, activePageId, persist, pendingEnterRef })
  }

  /** 编辑器的基线：当前页面子树（含 Enter 新块），避免每次按键比较整库。 */
  function editorBase(): BlockMap {
    return editorBaseOf(store, activePageId)
  }

  /**
   * 领域重建（撤销 / 重做 / AI 结果落库 / 丢弃等）：**保留光标所在的块与块内偏移**。
   * 整篇重建会换掉所有节点（key 全变），所以偏移在重建前读、重建后按字符偏移放回去。
   * 此前重建后选区落在第一个正文块，撤销一次光标就甩到页面最开头（用户实测）。
   *
   * `pageId` 只在**闭包可能陈旧**的调用点显式传入（目前是同步轮询：`setInterval` 捕获的是
   * 建定时器那一版的 `runSyncOnce`，它读到的 `activePageId` 可能早已不是当前页——
  * 实测表现是「远端改动到了、标题是新的、正文却被重载成启动时那一页」）。
   * 其余调用点都在渲染闭包里，省略参数即用当下的 `activePageId`。
   */
  function reloadFromStore(pageId: string | null = activePageId, persistAll = true) {
    reloadEditorFromStore(editorRef.current, pageId, { store, activePageId, persist, pendingEnterRef, undoOwnerRef })
    // 彻底删除已经直接落盘，重建时不要再把整库写回一遍（persistAll = false）。
    if (persistAll) persist([...store.read().keys()])
  }

  /**
   * 丢弃「等落盘的那一份」：恢复快照前要用（`ui/useDataActions.ts`）——那两个 ref 是外壳保存队列的
   * 家产，所以这个能力由壳提供（语义与原实现一致：清定时器 + 清 pending 快照）。
   */
  function cancelPendingPersist() {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current)
      persistTimerRef.current = null
    }
    pendingPersistRef.current = null
  }

  return {
    persist, onChange, syncEditorChanges, reloadFromStore, flushPendingPersist, cancelPendingPersist,
    adoptRootContent, pendingEnterRef, editorBase,
    syncState, syncStatus, deviceIdLabel, resolveDeviceId, isSyncConfigured, setSyncDirectory, runSyncOnce, scheduleSync,
  }
}
