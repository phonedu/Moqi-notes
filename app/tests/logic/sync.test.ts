import assert from 'node:assert/strict'
import test from 'node:test'
import { createTextBlock, type Block, type MetadataRegistry, type PropertyDef } from '@moqi/editor'
import type { Operation, Transaction } from '@moqi/editor'
import { DomainStore } from '../../src/application/store'
import {
  DirectorySyncPort,
  incomingWins,
  operationTargetId,
  outgoingFrom,
  runSync,
  selectIncomingOperations,
  type RegistrySyncState,
  type SyncChange,
  type SyncCursor,
  type SyncFileIo,
  type SyncPort,
  type SyncResult,
} from '../../src/application/sync'

/**
 * V2b 同步协议的**第一层验收**（`docs/05` 的「跨端交付方案」：协议正确性 → 同机自动化双端用例）。
 *
 * 全部在这一层验：传输换成共享目录，但协议只认「变更集 + 游标」，所以同机两端就能把
 * 冲突、幂等、游标、坏行这几件最容易出错的事全部跑出来，不需要两台设备。
 */

const tx = (operations: Operation[], timestamp = 1000, source: Transaction['source'] = 'user') =>
  ({ id: `tx-${operations[0]?.opId ?? 'x'}`, operations, timestamp, source })

function makePage(id: string, name: string, now: number): Block {
  return createTextBlock({ entityId: id, blockUid: `${id}-uid`, text: name, isObject: true, objectName: name, now })
}

/** 共享目录的内存实现——`DirectorySyncPort` 只依赖 `SyncFileIo`，所以协议不必开窗口就能验。 */
function memoryIo(): SyncFileIo {
  const files = new Map<string, string[]>()
  return {
    async append(directory, deviceId, lines) {
      if (lines.length === 0) return
      const key = `${directory}/${deviceId}`
      files.set(key, [...(files.get(key) ?? []), ...lines])
    },
    async readOthers(directory, deviceId) {
      return [...files.entries()]
        .filter(([key]) => key.startsWith(`${directory}/`) && key !== `${directory}/${deviceId}`)
        .map(([key, lines]) => ({ deviceId: key.slice(directory.length + 1), lines }))
    },
  }
}

/** 一台「设备」：一个领域库 + 一份 oplog + 一个游标。oplog 在真应用里由 `commit_transaction` 写。 */
class Device {
  readonly store: DomainStore
  readonly oplog: SyncChange[] = []
  cursor: SyncCursor = {}
  /** A1：本机注册表与定义同步状态（真应用里住在 `storage` 元数据与 `SyncState.registry`）。 */
  registry: MetadataRegistry
  registryState: RegistrySyncState = { sent: null, cursor: {} }
  constructor(readonly deviceId: string, private readonly port: SyncPort, blocks: Block[] = [], registry: MetadataRegistry = { properties: [], tags: [] }) {
    this.store = new DomainStore(blocks)
    this.registry = registry
  }

  /** 把已应用、还没进日志的事务收进 oplog（真应用里这一步是落盘节拍里的 `commit_transaction`）。 */
  drain(): void {
    let seq = this.oplog.reduce((max, change) => Math.max(max, change.seq), 0)
    for (const transaction of this.store.takeCommittedTransactions()) {
      for (const operation of transaction.operations) {
        seq += 1
        this.oplog.push({
          deviceId: this.deviceId, seq, opId: operation.opId,
          created: transaction.timestamp, opJson: JSON.stringify(operation),
        })
      }
    }
  }

  async sync(): Promise<SyncResult> {
    this.drain()
    const result = await runSync({
      port: this.port, deviceId: this.deviceId, oplog: this.oplog, cursor: this.cursor,
      blocks: this.store.snapshot(),
      registry: this.registry,
      registryState: this.registryState,
      apply: (operations, transaction) => this.store.apply({ ...transaction, operations }),
    })
    this.cursor = result.cursor
    this.registryState = result.registry
    // 真应用里这一步是 `applyRegistry` → `storage.saveMetadata`；这里就是换掉本机这一份。
    if (result.registryMerged) this.registry = result.registryMerged
    return result
  }
}

const port = (io: SyncFileIo, deviceId: string, directory = 'shared') =>
  new DirectorySyncPort(io, () => directory, async () => deviceId)

// ---------- A1：定义随同步走（`13-属性区重规划` §7.1-A1，）----------
/** 一条属性定义：同一个 id、不同时刻的版本（合并口径 = 同 id 取 `modified` 大的整条）。 */
const propDef = (id: string, name: string, modified: number): PropertyDef =>
  ({ id, name, type: 'select', created: 1000, modified })

