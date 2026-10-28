import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { createDefaultAssetSyncPort, createDefaultSyncFileIo, type AssetPort, type SyncState, type TransactionStoragePort } from '../composition'
import { DirectorySyncPort, runSync } from '../application/sync'
import { assetSyncPlan, referencedAssetNames } from '../application/assetSync'
import type { MetadataRegistry } from '@moqi/editor'
import type { DomainStore } from '../application/store'
import type { SyncStatus } from './types'

/**
 * V2b：同步引擎的接线。**从 `EditorShell.tsx` 抽出来的第一块**（治理还债 #2 的第 1 个模块，
 * 2026-10-04；抽象边界＝「什么时候同步 + 同步完做什么」，界面呈现仍归调用方）。
 *
 * 传输是共享目录（`docs/03` §14.2 的 `DirectorySyncPort`）；位置与游标跟着**本机这个库**走
 * （`storage.loadSyncState`），不跟 `ui-prefs` 走——换台机器要重新配，但清了 `ui-prefs` 不该动它。
 *
 * 三条触发口径都是验收踩出来的（`07` 归档 · V2b）：**配过位置立刻走一轮**（否则永远停在「同步中」）、
 * **定期拉**（对端写的变更不会叫醒本机）、**落盘之后延后 2 秒才排**（打字时不该每一拍都跑一趟）。
 */

/** 失败后的重试退避（`docs/03` §14.4：1s → 2s → 5s → 15s → 60s 封顶）。 */
const RETRY_DELAYS = [1_000, 2_000, 5_000, 15_000, 60_000]
/**
 * 定期拉一次的间隔：读的是**本地目录**（云盘客户端自己负责网络），一次轮询就是几次 stat + read，
 * 代价可以忽略；对端在另一台机器上写字，最迟 10 秒后这边能看到。
 */
const POLL_INTERVAL = 10_000
/** 落盘之后延后多久排一次同步（重复调用只保留最后一次）。 */
const SCHEDULE_DELAY = 2_000

export type SyncEngine = {
  syncState: SyncState
  syncStatus: SyncStatus
  /** 设置页显示用的截断身份（排查同步问题时对得上「这台是哪台」）。 */
  deviceIdLabel: string | null
  /** 设备身份：`oplog` 落账与同步共用同一份（同步只读那份日志）。 */
  deviceId: () => Promise<string>
  /** 是否配过同步位置（落盘之后要不要排同步由它决定；读 ref，不读 state）。 */
  isSyncConfigured: () => boolean
  setSyncDirectory: (directory: string) => void
  runSyncOnce: () => Promise<void>
  scheduleSync: (delay?: number) => void
}

