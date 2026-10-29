import type { BlockMap, MetadataRegistry } from '@moqi/editor'
import type { DeleteSnapshot, Operation, Transaction } from '@moqi/editor'

/**
 * V2b：同步协议（`docs/03` §14.2）。**协议与传输解耦**——只认「变更集 + 游标」，
 * 不认传输方式；换自建服务或网盘只换 `SyncPort` 实现，这一层不动。
 *
 * 变更集的来源是本机的 `oplog`（`commit_transaction` 写进去的），所以这里**不碰存储**。
 */

/** 每台设备（含本机自己）已经推进到第几条 `seq`。本机那一项 = 「已交出去到第几条」。*/
export type SyncCursor = Record<string, number>

/** 一条变更。`opJson` 就是 `oplog.op_json` 的原文，原样搬运、不重新序列化。*/
export type SyncChange = {
  deviceId: string
  seq: number
  opId: string
  created: number
  opJson: string
}

export type ChangeSet = { changes: SyncChange[]; cursor: SyncCursor }

/**
 * 定义快照行（A1，）：**注册表随同步走**。
 *
 * 背景：属性与标签的**值**按 `defId` 挂在块上、随块 op 同步；而**定义**此前只住本机
 * `app_metadata`——二端就会「值在、名字不在」：面板不显示、筛选认不出、导出缺键
 * （`属性区重规划（已归档）` §7.1-A1）。这一行把定义也带过去。
 *
 * 形态取**全量快照**而不是逐条 op：定义是追加型的小集合（几十条量级），快照幂等、无定序问题；
 * 合并口径 = **按 id 求并、同 id 取 `modified` 大的整条**（含它的选项表）。
 * **删除的同步留待 `属性区重规划（已归档）` 第三刀**（要先有墓碑）——本轮只建不删，不会丢东西。
 *
 * 兼容：老构建读到这一行会因缺 `seq/opId/opJson` 而**跳过**（reader 的既有字段校验），
 * 新构建读到老文件则没有这一行可收——两个方向都安全。
 */
export type SyncRegistryLine = {
  kind: 'registry'
  deviceId: string
  /** 该设备自增的快照版本（只增；接收端按它推进 `registryCursor`）。 */
  version: number
  registry: MetadataRegistry
}

/** 定义同步的本机状态（随 `SyncState` 落盘）。 */
export type RegistrySyncState = {
  /** 本机最后交出去的快照（版本 + 指纹）；指纹没变就不重复交。 */
  sent: { version: number; stamp: string } | null
  /** 每台设备的定义快照已并进本机到第几版。 */
  cursor: Record<string, number>
}

/** 注册表指纹：条数 + 最大 `modified`——变了就交一份新快照。 */
export function registryStamp(registry: MetadataRegistry): string {
  const all = [...registry.properties, ...registry.tags]
  const maxModified = all.reduce((max, item) => Math.max(max, item.modified), 0)
  return `${registry.properties.length}:${registry.tags.length}:${maxModified}`
}

/**
 * 合并远端定义快照（纯函数）：**按 id 求并、同 id 取 `modified` 大的整条**。
 * 整条取用（而不是逐字段 / 逐选项合并）让"改名 / 加选项"这类定义级动作天然是
 * "最后一次改的赢"，也让合并可重复执行、结果确定（两端算出同一个结论）。
 */
export function mergeRegistries(local: MetadataRegistry, remote: MetadataRegistry): MetadataRegistry {
  const union = <T extends { id: string; modified: number }>(left: T[], right: T[]): T[] => {
    const out = new Map(left.map((item) => [item.id, item]))
    for (const item of right) {
      const mine = out.get(item.id)
      if (!mine || item.modified > mine.modified) out.set(item.id, item)
    }
    return [...out.values()]
  }
  return {
    properties: union(local.properties, remote.properties),
    tags: union(local.tags, remote.tags),
  }
}

function isRegistryLine(value: unknown): value is SyncRegistryLine {
  if (typeof value !== 'object' || value === null) return false
  const line = value as Partial<SyncRegistryLine>
  return line.kind === 'registry'
    && typeof line.deviceId === 'string'
    && typeof line.version === 'number'
    && typeof line.registry === 'object' && line.registry !== null
}