test('SYNC-REG-1 定义随同步走：A 建的属性与标签到了 B 之后，B 能按注册表解析名字（此前"值在、名字不在"）', async () => {
  const io = memoryIo()
  const a = new Device('dev-a', port(io, 'dev-a'), [], {
    properties: [propDef('pd1', '状态', 1000)],
    tags: [{ id: 'tg1', name: '设计', created: 1000, modified: 1000 }],
  })
  const b = new Device('dev-b', port(io, 'dev-b'))

  const page = makePage('p1', '带属性页', 1000)
  a.store.apply(tx([{
    type: 'insert', opId: 'op-insert', parentId: null,
    block: { ...page, properties: [{ defId: 'pd1', type: 'select', optionId: 'o1' }], tags: ['tg1'] },
  }]))
  await a.sync()
  const received = await b.sync()

  assert.equal(received.applied, 1, '块与值同步过去了')
  assert.equal(b.registry.properties.find((item) => item.id === 'pd1')?.name, '状态', '定义也同步过去了——面板/筛选读的就是这条通路')
  assert.equal(b.registry.tags.find((item) => item.id === 'tg1')?.name, '设计')
  assert.equal(b.store.snapshot().get('p1')?.properties[0]?.defId, 'pd1', '值在，且现在解析得出名字')
})

test('SYNC-REG-2 两端各改同一条定义：`modified` 大的整条赢，两端收敛到同一个结论', async () => {
  const io = memoryIo()
  const seed: MetadataRegistry = { properties: [propDef('pd1', '状态', 1000)], tags: [] }
  const a = new Device('dev-a', port(io, 'dev-a'), [], structuredClone(seed))
  const b = new Device('dev-b', port(io, 'dev-b'), [], structuredClone(seed))
  a.registry = { properties: [propDef('pd1', '状态二', 2000)], tags: [] } // A 改名（更晚）
  b.registry = { properties: [propDef('pd1', '状态一', 1500)], tags: [] } // B 改名（更早）

  await a.sync()
  await b.sync()
  assert.equal(b.registry.properties[0]?.name, '状态二', 'B 并进 A 的快照后采纳更晚的那条')
  await a.sync()
  assert.equal(a.registry.properties[0]?.name, '状态二', 'A 保持自己的版本（两端同一结论）')
})

test('SYNC-REG-3 不认识的行只跳过：不拖垮这一轮同步（新老构建混跑的地基）', async () => {
  const io = memoryIo()
  const a = new Device('dev-a', port(io, 'dev-a'))
  const b = new Device('dev-b', port(io, 'dev-b'))
  a.store.apply(tx([{ type: 'insert', opId: 'op-insert', block: makePage('p1', '照常同步', 1000), parentId: null }]))
  // 往 A 的文件里塞一条未来格式的行：读的人必须当没看见。
  await io.append('shared', 'dev-a', [JSON.stringify({ kind: 'future-thing', payload: 1 })])
  await a.sync()
  const received = await b.sync()
  assert.equal(received.applied, 1, '块照常同步过来')
  assert.equal(b.registry.properties.length, 0, '没有定义快照就不动本机注册表')
})

test('SYNC-EXCHANGE-1 同机双端：A 的改动交换之后出现在 B 上，且 B 的日志不重复记', async () => {
  const io = memoryIo()
  const a = new Device('dev-a', port(io, 'dev-a'))
  const b = new Device('dev-b', port(io, 'dev-b'))
  const page = makePage('p1', '共享页面', 1000)
  a.store.apply(tx([{ type: 'insert', opId: 'op-insert', block: page, parentId: null }]))

  const sent = await a.sync()
  assert.equal(sent.sent, 1, 'A 交出了自己那条变更')
  assert.equal(b.store.snapshot().has('p1'), false, '还没拉之前 B 上没有')

  const received = await b.sync()
  assert.equal(received.applied, 1, 'B 应用了 A 的变更')
  assert.equal(b.store.snapshot().get('p1')?.objectName, '共享页面')
})

test('SYNC-IDEMPOTENT-1 同一条变更被重复投递只应用一次（游标 + opId 两道）', async () => {
  const io = memoryIo()
  const a = new Device('dev-a', port(io, 'dev-a'))
  const b = new Device('dev-b', port(io, 'dev-b'))
  a.store.apply(tx([{ type: 'insert', opId: 'op-once', block: makePage('p1', '只应用一次', 1000), parentId: null }]))
  await a.sync()
  assert.equal((await b.sync()).applied, 1, '第一次拉取应用了它')

  // 再交换一次：A 没有新变更，B 的游标也已推进到那条 seq——不该再应用。
  // （B 这一轮会交出一条东西：它把刚应用的那次改动**转发**出去，这正是变更能 A→B→C
  //  传播的原因；环靠下一段的 opId 去重止住，不靠「收到就不再转发」。）
  const again = await b.sync()
  assert.equal(again.applied, 0, '游标挡住了重复应用')

  // 把 B 的游标清空（模拟游标丢失）——这时挡住重复应用的是 opId 去重
  b.cursor = {}
  const afterCursorLoss = await b.sync()
  assert.equal(afterCursorLoss.applied, 0, '游标丢了也不能重复应用')
  assert.ok(afterCursorLoss.duplicate >= 1, '它应该被记成「按 opId 去重掉的那条」，而不是被当成新变更')
})

