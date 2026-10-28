import type { Block, MetadataRegistry } from '@moqi/editor'
import { normalizeBlock, parseBlockForLoad } from '@moqi/editor'
import type { SyncChange, SyncCursor, SyncFileIo, RegistrySyncState } from '../application/sync'

const METADATA_KEY = 'moqi-project-b:metadata'

export type PersistedOperation = { opId: string; json: string }
export type PersistedTransaction = {
  transactionId: string
  source: 'user' | 'ai' | 'sync' | 'migration' | 'system'
  deviceId: string
  operations: PersistedOperation[]
  inverseJson: string
  created: number
}

export type PersistBatch = {
  batchId: string
  transactions: PersistedTransaction[]
  blocks: Block[]
  purged: string[]
}

/**
 * 浏览器 / 内存通道的 oplog：这两条通道没有 `oplog` 表，就从 `transactions` 派生。
 * `seq` 按数组顺序发号——只要同一份日志每次派生出同样的序号，协议要的一致性就成立
 * （真应用走 `oplog` 表，序号由 `commit_transaction` 分配）。
 */
function deriveOplog(transactions: PersistedTransaction[], deviceId: string, fromSeq: number): SyncChange[] {
  const changes: SyncChange[] = []
  let seq = 0
  for (const transaction of transactions) {
    for (const operation of transaction.operations ?? []) {
      seq += 1
      if (seq <= fromSeq) continue
      changes.push({ deviceId, seq, opId: operation.opId, created: transaction.created, opJson: operation.json })
    }
  }
  return changes
}

function countOps(transactions: PersistedTransaction[]): number {
  return transactions.reduce((total, transaction) => total + (transaction.operations?.length ?? 0), 0)
}

export interface StoragePort {
  loadBlocks(): Promise<Block[]>
  saveBlocks(blocks: Block[]): Promise<void>
  /** Persist only the Blocks changed since the last save. */
  saveBlockChanges(blocks: Block[]): Promise<void>
  /**
   * V2b：「从本机彻底删除」——物理移除这些 Block（`docs/03` §14.5 层 2）。
   * **不是一次变更**：它不进 oplog、不产生 transaction，因此没有逆操作、不可撤销。
   */
  purgeBlocks(entityIds: string[]): Promise<void>
  /** T15: global property/tag definitions; `null` means "not created yet". */
  loadMetadata(): Promise<MetadataRegistry | null>
  saveMetadata(registry: MetadataRegistry): Promise<void>
}

export interface TransactionStoragePort extends StoragePort {
  /** SQLite capability: atomic commit with a durable, content-checked retry receipt. */
  commitPersistBatch?(batch: PersistBatch): Promise<void>
  /**
   * V2b：本机设备身份（`oplog` 分区、游标、冲突定序都按它走，`docs/03` §14.2 / §14.3）。
   * 稳定不变——同一个库永远返回同一个值。
   */
  deviceId(): Promise<string>
  /**
   * V2b：把一次领域事务连同它改动过的 Block 一起落库。**与 `saveBlockChanges` 的区别是它
   * 同时写 `transaction_history` + `oplog`**——同步只读这份日志，两者在同一个事务里提交。
   */
  commitTransaction(transaction: PersistedTransaction, blocks: Block[]): Promise<void>
  /**
   * V2b：同步的设备本地状态（同步位置 + 游标）。与库同源——换台机器要重新配，
   * 但它跟着**这个库**走，所以不能放 `ui-prefs`（那份是纯界面偏好，清了不影响数据语义）。
   */
  loadSyncState(): Promise<SyncState | null>
  saveSyncState(state: SyncState): Promise<void>
  /**
   * V2b：本机 `oplog` 里 `seq > fromSeq` 的那段——同步的「变更集」来源。
   * **只读已落盘的日志**（`docs/03` §14.1 的时序约束）。
   */
  loadOplog(deviceId: string, fromSeq: number): Promise<SyncChange[]>
  /** V2b：本机 `oplog` 的最大 `seq`——「还有 N 条待同步」靠它算。*/
  maxOplogSeq(deviceId: string): Promise<number>
  markTransactionUndone(transactionId: string, undone: boolean): Promise<void>
}

/** V2b：本机这份同步配置。`directory` 为空 = 还没配过（`09-桌面端交互规范` `R09-SYNC-5` 的「未配置同步」）。*/
export type SyncState = {
  directory: string
  cursor: SyncCursor
  lastSyncAt: number | null
 /** A1（）：定义同步的本机状态。老库没有这一项——读回时按"从未同步过定义"处理。 */
  registry?: RegistrySyncState
}

export interface NativePort {
  dataDirectory(): Promise<string>
}

