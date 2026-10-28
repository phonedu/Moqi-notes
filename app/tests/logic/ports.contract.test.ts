import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectorySyncPort, type SyncChange, type SyncFileIo, type SyncPort } from '../../src/application/sync'
import type { AssetSyncPort } from '../../src/application/assetSync'
import { LocalStoragePort, MemoryStorage, TauriStoragePort, type StoragePort, type TransactionStoragePort } from '../../src/adapters/ports'
import { createTextBlock } from '@moqi/editor'
import type { DocumentStoragePort, EditorHost } from '@moqi/editor'
import { createMemoryEditorHost } from '@moqi/editor'

/**
 * 契约门（治理期还债 #4a，2026-10-04）。
 *
 * `docs/03` §14 把同步协议与存储端口写成了对外契约：端口形状、`<deviceId>.jsonl` 的记录形状。
 * 契约改了**必须有人知道**——以前它只是文档里的散文，改了端口没人拦，写到别的设备上的文件格式漂移了
 * 也没人拦（那是最难回滚的一类：旧设备读不懂新行、新设备读不懂旧行）。
 *
 * 三道判据：
 * ① **类型级**：端口的键集合必须与下面写死的清单**完全相等**——加 / 删 / 改名一个方法，
 *    `pnpm typecheck` 直接红（本文件在 tsconfig 的 include 里）。改契约就得先改这份快照，
 *    这一步就是「过门」。
 * ② **运行时**：两个存储适配器的**方法集合**与清单相等。类型只约束接口；`private` 在运行时不是私有的
 *    （`readTransactions` 这种内部助手也会出现在方法表里），所以把已知的内部助手一并记进快照，
 *    多出来 / 少掉都能看见。
 * ③ **协议形状**：一条变更落成一行 JSON 之后的键集合 + 未知键容忍（前向兼容：旧版本读到新版本
 *    加出来的字段，不许整行判废，否则新字段一上线旧设备就掉线）。
 */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Assert<T extends true> = T

/** 端口形状快照：改了 `docs/03` §14 的端口，就把这里一起改（这一步就是「过门」）。 */
type StoragePortShape = Assert<Equals<keyof StoragePort, 'loadBlocks' | 'saveBlocks' | 'saveBlockChanges' | 'purgeBlocks' | 'loadMetadata' | 'saveMetadata'>>
type TransactionStoragePortShape = Assert<Equals<keyof TransactionStoragePort, keyof StoragePort | 'commitPersistBatch' | 'deviceId' | 'commitTransaction' | 'loadSyncState' | 'saveSyncState' | 'loadOplog' | 'maxOplogSeq' | 'markTransactionUndone'>>
type SyncPortShape = Assert<Equals<keyof SyncPort, 'exchange'>>
/** 资产随同步的端口（`docs/03` §14.2「媒体文件」，2026-10-11 落）：键集合同样钉住。 */
type AssetSyncPortShape = Assert<Equals<keyof AssetSyncPort, 'exchange'>>
type SyncFileIoShape = Assert<Equals<keyof SyncFileIo, 'append' | 'readOthers'>>
type SyncChangeShape = Assert<Equals<keyof SyncChange, 'deviceId' | 'seq' | 'opId' | 'created' | 'opJson'>>

void (null as unknown as StoragePortShape)
void (null as unknown as TransactionStoragePortShape)
void (null as unknown as SyncPortShape)
void (null as unknown as AssetSyncPortShape)
void (null as unknown as SyncFileIoShape)
void (null as unknown as SyncChangeShape)

/** 端口方法清单 = 契约的运行时投影（类型级那份的镜像）。 */
const PORT_METHODS = [
  'loadBlocks', 'saveBlocks', 'saveBlockChanges', 'purgeBlocks', 'loadMetadata', 'saveMetadata',
  'deviceId', 'commitTransaction', 'loadSyncState', 'saveSyncState', 'loadOplog', 'maxOplogSeq', 'markTransactionUndone',
].sort()

const methodsOf = (value: object): string[] => Object.getOwnPropertyNames(Object.getPrototypeOf(value))
  .filter((name) => name !== 'constructor')
  .sort()

test('CONTRACT-PORT-1 存储端口的运行时形状：接口方法齐全，且没有多出来的公开面（docs/03 §14）', () => {
  // 浏览器通道的适配器多一个 TS `private` 的内部助手——记在这里，改名 / 新增都要过一次门。
  assert.deepEqual(methodsOf(new LocalStoragePort()), [...PORT_METHODS, 'readTransactions'].sort(),
    'LocalStoragePort 的方法集合变了：接口改了要同步 `docs/03` §14 与上面的类型快照；新增内部方法也要登记')
  assert.deepEqual(methodsOf(new MemoryStorage()), PORT_METHODS,
    'MemoryStorage 的方法集合变了：它必须与接口逐字一致（超集意味着接口漏了东西）')
})