test('SYNC-CONFLICT-1 两端改同一块：后写者胜，且两端算出同一个结论', async () => {
  const io = memoryIo()
  const seed = makePage('p1', '原始', Date.now() - 60_000)
  const a = new Device('dev-a', port(io, 'dev-a'), [structuredClone(seed)])
  const b = new Device('dev-b', port(io, 'dev-b'), [structuredClone(seed)])

  // ⚠️ 冲突判定比的是**两台的时钟读数**（`03` §14.3「按 `created`（本机时钟）比大小」），
  //    而 `block.modified` 由 `applyTransaction` 写成 `Date.now()`（`operation.ts:130`）。
  //    所以测试必须用真实量级的时间戳——拿 1000 / 2000 这种假值去比，本机时间永远赢，
  //    冲突分支根本走不到（这条踩过一次）。
  const start = Date.now()
  // ⚠️ 改的是**正文首行**不是 `objectName`：页面名是派生值，`applyTransaction` 会按首行重算，
  //    直接赋 `objectName` 会被它覆盖（`04` 的 `R04-NAME-1`）。
  a.store.apply(tx([{ type: 'update', opId: 'op-a', blockId: 'p1', changes: { content: [{ t: 'text', v: 'A 改的' }] }, previous: {} }], start))
  b.store.apply(tx([{ type: 'update', opId: 'op-b', blockId: 'p1', changes: { content: [{ t: 'text', v: 'B 改的' }] }, previous: {} }], start + 1_000))

  // 顺序有讲究：B 先交上去，A 才能在下一轮拉到它。A 单独先同步是拉不到东西的——
  // 那时 B 还没上传（这正是「交换」而不是「推送」的含义）。
  const atBUpload = await b.sync()
  assert.equal(atBUpload.applied, 0, 'B 这一轮只交自己的，A 还没上传，没得拉')

  const atA = await a.sync()
  assert.equal(atA.applied, 1, 'A 应用了 B 的那版（B 更晚）')
  assert.equal(a.store.snapshot().get('p1')?.objectName, 'B 改的', 'A 上被 B 的后写覆盖')

  const atB = await b.sync()
  assert.equal(atB.skipped >= 1, true, 'B 把 A 那版判成「本机更新」而跳过')
  assert.equal(b.store.snapshot().get('p1')?.objectName, 'B 改的', 'B 保住自己那版')

  // 再各走一轮，确认收敛（两边都是 B 的那版，且没有来回打架）
  await a.sync()
  await b.sync()
  assert.equal(a.store.snapshot().get('p1')?.objectName, 'B 改的', 'A 收敛到 B 那版')
  assert.equal(b.store.snapshot().get('p1')?.objectName, 'B 改的', 'B 保持 B 那版')
  assert.equal(a.store.canUndo(), true, '被覆盖的那一版进了撤销栈——「留旧版」不是静默丢数据')
})

test('SYNC-CONFLICT-2 时间戳相同按 deviceId 字典序定序（两端必须算出同一个结论）', async () => {
  const same = (a: string, b: string) =>
    incomingWins(1000, { deviceId: a, seq: 1, opId: 'x', created: 1000, opJson: '{}' }, b)

  assert.equal(same('dev-b', 'dev-a'), true, 'dev-b > dev-a → 远端赢')
  assert.equal(same('dev-a', 'dev-b'), false, '反过来远端就输')
  // 关键性质：两端对同一次撞车给出**相反但互补**的答案，所以最终都落在较大 deviceId 那版
  assert.notEqual(same('dev-a', 'dev-b'), same('dev-b', 'dev-a'))
})