export interface SyncPort {
  /**
   * 把自己的变更交出去、把别人的变更取回来；游标 = 「我已知的每台设备的进度」。
   * `registryLine` = 这一轮要附带的定义快照（`null` = 指纹没变、不用重发）；
   * `registries` = 各设备文件里**最新**的一条定义快照（每台最多一条）。
   */
  exchange(
    outgoing: SyncChange[],
    cursor: SyncCursor,
    registryLine: SyncRegistryLine | null,
  ): Promise<{ incoming: SyncChange[]; registries: SyncRegistryLine[]; cursor: SyncCursor }>
}

/**
 * 文件读写的最小接口。`DirectorySyncPort` 只依赖它——测试与浏览器通道可以注入内存实现，
 * 真应用注入走 Tauri 命令的那份。**这样协议本身不必开窗口就能验。**
 */
export type SyncFileIo = {
  /** 追加到 `<deviceId>.jsonl`（只追加，不改别人的文件）。 */
  append(directory: string, deviceId: string, lines: string[]): Promise<void>
  /** 读回**其他设备**的变更文件；本机自己的那份不在结果里。 */
  readOthers(directory: string, deviceId: string): Promise<{ deviceId: string; lines: string[] }[]>
}

/**
 * `docs/03` §14.2 的第一版传输：**共享目录**（云盘 / 局域网共享 / 同机两个实例共用的文件夹）。
 *
 * 每台设备一个 `<deviceId>.jsonl`，只追加自己产生的变更；拉取 = 读别人的文件、跳过游标之前的行。
 * 两台实例各写各的文件，所以不需要锁，也不会互相覆盖。
 */
export class DirectorySyncPort implements SyncPort {
  constructor(
    private readonly io: SyncFileIo,
    private readonly directory: () => string,
    private readonly deviceId: () => Promise<string>,
  ) {}

  async exchange(
    outgoing: SyncChange[],
    cursor: SyncCursor,
    registryLine: SyncRegistryLine | null = null,
  ): Promise<{ incoming: SyncChange[]; registries: SyncRegistryLine[]; cursor: SyncCursor }> {
    const me = await this.deviceId()
    const directory = this.directory()
    const next: SyncCursor = { ...cursor }
    // 没配同步位置不是错误（`docs/03` §14.4「不可用 ≠ 错误」）——原样返回，让调用方
    // 去显示「未配置」。这里刻意不抛，否则每次节拍都会在界面上炸一次。
    if (!directory) return { incoming: [], registries: [], cursor: next }

    const outgoingLines = outgoing.map((change) => JSON.stringify(change))
    // 定义快照与变更同车（A1）：定义侧自带版本，不占 `seq` 空间、也不动变更游标的算法。
    if (registryLine) outgoingLines.push(JSON.stringify(registryLine))
    await this.io.append(directory, me, outgoingLines)
    // 交出去了才推进本机的游标：append 抛错时它不动，下一拍会重交同一批（对端按 opId 幂等）。
    if (outgoing.length > 0) {
      next[me] = outgoing.reduce((max, change) => Math.max(max, change.seq), next[me] ?? 0)
    }

    const incoming: SyncChange[] = []
    const registries = new Map<string, SyncRegistryLine>()
    for (const file of await this.io.readOthers(directory, me)) {
      const applied = next[file.deviceId] ?? 0
      let maxSeq = applied
      for (const line of file.lines) {
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          continue // 坏行跳过：一个写坏的行不该拖垮整台设备的同步
        }
        // 定义快照行（A1）：全量、可重复读，与 `seq` 游标无关——按设备取版本最高的一条。
        // 老构建走到这里会因为下面那行字段校验不过而跳过：**不认识就不动它**，这正是要的兼容。
        if (isRegistryLine(parsed)) {
          if (parsed.deviceId !== file.deviceId) continue // 归属对不上就当没看见（同变更行的规矩）
          const best = registries.get(file.deviceId)
          if (!best || parsed.version > best.version) registries.set(file.deviceId, parsed)
          continue
        }
        const change = parsed as SyncChange
        if (typeof change?.seq !== 'number' || typeof change?.opId !== 'string' || typeof change?.opJson !== 'string') continue
        // 归属对不上就当没看见——文件名是设备身份，行里的 deviceId 必须与它一致。
        if (change.deviceId !== file.deviceId) continue
        maxSeq = Math.max(maxSeq, change.seq)
        if (change.seq <= applied) continue // 游标之前：我早就应用过了
        incoming.push(change)
      }
      next[file.deviceId] = maxSeq
    }
    return { incoming, registries: [...registries.values()], cursor: next }
  }
}