test('SAVE-BATCH-IPC 原子批次使用单条原生命令并原样传播失败', async () => {
  const storage = new TauriStoragePort()
  const calls: unknown[] = []
  const boundary = storage as unknown as { invoke: (command: string, args: unknown) => Promise<void> }
  boundary.invoke = async (command, args) => { calls.push({ command, args }) }
  const batch = { batchId: 'batch-1', transactions: [], blocks: [], purged: ['removed'] }
  await storage.commitPersistBatch(batch)
  assert.deepEqual(calls, [{ command: 'commit_persist_batch', args: batch }])
  boundary.invoke = async () => { throw new Error('disk full') }
  await assert.rejects(storage.commitPersistBatch(batch), /disk full/)
})

test('CONTRACT-SYNC-1 变更记录的键集合快照：跨设备写出去的那一行长什么样（docs/03 §14.2）', async () => {
  const written: string[] = []
  const io: SyncFileIo = {
    async append(_directory, _deviceId, lines) { written.push(...lines) },
    async readOthers() { return [] },
  }
  const change: SyncChange = {
    deviceId: 'device-a',
    seq: 7,
    opId: 'op-1',
    created: 1_700_000_000_000,
    opJson: JSON.stringify({ type: 'update', opId: 'op-1', blockId: 'b1', changes: { checked: true }, previous: { checked: false } }),
  }
  await new DirectorySyncPort(io, () => '/shared', async () => 'device-a').exchange([change], {})

  assert.equal(written.length, 1, '一次 exchange 只追加自己产生的那一批')
  const record = JSON.parse(written[0]) as Record<string, unknown>
  assert.deepEqual(Object.keys(record).sort(), ['created', 'deviceId', 'opId', 'opJson', 'seq'],
    '变更记录的字段集合变了：这是**跨设备**的格式，改它要让 `docs/03` §14.2 与两端的读取路径一起改')
  assert.deepEqual(Object.keys(JSON.parse(String(record.opJson)) as object).sort(),
    ['blockId', 'changes', 'opId', 'previous', 'type'],
    '操作本身也进这份文件（以 JSON 字符串嵌在 opJson 里），它的字段集合同样是契约')

  // 前向兼容：以后给记录加字段，旧版本只忽略、不许整行判废。
  const readBack: SyncFileIo = {
    async append() {},
    async readOthers() { return [{ deviceId: 'device-a', lines: [JSON.stringify({ ...record, futureField: 'na' })] }] },
  }
  const result = await new DirectorySyncPort(readBack, () => '/shared', async () => 'device-b').exchange([], {})
  assert.equal(result.incoming.length, 1, '带未知字段的行照样要能读进来（前向兼容）')
  assert.equal(result.cursor['device-a'], 7, '读进来之后游标推进到这条记录的 seq')
  assert.equal(result.incoming[0].opId, 'op-1', '读回来的记录要能直接交给应用的路径消费')
})

/**
 * M3：编辑器的宿主契约（`13-编辑器模块化` §4）。
 * 文档存储是编辑器唯一必需能力；内存宿主用于裸 React 页面与 demo，必须只读写快照、不碰 Tauri。
 */
type EditorHostShape = Assert<Equals<keyof EditorHost, 'storage' | 'clipboard' | 'assets' | 'navigate' | 'theme'>>
type DocumentStoragePortShape = Assert<Equals<keyof DocumentStoragePort, 'load' | 'save'>>
void (null as unknown as EditorHostShape)
void (null as unknown as DocumentStoragePortShape)

test('M3 内存宿主：只读写快照、load/save 是副本、writes 可读', async () => {
  const page = createTextBlock({
    entityId: 'host-page', blockUid: 'host-page-0001', text: '宿主页', isObject: true, objectName: '宿主页',
  })
  const host = createMemoryEditorHost([page])

  const first = await host.storage.load()
  assert.equal(first?.length, 1)
  assert.equal(first?.[0]?.entityId, page.entityId)
  // load 返回副本：宿主调用方改它不能改内存
  const mutated = first as NonNullable<typeof first>
  mutated[0]!.objectName = '被外部改掉'
  assert.equal((await host.storage.load())?.[0]?.objectName, '宿主页')

  const next = [{ ...page, objectName: '新名字' }]
  await host.storage.save(next)
  assert.equal(host.writes, 1)
  next[0]!.objectName = '又改外部'
  assert.equal(host.read()[0]?.objectName, '新名字')
  assert.equal((await host.storage.load())?.[0]?.objectName, '新名字')

  const empty = createMemoryEditorHost()
  assert.equal(await empty.storage.load(), null)
})