test('SYNC-APPLY-1 远端变更只走领域事务通路：目标不在本机就跳过，不补建', async () => {
  const page = makePage('p1', '本机页面', 1000)
  const map = new Map([[page.entityId, page]])
  const changes: SyncChange[] = [
    // 本机没有 p999 —— 远端有、本机没有是合法状态，不能替用户「补回来」
    { deviceId: 'dev-b', seq: 1, opId: 'op-x', created: 5000, opJson: JSON.stringify({ type: 'update', opId: 'op-x', blockId: 'p999', changes: { objectName: '远端才有' }, previous: {} }) },
    // 本机有的 p1，远端更新 → 该应用
    { deviceId: 'dev-b', seq: 2, opId: 'op-y', created: 5000, opJson: JSON.stringify({ type: 'update', opId: 'op-y', blockId: 'p1', changes: { objectName: '远端改的' }, previous: {} }) },
  ]
  const { operations, skipped } = selectIncomingOperations(map, changes, 'dev-a')
  assert.equal(operations.length, 1, '只挑出能动的那条')
  assert.equal(skipped.length, 1, '目标不在本机的那条被跳过')
  assert.equal(operationTargetId(operations[0]), 'p1')
})

test('SYNC-QUEUE-1 outgoingFrom 只交游标之后的那段，且按 seq 升序', () => {
  const oplog: SyncChange[] = [3, 1, 2].map((seq) => ({ deviceId: 'dev-a', seq, opId: `op-${seq}`, created: 1000, opJson: '{}' }))
  assert.deepEqual(outgoingFrom(oplog, {}, 'dev-a').map((c) => c.seq), [1, 2, 3])
  assert.deepEqual(outgoingFrom(oplog, { 'dev-a': 2 }, 'dev-a').map((c) => c.seq), [3])
})

test('SYNC-APPLY-2 同一批里 insert 之后的 update 要跟着应用（否则页面同步过来了、内容是空的）', () => {
  // 对端「新建一页」再「打字」= insert + 若干 update。`selectIncomingOperations` 读的是
  // **应用之前的快照**，所以第二条针对的块在快照里还不存在——早先会被判成「目标不在本机」丢掉。
  // 同机双实例验收逮到的就是这个：B 上多了一张「未命名页面」的空卡。
  const page = makePage('p-new', '新页', Date.now())
  page.content = [{ t: 'text', v: '' }]
  const changes: SyncChange[] = [
    { deviceId: 'dev-b', seq: 1, opId: 'op-insert', created: 1_000, opJson: JSON.stringify({ type: 'insert', opId: 'op-insert', block: page, parentId: null }) },
    { deviceId: 'dev-b', seq: 2, opId: 'op-update', created: 2_000, opJson: JSON.stringify({ type: 'update', opId: 'op-update', blockId: 'p-new', changes: { content: [{ t: 'text', v: '从对端写过来的' }] }, previous: {} }) },
  ]
  const { operations, skipped } = selectIncomingOperations(new Map(), changes, 'dev-a')
  assert.equal(operations.length, 2, '两条都要应用——第二条针对的块正是本批第一条建出来的')
  assert.equal(skipped.length, 0)
})

test('SYNC-APPLY-3 整批走完：对端新建的页面连同内容一起落到本机', async () => {
  const io = memoryIo()
  const a = new Device('dev-a', port(io, 'dev-a'))
  const b = new Device('dev-b', port(io, 'dev-b'))
  const page = makePage('p-new', '新页', Date.now())
  page.content = [{ t: 'text', v: '' }]
  a.store.apply(tx([{ type: 'insert', opId: 'op-i', block: page, parentId: null }], Date.now()))
  a.store.apply(tx([{ type: 'update', opId: 'op-u', blockId: 'p-new', changes: { content: [{ t: 'text', v: '对端写的正文' }] }, previous: {} }], Date.now() + 500))

  await a.sync()
  const received = await b.sync()
  assert.equal(received.applied, 2, '两条都应用')
  assert.equal(b.store.snapshot().get('p-new')?.objectName, '对端写的正文',
    '页面连同正文一起到了——页面名 = 正文首行，名字对就说明内容对')
})

test('SYNC-CURSOR-1 没配同步位置不是错误：不抛，且游标不推进（下一拍会重交）', async () => {
  const io = memoryIo()
  const device = new Device('dev-a', port(io, 'dev-a', ''))
  device.store.apply(tx([{ type: 'insert', opId: 'op-1', block: makePage('p1', '未配置', 1000), parentId: null }]))
  const result = await device.sync()
  assert.equal(result.applied, 0, '没配置就没有东西可拉')
  assert.equal(result.skipped, 0)
  assert.deepEqual(result.cursor, {}, '关键是游标不动——没有把「已交出去」记上去，下一拍还会重交')
})

test('SYNC-BADLINE-1 一个设备写坏一行不拖垮整次同步（坏行跳过）', async () => {
  const io = memoryIo()
  const a = new Device('dev-a', port(io, 'dev-a'))
  const b = new Device('dev-b', port(io, 'dev-b'))
  a.store.apply(tx([{ type: 'insert', opId: 'op-good', block: makePage('p1', '好行', 1000), parentId: null }]))
  await a.sync()
  // 往 A 的文件里塞一行坏的（模拟写入中断）
  await io.append('shared', 'dev-a', ['{ 这不是 JSON'])

  const received = await b.sync()
  assert.equal(received.applied, 1, '好的那行照常应用')
})