export function useSyncEngine(options: {
  storage: TransactionStoragePort
  store: DomainStore
  /** 落盘（调用方负责节拍与合并写；本 hook 只在同步前后用它）。 */
  persist: (changedIds: Iterable<string>) => void
  /** 领域重建（远端变更应用到本机后要刷新打开着的编辑器，见 `runSyncOnce` 里的注释）。 */
  reloadFromStore: (pageId?: string | null) => void
  /** 当前页号：同步跑在定时器捕获的陈旧闭包里，重建编辑器时要读**当下**的值。 */
  activePageIdRef: RefObject<string | null>
  /** A1：本机当前的注册表（同步跑在陈旧闭包里，同样读 ref）。 */
  registry: () => MetadataRegistry
  /** A1：远端定义并进本机之后写回注册表（调用方负责 `saveMetadata`）。 */
  applyRegistry: (next: MetadataRegistry) => void
  /** 媒体资产端口（资产随同步：读本机已有磁盘名；`docs/03` §14.2「媒体文件」，2026-10-11）。 */
  assetPort: AssetPort
  /** 资产拉回来了（本机多了文件）→ 调用方刷新名册并重建编辑器，「文件缺失」占位变回真图。 */
  onAssetsPulled: () => void
}): SyncEngine {
  const { storage, store, persist, reloadFromStore, activePageIdRef, registry, applyRegistry, assetPort } = options
  // 与 `activePageIdRef` 同一个理由：`runSyncOnce` 跑在定时器捕获的闭包里，
  // 注册表与写回函数必须读**当下**的值，不能读注册那一刻的旧值。
  const registryRef = useRef(registry)
  registryRef.current = registry
  const applyRegistryRef = useRef(applyRegistry)
  applyRegistryRef.current = applyRegistry

  const deviceIdRef = useRef<Promise<string> | null>(null)
  const resolveDeviceId = (): Promise<string> => {
    // 启动就把它定下来，别等第一次改动——身份越早稳定越好，懒解析会让「还没动过的新库」没有身份。
    deviceIdRef.current ??= storage.deviceId()
    return deviceIdRef.current
  }
  // 设置页显示的截断身份（排查同步问题时对得上「这台是哪台」）。
  const [deviceIdLabel, setDeviceIdLabel] = useState<string | null>(null)
  useEffect(() => {
    void resolveDeviceId()
      .then((id) => setDeviceIdLabel(`${id.slice(0, 8)}…`))
      .catch(() => setDeviceIdLabel('（取不到）'))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resolveDeviceId 每次渲染都是新函数
  }, [storage])
  // 换库（storage 变）就重新解析一次。
  useEffect(() => { deviceIdRef.current = storage.deviceId() }, [storage])

  const syncIo = useMemo(() => createDefaultSyncFileIo(), [])
  const assetSyncPort = useMemo(() => createDefaultAssetSyncPort(), [])
  // 资产拉回的刷新回调与注册表同一个理由：同步跑在定时器捕获的陈旧闭包里，必须读**当下**的值。
  const onAssetsPulledRef = useRef(options.onAssetsPulled)
  onAssetsPulledRef.current = options.onAssetsPulled
  const [syncState, setSyncState] = useState<SyncState>({ directory: '', cursor: {}, lastSyncAt: null })
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ kind: 'unconfigured' })
  const syncStateRef = useRef(syncState)
  syncStateRef.current = syncState
  const syncingRef = useRef(false)
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryStepRef = useRef(0)

  useEffect(() => {
    void storage.loadSyncState().then((state) => {
      if (!state) return
      // 先同步 ref 再 setState：`runSyncOnce` 读的是 ref，而 setState 要等下一次渲染才生效。
      syncStateRef.current = state
      setSyncState(state)
      if (!state.directory) { setSyncStatus({ kind: 'unconfigured' }); return }
      // 配过位置就**立刻走一轮**——否则「配好了但还没同步过」会一直停在「同步中」，
      // 而那一轮永远不会自己来（它原本只在落盘之后才被排上）。
      setSyncStatus({ kind: 'syncing', done: 0, total: 1 })
      void runSyncOnce()
    })
  }, [storage])

  useEffect(() => {
    if (!syncState.directory) return
    const timer = setInterval(() => { void runSyncOnce() }, POLL_INTERVAL)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runSyncOnce 每次渲染都是新函数
  }, [syncState.directory])

  /**
   * 走一次同步。**任何失败都只变成状态，不影响编辑**（`R09-SYNC-8`：不弹模态、不改光标、
   * 不阻断保存队列）——这正是「本地优先」的落点：同步坏掉时软件照常能用。
   */
  async function runSyncOnce(): Promise<void> {
    if (syncingRef.current) return
    const state = syncStateRef.current
    if (!state.directory) { setSyncStatus({ kind: 'unconfigured' }); return }
    syncingRef.current = true
    try {
      const deviceId = await resolveDeviceId()
      const cursor = state.cursor
      const total = Math.max(1, (await storage.maxOplogSeq(deviceId)) - (cursor[deviceId] ?? 0))
      setSyncStatus({ kind: 'syncing', done: 0, total })
      const port = new DirectorySyncPort(syncIo, () => state.directory, () => resolveDeviceId())
      let appliedGroups = 0
      const result = await runSync({
        port, deviceId, oplog: await storage.loadOplog(deviceId, 0), cursor,
        blocks: store.snapshot(),
        registry: registryRef.current(),
        registryState: state.registry ?? { sent: null, cursor: {} },
        apply: (operations, transaction) => {
          // 远端变更走领域事务通路（`source: 'sync'`），跟手敲一个字是同一条路——
          // 所以它同样进撤销栈、同样被落盘、也同样被转发给下一台设备。
          store.apply({ ...transaction, operations })
          appliedGroups += 1
        },
      })
      if (appliedGroups > 0) {
        // **远端改动进了领域，打开着的编辑器不会自己知道**：整篇重建一次（撤销 / 重做走同一条路，
        // 顺带把光标按块内偏移放回原处、把块图落盘）。少了这一步，两台机器同看一页时对方改的内容
        // 只在库里、正文一动不动；此时在本机继续打字，会把对方那一版覆盖回去（2026-10-03 清单 C 实测）。
        // 页号显式传 ref：这条路径跑在定时器捕获的陈旧闭包里，闭包里的 `activePageId` 可能还是启动那页。
        reloadFromStore(activePageIdRef.current)
      } else {
        persist([])
      }
      // A1：远端定义并进本机 → 写回注册表（界面下一帧就能解析名字）。
      // 编辑器**不用**重建：面板上的名字由注册表派生，`setRegistry` 一到就会重渲染。
      if (result.registryMerged) applyRegistryRef.current(result.registryMerged)
      // 资产随同步（`docs/03` §14.2「媒体文件」；13-媒体设计（已归档）§2 第 3 行）：每轮成功之后
      // 推 / 拉一次（只增不减）。失败静默重试——资产不在编辑路径上，下一轮同步会补（幂等）。
      void syncAssets(state.directory)
      const next: SyncState = { ...state, cursor: result.cursor, lastSyncAt: Date.now(), registry: result.registry }
      setSyncState(next)
      await storage.saveSyncState(next)
      setSyncStatus({ kind: 'synced', at: next.lastSyncAt ?? Date.now() })
      retryStepRef.current = 0
    } catch {
      // 传输不可达不是错误态（`R09-SYNC-4`）：只把状态改成「离线 · N 条待同步」。
      const deviceId = await resolveDeviceId().catch(() => '')
      const total = deviceId ? await storage.maxOplogSeq(deviceId).catch(() => 0) : 0
      setSyncStatus({ kind: 'offline', pending: Math.max(0, total - (state.cursor[deviceId] ?? 0)) })
      // 指数退避重试；连上之后自动补传。
      const delay = RETRY_DELAYS[Math.min(retryStepRef.current, RETRY_DELAYS.length - 1)]
      retryStepRef.current += 1
      scheduleSync(delay)
    } finally {
      syncingRef.current = false
    }
  }

  /**
   * 资产随同步（`docs/03` §14.2「媒体文件」）：推「被引用 ∩ 本机有」、拉「被引用 − 本机有」；
   * 共享端只增不减。失败不打扰用户——每轮重试、幂等（资产不是编辑路径的一环）。
   */
  async function syncAssets(directory: string): Promise<void> {
    try {
      const local = new Set(await assetPort.listNames())
      const plan = assetSyncPlan(referencedAssetNames(store.read().values()), local)
      const report = await assetSyncPort.exchange(directory, plan.push, plan.want)
      if (report.pulled.length > 0) onAssetsPulledRef.current()
    } catch {
      // 见上：只重试，不弹任何东西（同步状态的显示归状态行，不归资产这条支路）
    }
  }

  /** 排一次延后的同步（重复调用只保留最后一次——打字时不该每拍都往共享目录跑一趟）。*/
  function scheduleSync(delay = SCHEDULE_DELAY): void {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null
      void runSyncOnce()
    }, delay)
  }

  /**
   * 改同步位置。**换了位置就清空游标**——换位置等于换一份日志，留着旧游标会把新目录里的变更
   * 当成「已应用」而全部跳过，表现成「配了同步但什么都同步不过来」。
   * 只在真的换了值时才清，输入框逐字敲不该清游标。
   */
  function setSyncDirectory(directory: string): void {
    const previous = syncStateRef.current
    const changed = directory !== previous.directory
    // 换位置等于换一份日志：变更游标与**定义游标**一起清——旧的版本号来自旧目录里的文件，
    // 留着会把新目录里的定义快照当成「已并过」而全部跳过。
    const next: SyncState = changed
      ? { directory, cursor: {}, lastSyncAt: null, registry: { sent: null, cursor: {} } }
      : { ...previous, directory }
    syncStateRef.current = next
    setSyncState(next)
    void storage.saveSyncState(next)
    if (!directory) { setSyncStatus({ kind: 'unconfigured' }); return }
    if (changed) void runSyncOnce()
  }

  return {
    syncState, syncStatus, deviceIdLabel, deviceId: resolveDeviceId,
    isSyncConfigured: () => Boolean(syncStateRef.current.directory),
    setSyncDirectory, runSyncOnce, scheduleSync,
  }
}