export class MemoryStorage implements TransactionStoragePort {
  private blocks: Block[] = []
  private transactions: PersistedTransaction[] = []
  private transactionStates = new Map<string, boolean>()
  private metadata: MetadataRegistry | null = null
  async loadBlocks(): Promise<Block[]> { return structuredClone(this.blocks) }
  async saveBlocks(blocks: Block[]): Promise<void> { this.blocks = structuredClone(blocks) }
  async saveBlockChanges(blocks: Block[]): Promise<void> {
    const next = new Map(this.blocks.map((block) => [block.entityId, block]))
    for (const block of blocks) next.set(block.entityId, structuredClone(block))
    this.blocks = [...next.values()]
  }
  async loadMetadata(): Promise<MetadataRegistry | null> { return this.metadata ? structuredClone(this.metadata) : null }
  async saveMetadata(registry: MetadataRegistry): Promise<void> { this.metadata = structuredClone(registry) }
  /** 测试用的固定身份：同一实例永远返回同一个值。 */
  async deviceId(): Promise<string> { return 'memory-device' }
  async loadSyncState(): Promise<SyncState | null> { return this.syncState ? structuredClone(this.syncState) : null }
  async saveSyncState(state: SyncState): Promise<void> { this.syncState = structuredClone(state) }
  async loadOplog(deviceId: string, fromSeq: number): Promise<SyncChange[]> { return deriveOplog(this.transactions, deviceId, fromSeq) }
  async maxOplogSeq(): Promise<number> { return countOps(this.transactions) }
  private syncState: SyncState | null = null
  async purgeBlocks(entityIds: string[]): Promise<void> {
    const remove = new Set(entityIds)
    this.blocks = this.blocks.filter((block) => !remove.has(block.entityId))
  }
  async commitTransaction(transaction: PersistedTransaction, blocks: Block[]): Promise<void> {
    // 合并写入，**不是** `saveBlocks` —— 后者是整份覆盖，而这里传进来的只是这一批事务碰过的块。
    await this.saveBlockChanges(blocks)
    this.transactions.push(structuredClone(transaction))
    this.transactionStates.set(transaction.transactionId, false)
  }
  async markTransactionUndone(transactionId: string, undone: boolean): Promise<void> {
    if (this.transactions.some((item) => item.transactionId === transactionId)) this.transactionStates.set(transactionId, undone)
  }
}

/** Browser fallback used by the V1 prototype while the Tauri command bridge is wired. */
export class LocalStoragePort implements TransactionStoragePort {
  private readonly blocksKey: string
  private readonly transactionsKey: string

  constructor(namespace = 'moqi-project-b') {
    this.blocksKey = `${namespace}:blocks`
    this.transactionsKey = `${namespace}:transactions`
  }

  async loadBlocks(): Promise<Block[]> {
    const raw = globalThis.localStorage?.getItem(this.blocksKey)
    if (!raw) return []
    let blocks: Block[]
    try {
      blocks = JSON.parse(raw) as Block[]
    } catch {
      // 损坏的 JSON **不再静默清空 + 重新播种**——那等于无提示地抹掉用户整库（与「看得见的失败
      // 优于静默」相反）。上抛，由载入失败屏接住：浏览器通道同样有快照可恢复（`LOAD-RECOVER-1`；
      // 台账 `D-063`）。
      throw new Error('本地存储里的块数据已损坏（浏览器通道）——请用下面的快照恢复')
    }
    return structuredClone(blocks.map(normalizeBlock))
  }

  async saveBlocks(blocks: Block[]): Promise<void> {
    globalThis.localStorage?.setItem(this.blocksKey, JSON.stringify(blocks))
  }

  async saveBlockChanges(blocks: Block[]): Promise<void> {
    const current = await this.loadBlocks()
    const next = new Map(current.map((block) => [block.entityId, block]))
    for (const block of blocks) next.set(block.entityId, structuredClone(block))
    await this.saveBlocks([...next.values()])
  }

  async loadMetadata(): Promise<MetadataRegistry | null> {
    const raw = globalThis.localStorage?.getItem(`${this.blocksKey.replace(/:blocks$/, '')}:metadata`) ?? globalThis.localStorage?.getItem(METADATA_KEY)
    if (!raw) return null
    try {
      return JSON.parse(raw) as MetadataRegistry
    } catch {
      return null
    }
  }

  async saveMetadata(registry: MetadataRegistry): Promise<void> {
    globalThis.localStorage?.setItem(`${this.blocksKey.replace(/:blocks$/, '')}:metadata`, JSON.stringify(registry))
  }