/** 本机 `oplog` 里「还没交出去」的那段，按 `seq` 升序。*/
export function outgoingFrom(oplog: SyncChange[], cursor: SyncCursor, deviceId: string): SyncChange[] {
  const sent = cursor[deviceId] ?? 0
  return oplog
    .filter((change) => change.seq > sent)
    .sort((left, right) => left.seq - right.seq)
}

/** 一条操作动的是哪个块——`insert` 动的是它自己要建的块，引用类操作动的是发起方。*/
export function operationTargetId(operation: Operation): string | null {
  switch (operation.type) {
    case 'insert':
      return operation.block.entityId
    case 'update':
    case 'delete':
    case 'restore':
    case 'move':
    case 'collapse':
      return operation.blockId
    case 'block-ref':
    case 'block-unref':
    case 'object-ref':
    case 'object-unref':
      return operation.fromId
    default:
      return null
  }
}

/**
 * 远端这一条该不该赢（`docs/03` §14.3 的**块级后写者胜**）。
 *
 * - 比 `created` 与目标块本机的 `modified`：**大的赢**。
 * - 时间戳相同则按 `deviceId` 字典序——**这条是为了让两端算出同一个结论**。
 *   不这么做的话，两端会各自认为「我这版更新」，于是谁都不应用对方的改动，永远不收敛。
 */
export function incomingWins(localModified: number, change: SyncChange, localDeviceId: string): boolean {
  if (change.created !== localModified) return change.created > localModified
  return change.deviceId > localDeviceId
}

/**
 * 从远端变更里挑出**该应用的操作**，其余归入 `skipped`。
 *
 * 跳过是正常的、要能被观察，不是错误：目标块在本机不存在（远端有、本机没有是合法状态）、
 * 本机版本更新（后写者胜，本机就是那个「后写者」）、或者操作体本身解析不了。
 * **不在这里应用**——返回操作列表，由调用方走领域的事务通路，这样冲突判定是纯函数、可单测。
 */
export function selectIncomingOperations(
  blocks: BlockMap,
  changes: SyncChange[],
  localDeviceId: string,
): { operations: Operation[]; applied: SyncChange[]; skipped: SyncChange[] } {
  const operations: Operation[] = []
  const applied: SyncChange[] = []
  const skipped: SyncChange[] = []
  /**
   * 这一批里**刚被 `insert` 建出来**的块。
   *
   * ⚠️ 没有它就会丢内容：`selectIncomingOperations` 在应用**之前**读快照，而一次同步拉到的
   * 是一串变更——对端「新建一页」再「打字」会产生 `insert` 加若干 `update`，后者针对的块在
   * 本机快照里还不存在，会被判成「目标不在本机」而全部丢掉。表现是**页面同步过来了、内容是空的**
   * （V2b 同机双实例验收逮到的）。
   */
  const bornInBatch = new Set<string>()

  for (const change of changes) {
    let operation: Operation
    try {
      operation = JSON.parse(change.opJson) as Operation
    } catch {
      skipped.push(change)
      continue
    }
    const targetId = operationTargetId(operation)
    if (!targetId) {
      skipped.push(change)
      continue
    }
    const local = blocks.get(targetId)
    if (!local) {
      if (operation.type === 'insert') {
        bornInBatch.add(targetId)
        operations.push(operation)
        applied.push(change)
        continue
      }
      if (!bornInBatch.has(targetId)) {
        // 目标不在本机：只有 `insert` 能把它建出来，别的操作无从应用。
        // 本地没有这一块**不是**要补建它——那会让「我删了、你还有」变成「它又回来了」。
        skipped.push(change)
        continue
      }
      // 本批刚建出来的块：后续更新直接跟着应用，不参与时间戳比较
      // （它本机还没有「上一次改动」可比）。
      operations.push(operation)
      applied.push(change)
      continue
    }
    // 目标在本机回收站里：本机的软删除也是一次变更，同样走「后写者胜」。
    const baseline = local.deleted ? (local.deletedAt ?? local.modified) : local.modified
    if (!incomingWins(baseline, change, localDeviceId)) {
      skipped.push(change)
      continue
    }
    operations.push(operation)
    applied.push(change)
  }
  return { operations, applied, skipped }
}

/**
 * 本机软删除块 `id` 所属「那次删除的根」：沿父链上溯到最高的 `deleted` 祖先。
 * 目标自己不在删除态（或不在图里）→ `null`（没有要翻回的东西）。
 */