// ---------- 删除跨端与离线补传（V2b 收口遗留的 ⚠️， 补）----------
// 规则住在 `docs/03` §14.5（删除的三层与墓碑）与 `docs/11` §3.15 的行为表。
// 最要紧的一条：**传播的是「已删除」状态，不是「内容被清空」这个动作**。

test('SYNC-DELETE-2 软删除跨端：A 移入回收站 → B 也进回收站，且 B 保留自己那份内容', async () => {
  const io = memoryIo()
  const start = Date.now() - 60_000
  const seed = makePage('p1', '要移走的页', start)
  const a = new Device('dev-a', port(io, 'dev-a'), [structuredClone(seed)])
  const b = new Device('dev-b', port(io, 'dev-b'), [structuredClone(seed)])

  // B 先写点自己的内容——待会儿要验证「软删除只传状态、不动对端正文」。
  b.store.apply(tx([{ type: 'update', opId: 'op-b-edit', blockId: 'p1', changes: { content: [{ t: 'text', v: 'B 自己那份' }] }, previous: {} }], start + 1_000))
  await b.sync()
  await a.sync()
  assert.equal(a.store.get('p1')?.objectName, 'B 自己那份', 'A 先收敛到 B 那份')

  // A 移入回收站：软删除是一次普通变更，随 oplog 走
  assert.deepEqual(a.store.deleteSelection(['p1']), ['p1'])
  await a.sync()

  const atB = await b.sync()
  assert.equal(atB.applied, 1, 'B 应用了「已删除」这条状态')
  const onB = b.store.get('p1')!
  assert.equal(onB.deleted, true, 'B 那边也进了回收站')
  assert.equal(onB.objectName, 'B 自己那份', 'B 的正文与页名一个字没动（层 1 不传播内容清空）')
  assert.deepEqual(b.store.deletedRoots().map((block) => block.entityId), ['p1'], 'B 的回收站里有它')
  assert.equal(a.store.get('p1')?.deleted, true, 'A 这边在回收站')
})

test('SYNC-DELETE-1 删除 vs 同时编辑：更晚的编辑胜——本端删除被覆盖，整棵子树一起翻回（规范锁；台账 D-012）', async () => {
  const io = memoryIo()
  const start = Date.now() - 60_000
  const seed = makePage('p1', '原有的页', start)
  const a = new Device('dev-a', port(io, 'dev-a'), [structuredClone(seed)])
  const b = new Device('dev-b', port(io, 'dev-b'), [structuredClone(seed)])

  const tDelete = Date.now()
  a.store.deleteSelection(['p1'])
  // B 在「还没收到删除」之前编辑了它，而且时间戳更晚 → 按 §14.3 后写者胜
  b.store.apply(tx([{ type: 'update', opId: 'op-b', blockId: 'p1', changes: { content: [{ t: 'text', v: 'B 更晚的编辑' }] }, previous: {} }], tDelete + 1_000))

  await a.sync() // A 上传删除
  await b.sync() // B 上传编辑；拉到 A 的删除 → 本机更新 → 跳过
  await a.sync() // A 拉到 B 的编辑

  assert.equal(b.store.get('p1')?.deleted, false, 'B 的页面没进回收站（它的编辑更晚，删除在 B 侧被压住）')
  assert.equal(b.store.get('p1')?.objectName, 'B 更晚的编辑')
  assert.equal(a.store.get('p1')?.objectName, 'B 更晚的编辑', 'A 的正文收敛到 B 那版（内容这一半是收敛的）')
 // 规范锁（，`docs/03` §14.5 规则 4 的推论「本端的删除被覆盖」；台账 `D-012` 走「改实现」）：
  // 赢家是更晚的 update 时，本端那次删除**整棵子树一起翻回**——同步通路合成一条 `restore` 操作，
  // 与用户点「还原」同一条语义通路（子树一起翻、逆操作成对；一次同步 = 一个事务 = 一步撤销）。
  assert.equal(a.store.get('p1')?.deleted, false, 'A 的删除被更晚的编辑覆盖——本端翻回，两端同态')
  assert.deepEqual(a.store.deletedRoots(), [], 'A 的回收站里不再有它')
})