  async purgeBlocks(entityIds: string[]): Promise<void> {
    const remove = new Set(entityIds)
    await this.saveBlocks((await this.loadBlocks()).filter((block) => !remove.has(block.entityId)))
  }

  async commitTransaction(transaction: PersistedTransaction, blocks: Block[]): Promise<void> {
    // 同上：合并写入，不能整份覆盖——传进来的只是这一批事务碰过的块。
    await this.saveBlockChanges(blocks)
    const existing = this.readTransactions()
    existing.push(transaction)
    globalThis.localStorage?.setItem(this.transactionsKey, JSON.stringify(existing))
  }

  /** V2b：设备身份存 localStorage，首次调用时生成——稳定不变（同步的游标按它分区）。 */
  async deviceId(): Promise<string> {
    const key = `${this.blocksKey.replace(/:blocks$/, '')}:device-id`
    const existing = globalThis.localStorage?.getItem(key)
    if (existing) return existing
    const generated = crypto.randomUUID()
    globalThis.localStorage?.setItem(key, generated)
    return generated
  }

  async loadSyncState(): Promise<SyncState | null> {
    const raw = globalThis.localStorage?.getItem(`${this.blocksKey.replace(/:blocks$/, '')}:sync`)
    if (!raw) return null
    try {
      return JSON.parse(raw) as SyncState
    } catch {
      return null
    }
  }

  async saveSyncState(state: SyncState): Promise<void> {
    globalThis.localStorage?.setItem(`${this.blocksKey.replace(/:blocks$/, '')}:sync`, JSON.stringify(state))
  }

  async loadOplog(deviceId: string, fromSeq: number): Promise<SyncChange[]> {
    return deriveOplog(this.readTransactions(), deviceId, fromSeq)
  }

  async maxOplogSeq(): Promise<number> {
    return countOps(this.readTransactions())
  }

  async markTransactionUndone(transactionId: string, undone: boolean): Promise<void> {
    const transactions = this.readTransactions().map((transaction) => transaction.transactionId === transactionId
      ? { ...transaction, undone }
      : transaction)
    globalThis.localStorage?.setItem(this.transactionsKey, JSON.stringify(transactions))
  }

  private readTransactions(): Array<PersistedTransaction & { undone?: boolean }> {
    const raw = globalThis.localStorage?.getItem(this.transactionsKey)
    return raw ? JSON.parse(raw) as Array<PersistedTransaction & { undone?: boolean }> : []
  }
}

/** Tauri adapter. The domain only sees StoragePort; the invoke import stays at this boundary. */
export class TauriStoragePort implements TransactionStoragePort {
  async commitPersistBatch(batch: PersistBatch): Promise<void> {
    await this.invoke('commit_persist_batch', {
      ...batch,
      blocks: batch.blocks.map((block) => JSON.stringify(block)),
    })
  }
  private async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<T>(command, args)
  }

  async loadBlocks(): Promise<Block[]> {
    // 载入面用 `parseBlockForLoad`：报告级形状问题（媒体四条 / pinned·starred 两条……）随块放行——
  // 挡在启动上等于连「删掉那一块」的修法都够不着（`03-技术说明（数据与存储）` §5； 审计）。
    const json = await this.invoke<string[]>('load_blocks')
    return json.map(parseBlockForLoad)
  }

  async saveBlocks(blocks: Block[]): Promise<void> {
    await this.invoke('save_blocks', { blocks: blocks.map((block) => JSON.stringify(block)) })
  }

  async saveBlockChanges(blocks: Block[]): Promise<void> {
    await this.invoke('save_block_changes', { blocks: blocks.map((block) => JSON.stringify(block)) })
  }

  async loadMetadata(): Promise<MetadataRegistry | null> {
    const json = await this.invoke<string | null>('load_metadata', { key: 'registry' })
    return json ? (JSON.parse(json) as MetadataRegistry) : null
  }

  async saveMetadata(registry: MetadataRegistry): Promise<void> {
    await this.invoke('save_metadata', { key: 'registry', json: JSON.stringify(registry) })
  }

  async purgeBlocks(entityIds: string[]): Promise<void> {
    if (entityIds.length === 0) return
    await this.invoke('purge_blocks', { entityIds })
  }

  async commitTransaction(transaction: PersistedTransaction, blocks: Block[]): Promise<void> {
    // V2b：这条路径**必须**走原生命令而不是 saveBlocks——事务日志与块要在同一个 SQLite
    // 事务里提交，否则崩溃会留下「块更新了、日志没有」的静默不同步。
    await this.invoke('commit_transaction', {
      transaction,
      blocks: blocks.map((block) => JSON.stringify(block)),
    })
  }

  /**
   * V2b：设备身份。候选值由前端生成（`crypto.randomUUID()`），Rust 侧只在库里没有时落库——
   * **身份只认库里的那一份**，所以同一个库永远返回同一个值。
   *
   * 缓存的是**进行中的 Promise**，不是它的结果：启动时会有多处并发调用（编辑器挂载的两处 +
   * 同步引擎），缓存结果的话每个并发调用都会各自生成候选值、各自问一次 Rust——「先写进库的」
   * 成为文件名、「最后写进库的」成为界面与库里显示的身份，于是**同一台机器在共享目录里留下
  * 两个 `<deviceId>.jsonl`**（ 清单 C 在真机/真窗口实测到，库没有 device_id 的全新安装
   * 就会命中）。
   */
  deviceId(): Promise<string> {
    this.deviceIdPromise ??= this.invoke<string>('resolve_device_id', { candidate: crypto.randomUUID() })
    return this.deviceIdPromise
  }
  private deviceIdPromise: Promise<string> | null = null

  /** 与库同源：复用通用的元数据键值命令（`load_metadata` / `save_metadata`），不新增 Rust 命令。*/
  async loadSyncState(): Promise<SyncState | null> {
    const json = await this.invoke<string | null>('load_metadata', { key: 'sync' })
    if (!json) return null
    try {
      return JSON.parse(json) as SyncState
    } catch {
      return null
    }
  }

  async saveSyncState(state: SyncState): Promise<void> {
    await this.invoke('save_metadata', { key: 'sync', json: JSON.stringify(state) })
  }

  async loadOplog(deviceId: string, fromSeq: number): Promise<SyncChange[]> {
    const rows = await this.invoke<{ seq: number; opId: string; created: number; opJson: string }[]>(
      'load_oplog',
      { deviceId, fromSeq },
    )
    return rows.map((row) => ({ deviceId, seq: row.seq, opId: row.opId, created: row.created, opJson: row.opJson }))
  }

  async maxOplogSeq(deviceId: string): Promise<number> {
    return this.invoke<number>('max_oplog_seq', { deviceId })
  }

  async markTransactionUndone(transactionId: string, undone: boolean): Promise<void> {
    void transactionId
    void undone
  }
}