function deletedSubtreeRoot(blocks: BlockMap, id: string): string | null {
  const self = blocks.get(id)
  if (!self || !self.deleted) return null
  let root = id
  let parentId = self.parent
  while (parentId) {
    const parent = blocks.get(parentId)
    if (!parent || !parent.deleted) break
    root = parentId
    parentId = parent.parent
  }
  return root
}

/**
 * 「那次删除」整棵子树翻回的一条 `restore` 操作（`docs/03` §14.5 规则 4 的推论；台账 `D-012`）。
 *
 * 快照不必另外取存：软删除时 `applyDelete` 已把 `prevParent` / `prevIndex` 写进**每个**被删的块——
 * 那就是「那次删除事务的快照」在块图上的等价物；这里逐块读回来，走与用户点「还原」**同一条**语义通路
 * （子树一起翻、逆操作成对、撤销 / 落盘 / 转发全部免费）。
 */
function synthesizedRestore(blocks: BlockMap, rootId: string): Operation {
  const snapshots: DeleteSnapshot[] = []
  const walk = (id: string): void => {
    const block = blocks.get(id)
    if (!block || !block.deleted) return
    snapshots.push({ blockId: id, prevParent: block.prevParent ?? null, prevIndex: block.prevIndex ?? 0 })
    for (const childId of block.children) walk(childId)
  }
  walk(rootId)
  return { type: 'restore', opId: crypto.randomUUID(), blockId: rootId, snapshots }
}

export type SyncResult = {
  /** 交出去的变更条数。*/ sent: number
  /** 应用进来的变更条数（不含应用失败的）。*/ applied: number
  /** 被本机版本压住的条数（后写者胜里本机是赢家）。*/ skipped: number
  /**
  * **应用失败的变更条数**（ 审计）：应用一批远端变更时，某组抛错（校验拒绝 / 目标块不在
   * 本机）不再拖垮整轮——坏组整组跳过（`store.apply` 原子回滚）、条数在这里如实上报，其余组照常
   * 落地、游标照常前进（G-26「合并结果要能看见」同一家族；界面呈现并入 W3 批）。
   */
  failed: number
  /** 本机 `oplog` 里已经有、按 `opId` 去重掉的条数。*/ duplicate: number
  cursor: SyncCursor
  /** 这一轮并进本机的定义（非 null 时调用方要写回注册表并落盘；null = 没有变化）。 */
  registryMerged: MetadataRegistry | null
  /** 定义同步的本机状态（调用方随 `SyncState` 落盘）。 */
  registry: RegistrySyncState
}

/**
 * 走一次同步：取本机未交出的变更 → 交换 → 按 `opId` 去重 → 挑出该应用的 → 交给调用方应用。
 *
 * **本地优先**（`docs/03` §14.4）：任何一步失败都不影响编辑——调用方负责把异常变成
 * 「离线 · N 条待同步」这类可观察状态，而不是阻断写入。
 */