test('SYNC-DELETE-1b 子树翻回：A 删的页面带子块，输给更晚的编辑后整棵子树一起回来（不留「根活着、子块仍删」的半态）', async () => {
  const io = memoryIo()
  const start = Date.now() - 60_000
  const page = makePage('p1', '带子块的页', start)
  page.children = ['c1']
  const child = createTextBlock({ entityId: 'c1', blockUid: 'c1-uid', text: '子块', parent: 'p1', now: start })
  const a = new Device('dev-a', port(io, 'dev-a'), [structuredClone(page), structuredClone(child)])
  const b = new Device('dev-b', port(io, 'dev-b'), [structuredClone(page), structuredClone(child)])

  const tDelete = Date.now()
  a.store.deleteSelection(['p1'])
  assert.equal(a.store.get('c1')?.deleted, true, 'A 删页面时子块一起进回收站')
  b.store.apply(tx([{ type: 'update', opId: 'op-b', blockId: 'p1', changes: { content: [{ t: 'text', v: 'B 更晚的编辑' }] }, previous: {} }], tDelete + 1_000))

  await a.sync()
  await b.sync()
  await a.sync()

  assert.equal(a.store.get('p1')?.deleted, false, 'A 的删除被覆盖——根翻回')
  assert.equal(a.store.get('c1')?.deleted, false, '子块一起翻回（不是只翻根块）')
  assert.equal(a.store.get('c1')?.parent, 'p1', '父子关系完好')
  assert.deepEqual(a.store.deletedRoots(), [], 'A 的回收站清空')
  assert.equal(b.store.get('p1')?.deleted, false, 'B 那边本来就活着')

  // 反向防过度翻：B 的编辑更早时删除赢——两端都在回收站、不翻回（SYNC-DELETE-2 的行为不变）。
  const io2 = memoryIo()
  const a2 = new Device('dev-a', port(io2, 'dev-a'), [structuredClone(page), structuredClone(child)])
  const b2 = new Device('dev-b', port(io2, 'dev-b'), [structuredClone(page), structuredClone(child)])
  const t2 = Date.now()
  b2.store.apply(tx([{ type: 'update', opId: 'op-b2', blockId: 'p1', changes: { content: [{ t: 'text', v: 'B 更早的编辑' }] }, previous: {} }], t2 - 1_000))
  a2.store.deleteSelection(['p1'])
  await a2.sync()
  await b2.sync()
  await a2.sync()
  assert.equal(a2.store.get('p1')?.deleted, true, '删除赢——A 保持删除')
  assert.equal(a2.store.get('c1')?.deleted, true, '子树保持删除')
  assert.equal(b2.store.get('p1')?.deleted, true, 'B 收到删除也进回收站')
})

test('SYNC-DELETE-3 删除 vs 还原：后写者胜，删除不覆盖对端的还原决定', async () => {
  const io = memoryIo()
  const start = Date.now() - 60_000
  const seed = makePage('p1', '会回来的页', start)
  const a = new Device('dev-a', port(io, 'dev-a'), [structuredClone(seed)])
  const b = new Device('dev-b', port(io, 'dev-b'), [structuredClone(seed)])

  a.store.deleteSelection(['p1'])
  await a.sync()
  await b.sync()
  assert.equal(b.store.get('p1')?.deleted, true, '删除先到，B 进了回收站')

  // B 在回收站里还原（比删除更晚）——恢复是一次普通变更
  assert.equal(b.store.restore('p1'), true)
  await b.sync()
  const atA = await a.sync()
  assert.equal(atA.applied, 1, 'A 应用了 B 的还原')
  assert.equal(a.store.get('p1')?.deleted, false, 'A 那边页面复活——删除不覆盖对端的还原决定')
  assert.equal(b.store.get('p1')?.deleted, false, 'B 保持已还原')
  assert.equal(a.store.get('p1')?.objectName, '会回来的页', '两端都在、内容都在')
})

test('SYNC-TOMBSTONE-2 彻底删除不传播：A 清空本机内容，B 的正文与页名一字未动', async () => {
  const io = memoryIo()
  const a = new Device('dev-a', port(io, 'dev-a'))
  const b = new Device('dev-b', port(io, 'dev-b'))
  a.store.apply(tx([{ type: 'insert', opId: 'op-i', block: makePage('p1', 'A 建的页', Date.now() - 60_000), parentId: null }]))
  await a.sync()
  await b.sync()
  assert.equal(b.store.get('p1')?.objectName, 'A 建的页')

  a.store.deleteSelection(['p1'])
  await a.sync()
  await b.sync()
  assert.equal(b.store.get('p1')?.deleted, true, '软删除先传过去')

  // 层 2：从本机彻底删除——不产生 transaction，因此不进 oplog、不参与同步
  const oplogBefore = a.oplog.length
  assert.equal(a.store.purge(['p1']), 1)
  a.drain()
  assert.equal(a.oplog.length, oplogBefore, '彻底删除没有新变更进日志')

  const atA = await a.sync()
  const atB = await b.sync()
  assert.equal(atA.sent, 0, 'A 没有新东西可交')
  assert.equal(atB.applied, 0, 'B 也没收到任何东西')
  assert.equal(b.store.get('p1')?.deleted, true, 'B 还停在「已删除」（内容清空不参与同步）')
  assert.equal(b.store.get('p1')?.objectName, 'A 建的页', 'B 的正文与页名一个字没动')
  assert.equal(a.store.snapshot().has('p1'), false, 'A 这边整行摘掉了（落盘方据此删行 / 留墓碑）')
})