export function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * V2b：共享目录的真实读写——走 `sync_append` / `sync_read_others` 两个 Rust 命令。
 * 只追加自己的 `<deviceId>.jsonl`，绝不改写别人的，所以两台实例各写各的、不需要锁。
 */
export class TauriSyncFileIo implements SyncFileIo {
  async append(directory: string, deviceId: string, lines: string[]): Promise<void> {
    if (lines.length === 0) return
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('sync_append', { directory, deviceId, lines })
  }

  async readOthers(directory: string, deviceId: string): Promise<{ deviceId: string; lines: string[] }[]> {
    const { invoke } = await import('@tauri-apps/api/core')
    return invoke<{ deviceId: string; lines: string[] }[]>('sync_read_others', { directory, deviceId })
  }
}

/**
 * 浏览器通道的共享目录：用 localStorage 当「目录」。**不是真实传输**，但它让整条同步流程
 * （交换 / 冲突 / 幂等）能在 `pnpm accept` 里跑起来——同一个浏览器里开两个实例就是两台设备。
 */
export class LocalStorageSyncFileIo implements SyncFileIo {
  constructor(private readonly namespace = 'moqi-sync-dir') {}

  async append(directory: string, deviceId: string, lines: string[]): Promise<void> {
    if (lines.length === 0) return
    const key = `${this.namespace}:${directory}:${deviceId}`
    const existing: string[] = JSON.parse(globalThis.localStorage?.getItem(key) ?? '[]')
    globalThis.localStorage?.setItem(key, JSON.stringify([...existing, ...lines]))
  }

  async readOthers(directory: string, deviceId: string): Promise<{ deviceId: string; lines: string[] }[]> {
    const prefix = `${this.namespace}:${directory}:`
    const out: { deviceId: string; lines: string[] }[] = []
    for (let index = 0; index < (globalThis.localStorage?.length ?? 0); index += 1) {
      const key = globalThis.localStorage?.key(index)
      if (!key?.startsWith(prefix)) continue
      const owner = key.slice(prefix.length)
      if (owner === deviceId) continue
      out.push({ deviceId: owner, lines: JSON.parse(globalThis.localStorage?.getItem(key) ?? '[]') as string[] })
    }
    return out
  }
}

export function createDefaultSyncFileIo(): SyncFileIo {
  return isTauriRuntime() ? new TauriSyncFileIo() : new LocalStorageSyncFileIo()
}

export function createDefaultStoragePort(): TransactionStoragePort {
  return isTauriRuntime() ? new TauriStoragePort() : new LocalStoragePort()
}