export async function runSync(options: {
  port: SyncPort
  deviceId: string
  oplog: SyncChange[]
  cursor: SyncCursor
  blocks: BlockMap
  apply: (operations: Operation[], transaction: Omit<Transaction, 'inverse'>) => void
  /** 本机当前的注册表（A1：定义随同步走）。 */
  registry: MetadataRegistry
  /** 定义同步的本机状态（版本 / 指纹 / 设备游标）。 */
  registryState: RegistrySyncState
  now?: number
}): Promise<SyncResult> {
  const { port, deviceId, oplog, cursor, blocks, apply, registry, registryState } = options
  const outgoing = outgoingFrom(oplog, cursor, deviceId)
  // 定义快照（A1）：指纹变了（或从未交过）才重发——定义很少变，重发的只是同一份小 JSON。
  const stamp = registryStamp(registry)
  const registryLine: SyncRegistryLine | null = registryState.sent?.stamp === stamp
    ? null
    : { kind: 'registry', deviceId, version: (registryState.sent?.version ?? 0) + 1, registry }
  const exchanged = await port.exchange(outgoing, cursor, registryLine)
  // 收远端定义：按版本升序逐个并（合并幂等、可重复执行），游标推进到已并过的最高版本。
  // 并完之后本机注册表的指纹就变了，下一轮会自动把并集再交出去——三台设备靠这条中继收敛。
  let mergedRegistry = registry
  const registryCursor = { ...registryState.cursor }
  for (const remote of [...exchanged.registries].sort((left, right) => left.version - right.version)) {
    if (remote.version <= (registryCursor[remote.deviceId] ?? 0)) continue
    mergedRegistry = mergeRegistries(mergedRegistry, remote.registry)
    registryCursor[remote.deviceId] = remote.version
  }
  const registryMerged = JSON.stringify(mergedRegistry) !== JSON.stringify(registry) ? mergedRegistry : null
  const nextRegistryState: RegistrySyncState = {
    sent: registryLine ? { version: registryLine.version, stamp } : registryState.sent,
    cursor: registryCursor,
  }
  // `opId` 是 `oplog` 的主键，也是**幂等的第二道**：游标管「别重读旧行」，它管「游标丢了
  // 也别重复应用」——去重后重复投递无副作用（§14.2）。
  const known = new Set(oplog.map((change) => change.opId))
  const fresh = exchanged.incoming.filter((change) => !known.has(change.opId))
  const duplicate = exchanged.incoming.length - fresh.length
  const { operations, applied, skipped } = selectIncomingOperations(blocks, fresh, deviceId)
  /** 应用失败的**变更条数**（见下方逐组 try/catch）：坏组整组跳过不拖垮整轮，条数如实上报。 */
  let failed = 0
  if (operations.length > 0) {
    // **按来源事务的时间戳分组**：一次同步拉到的是一串变更，往往来自对端的多次编辑。
    // 每组的块要用**那一组自己的** `created` 落账——否则旧变更会拿到新时间戳，
    // 之后对端更晚的改动会被误判成「本机更新」而丢掉（`03` §14.3 比的就是时间戳）。
    // 同一次来源事务的 `created` 相同（`commit_transaction` 按事务写），所以分组数 = 来源事务数。
    const groups = new Map<number, { operations: Operation[]; opIds: string[] }>()
    for (let index = 0; index < operations.length; index += 1) {
      const change = applied[index]
      const group = groups.get(change.created) ?? { operations: [], opIds: [] }
      group.operations.push(operations[index])
      group.opIds.push(change.opId)
      groups.set(change.created, group)
    }
  // ---- 台账 `D-012`（）：本机删除输给更晚的远端操作时，把那次删除的整棵子树一起翻回 ----
    // `docs/03` §14.5 规则 4 的推论是「本端的删除被覆盖」；此前实现只覆盖了**内容字段**，
    // `deleted` 标记留在本机 ⇒ 同一页在对面活着、在本机躺在回收站（两端不同态）。
    // 范围按裁决原文 = 更晚的远端 **`update`**（其余操作类型若以后也认「删除被覆盖」，先回台账）。
    // 合成的 `restore` 进**同一组**（同一来源事务的 timestamp）——一次同步 = 一个事务 = 一步撤销。
    const restoredRoots = new Set<string>()
    for (const [, group] of groups) {
      for (const operation of [...group.operations]) {
        if (operation.type !== 'update') continue
        const targetId = operationTargetId(operation)
        if (!targetId) continue
        const root = deletedSubtreeRoot(blocks, targetId)
        if (!root || restoredRoots.has(root)) continue
        restoredRoots.add(root)
        group.operations.push(synthesizedRestore(blocks, root))
      }
    }
    for (const [created, group] of [...groups].sort((left, right) => left[0] - right[0])) {
      // **逐组独立应用**：一条应用不了的变更（校验拒绝 / 目标块不在本机）不该卡住整台设备。
      // 以前这里没有逐组保护，一组抛错会让整轮 `runSync` 冒泡到调用方的 catch ⇒ 游标不落盘
      // ⇒ 每一拍重拉同一批、永远停在「离线 · N 条待同步」——把**数据拒绝伪装成网络问题**
   // （ 审计）。现在：坏组计入 `failed` 跳过，其余组照常落地、游标照常前进；
      // 「跳过」是可以被观察的，不许静默（与 G-29 同一口径）。
      try {
        apply(group.operations, {
          id: `sync:${deviceId}:${group.opIds[0] ?? created}`,
          operations: group.operations,
          timestamp: created,
          // 来源标 `sync`：落进 `transaction_history` 之后，用户能在历史里翻到、也能 ⌘Z 退回
          // 「被覆盖的那一版」——这就是 §14.3 说的「留旧版」。
          source: 'sync',
        })
      } catch {
        // 整组原子回滚（`store.apply` 的工作副本语义）：这一组的**变更条数**都算失败。
        failed += group.operations.length
      }
    }
  }
  return {
    sent: outgoing.length,
    applied: operations.length - failed,
    skipped: skipped.length,
    failed,
    duplicate,
    cursor: exchanged.cursor,
    registryMerged,
    registry: nextRegistryState,
  }
}