test('SYNC-TOMBSTONE-3 离线很久的设备上线后收到删除状态，不会把旧副本推回来复活页面', async () => {
  const io = memoryIo()
  const a = new Device('dev-a', port(io, 'dev-a'))
  const b = new Device('dev-b', port(io, 'dev-b'))
  a.store.apply(tx([{ type: 'insert', opId: 'op-i', block: makePage('p1', '会被删的页', Date.now() - 60_000), parentId: null }]))
  await a.sync()
  await b.sync()
  // B 收到之后，它自己的 oplog 里也有这条（转发的变更）——这就是「旧副本」的来源
  b.drain()
  assert.equal(b.oplog.length, 1, 'B 的日志里有那条转发的 insert')

  // A 删掉它并上传；B 全程不上线
  a.store.deleteSelection(['p1'])
  await a.sync()

  // B 上线：一次交换——B 拉到删除并应用；A 拉到 B 的转发 insert（旧副本）
  const atB = await b.sync()
  assert.equal(atB.applied, 1, 'B 应用了删除状态')
  assert.equal(b.store.get('p1')?.deleted, true, 'B 进回收站，没有复活')
  const atA = await a.sync()
  assert.equal(atA.applied, 0, 'A 不应用 B 那条旧 insert')
  assert.ok(atA.duplicate >= 1, '旧副本按 opId 去重掉——它自己就是 A 传出去的那条，不会把页面推回来')
  assert.equal(a.store.get('p1')?.deleted, true, 'A 保持已删除（页面没有复活）')
})

test('SYNC-RETRY-1 同步目录不可写：编辑与保存照常、游标不动，恢复后自动补传', async () => {
  const io = memoryIo()
  let writable = true
  const flaky: SyncFileIo = {
    async append(directory, deviceId, lines) {
      if (!writable) throw new Error('目录不可写')
      await io.append(directory, deviceId, lines)
    },
    readOthers: (directory, deviceId) => io.readOthers(directory, deviceId),
  }
  const a = new Device('dev-a', port(flaky, 'dev-a'))
  const b = new Device('dev-b', port(io, 'dev-b'))
  a.store.apply(tx([{ type: 'insert', opId: 'op-i', block: makePage('p1', '离线前写的', Date.now() - 1_000), parentId: null }]))

  writable = false
  await assert.rejects(a.sync(), /目录不可写/, '写不进去时同步抛错（由调用方转成「离线 · N 条待同步」，不弹阻断）')
  assert.deepEqual(a.cursor, {}, '失败不推进本机游标——下一拍重交同一批（对端按 opId 幂等）')

  // 离线期间照常编辑与保存：同步失败不影响领域写入
  a.store.apply(tx([{ type: 'update', opId: 'op-u', blockId: 'p1', changes: { content: [{ t: 'text', v: '离线期间写的' }] }, previous: {} }], Date.now()))
  assert.equal(a.store.get('p1')?.objectName, '离线期间写的', '编辑照常')

  writable = true
  const recovered = await a.sync()
  assert.equal(recovered.sent, 2, '恢复后两笔变更一起补传')
  await b.sync()
  assert.equal(b.store.get('p1')?.objectName, '离线期间写的', 'B 收到离线期间写的内容')
})

test('SYNC-TOLERATE-1 一条应用不了的变更不卡死整台设备：坏组跳过计进 failed，其余组照常落地、游标照常前进', async () => {
  const io = memoryIo()
  const a = new Device('dev-a', port(io, 'dev-a'))
  const b = new Device('dev-b', port(io, 'dev-b'))
  // A 两笔事务（时间戳不同 ⇒ 两个组）。第一组在 B 上「应用不了」（模拟校验拒绝 / 结构不符）——
 // 审计：此前没有逐组保护，这一组会把整轮 runSync 抛掉 ⇒ 游标不落盘 ⇒ 每拍重拉
  // 同一批、永远停在「离线 · N 条待同步」（数据拒绝被伪装成网络问题）。
  a.store.apply(tx([{ type: 'insert', opId: 'op-bad', parentId: null, block: makePage('bad', '坏页', 1000) }], 1000))
  a.store.apply(tx([{ type: 'insert', opId: 'op-good', parentId: null, block: makePage('good', '好页', 2000) }], 2000))
  await a.sync()

  const result = await runSync({
    port: port(io, 'dev-b'), deviceId: 'dev-b', oplog: [], cursor: {}, blocks: b.store.snapshot(),
    registry: { properties: [], tags: [] }, registryState: { sent: null, cursor: {} },
    apply: (operations, transaction) => {
      if (operations.some((operation) => operationTargetId(operation) === 'bad')) throw new Error('模拟：这一组应用不了')
      b.store.apply({ ...transaction, operations })
    },
  })
  assert.equal(result.failed, 1, '坏组计进 failed——跳过要能被观察，不静默')
  assert.equal(result.applied, 1, '好组照常落地')
  assert.equal(b.store.get('good')?.objectName, '好页')
  assert.equal(b.store.get('bad'), undefined, '坏组没落进来')
  assert.equal(result.cursor['dev-a'], 2, '游标照常前进到已读的那一条——下一拍不再重拉同一批')
})

// ---------- 字段随同步：星标 / 置顶 / 嵌入来源 / aiMeta（ 次批 · 烧矩阵 ❓）----------

test('STAR-SYNC-2 星标 / 置顶随块跨端：A 端点上一页，B 端收到（此前只有降级登记、无自动用例）', async () => {
  const io = memoryIo()
  const a = new Device('dev-a', port(io, 'dev-a'))
  const b = new Device('dev-b', port(io, 'dev-b'))
  a.store.apply(tx([{ type: 'insert', opId: 'op-page', parentId: null, block: makePage('p1', '被标的页', 1000) }]))
  assert.equal(a.store.setStarred('p1', true), true, '前置：星标成功')
  assert.equal(a.store.setPinned('p1', true), true, '前置：置顶成功')

  await a.sync()
  const received = await b.sync()
  assert.ok(received.applied >= 3, '新建 + 星标 + 置顶三条都应用了')
  assert.equal(b.store.get('p1')?.starred, true, '星标随块传播（都是块字段，走同一套 update 操作）')
  assert.equal(b.store.get('p1')?.pinned, true, '置顶同理——B 端的排序也按它把这一页提前（`orderedRootIds`）')
})

test('SYNC-EMBED-1 嵌入来源随块跨端：A 端选好来源，B 端的嵌入卡能解析出源内容', async () => {
  const io = memoryIo()
  const a = new Device('dev-a', port(io, 'dev-a'))
  const b = new Device('dev-b', port(io, 'dev-b'))
  const page = makePage('p1', '宿主页', 1000)
  const target = createTextBlock({ entityId: 't1', blockUid: 't1000001', text: '被嵌入的正文' })
  const embed = createTextBlock({ entityId: 'e1', blockUid: 'e1000001', text: '', parent: 'p1' })
  embed.type = 'embed'
  embed.blockRefs = [{ type: 'embed', fromBlockId: 'e1', targetBlockId: 't1' }]
  a.store.apply(tx([
    { type: 'insert', opId: 'op-page', parentId: null, block: page },
    { type: 'insert', opId: 'op-target', parentId: null, block: target },
    { type: 'insert', opId: 'op-embed', parentId: 'p1', block: embed },
  ]))

  await a.sync()
  await b.sync()
  const got = b.store.get('e1')
  assert.equal(got?.blockRefs.find((ref) => ref.type === 'embed')?.targetBlockId, 't1', '嵌入引用（块的字段）随 oplog 过去')
  assert.ok(b.store.embedView('e1') !== null, 'B 端按引用解析得出源内容——嵌入卡不是空壳')
})

test('SYNC-AIMETA-1 AI 块元数据随块跨端：动作 / 状态 / 来源绑定一起过去', async () => {
  const io = memoryIo()
  const a = new Device('dev-a', port(io, 'dev-a'))
  const b = new Device('dev-b', port(io, 'dev-b'))
  const page = makePage('p1', '带 AI 块的页', 1000)
  const ai = createTextBlock({ entityId: 'ai1', blockUid: 'ai100001', text: '总结结果', parent: 'p1' })
  ai.aiMeta = { action: 'summary', status: 'complete', sourceBlockIds: ['p1'] }
  a.store.apply(tx([
    { type: 'insert', opId: 'op-page', parentId: null, block: page },
    { type: 'insert', opId: 'op-ai', parentId: 'p1', block: ai },
  ]))

  await a.sync()
  await b.sync()
  const got = b.store.get('ai1')?.aiMeta
  assert.equal(got?.action, 'summary', '动作随行')
  assert.equal(got?.status, 'complete', '状态随行（B 端显示的不是「丢了来源的普通块」）')
  assert.deepEqual(got?.sourceBlockIds, ['p1'], '来源绑定随行（来源标签与对账都读它）')
})
