import type { FileChannelPort } from '../application/fileChannel'
import { useCallback, useEffect, useRef, useState } from 'react'

import { textContent, type Block, type MetadataRegistry } from '@moqi/editor'
import { resolveTagName } from '@moqi/editor'
import { planMarkdownExport, type ExportScope } from '@moqi/editor'
import { isoWeek, localDay, restoreStamp, type BackupPackageInfo, type BackupPort, type SnapshotInfo } from '../application/backup'
import type { BackupSummary } from './SettingsData'
import { exportWriteOf, type ExportPort } from '../application/export'
import type { AssetPort } from '../application/assets'
import type { SearchPort } from '../application/search'
import type { DomainStore } from '../application/store'
import { prefetchPinyinModule } from './usePinyinBackfill'
import { formatDate } from './format'

/**
 * 导出 / 快照 / 拼音这批「命令与 IO」（外壳拆分第八刀，2026-10-09）：**没有渲染、没有派生视图**——
 * 只有「点一下 → 调端口 → 如实报结果」。与外壳的耦合收成三样：端口（`searchPort` / `backupPort` /
 * `exportPort`，仍在外壳创建）、`notify` / `closeDialog` 两个界面动作、以及一个能力
 * `cancelPendingPersist`（恢复快照前要扔掉「等落盘的那一份」，那两个 ref 是外壳保存队列的家产）。
 * 产物 `BackupSummary` 直接就是设置页「数据与备份」卡片的 props。
 */
export type DataActionsInputs = {
  store: DomainStore
  registry: MetadataRegistry
  searchPort: SearchPort
  backupPort: BackupPort
  exportPort: ExportPort
  /**
   * 媒体资产端口（2026-10-11 审计补）：Markdown 导出要拿「磁盘上真实存在的资产名」——
   * 域层按它决定每张图是搬进包里还是降级成文件名文字（此前不传 ⇒ 导出永远不带图）。
   */
  assetPort: AssetPort
  /** 文件通道（`T-18` 第三刀）：导出侧的「另存为 / 存到文件夹」要它问用户落点。 */
  fileChannel: FileChannelPort
  /** 启动留快照的那一拍要等数据载入完（`null` = 还没载入）。 */
  initialBlocks: Block[] | null
  /** 设置弹窗是否打开（：设置不再是视图）——打开时刷新快照列表与数据目录。 */
  settingsOpen: boolean
  notify: (message: string, actionLabel?: string, onAction?: () => void) => void
  closeDialog: () => void
  /** 丢弃「等落盘的那一份」（清定时器与 pending 快照）——引用挂在保存队列上，由外壳提供。 */
  cancelPendingPersist: () => void
}

export function useDataActions(inputs: DataActionsInputs) {
  const { store, registry, searchPort, backupPort, exportPort, assetPort, fileChannel, initialBlocks, settingsOpen, notify, closeDialog, cancelPendingPersist } = inputs

  /** 0.5 数据安全（`03` §15.9）：快照列表 + 数据目录（设置页那一行读它们）。 */
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([])
  /** `exports/` 下的备份包（「从备份包恢复」列它用）——第 13 项尾巴 · 场景 B。 */
  const [packages, setPackages] = useState<BackupPackageInfo[]>([])
  const [dataDirectory, setDataDirectory] = useState<string | null>(null)
  const [exportBusy, setExportBusy] = useState(false)

  /** 「按标签批量」的标签表：活动页面里出现过的标签 + 页数（页面库筛选表同源口径）。 */
  function exportTagChoices(): { id: string; name: string; count: number }[] {
    const counts = new Map<string, number>()
    for (const block of store.read().values()) {
      if (!block.isObject || block.deleted) continue
      for (const tagId of block.tags) counts.set(tagId, (counts.get(tagId) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([id, count]) => ({ id, name: resolveTagName(id, registry), count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
  }

  /** 跑一次导出：拿 `exports/` 已有文件名 → 算计划 → 落盘 → toast 报路径（含被改名的 front-matter 键）。 */
  /**
   * 导出（`T-18` 第三刀）：`destination` 给了就**先问用户落点**——`saveAs` = 另存为（系统保存对话框）、
   * `folder` = 存到文件夹（选目录，文件名沿用 artifactName）。**取消不算失败**（静默收场）；
   * 与数据目录那条路**共用同一个写入口**（只多一个 `targetPath`），不另开通路。
   */
  async function runMarkdownExport(scope: ExportScope, destination?: { pick: 'saveAs' | 'folder' }) {
    if (!exportPort.capabilities.writeFiles) {
      notify('浏览器预览不提供文件导出（写不进数据目录），请用桌面版')
      return
    }
    if (destination && !(destination.pick === 'folder' ? fileChannel.capabilities.pickFolder : fileChannel.capabilities.saveAs)) {
      notify('这个通道没有系统保存对话框，请用桌面版')
      return
    }
    setExportBusy(true)
    try {
      const existing = await exportPort.listNames()
      // 磁盘上真实存在的资产名（判「图在不在」）：只读一次、整份导出共用；读不到就按"全缺"走降级，
      // 不许因为资产目录读失败而挡住文字导出。
      const existingAssets = await assetPort.listNames().catch(() => [])
      const plan = planMarkdownExport(store.snapshot(), registry, scope, { today: formatDate(Date.now()), existingNames: existing, existingAssets })
      if (!plan) {
        notify('这个范围里没有可导出的页面')
        return
      }
      // 落盘入参走 `exportWriteOf`：`plan.assets`（资产搬运单）必须随行——Rust 侧照它复制 / 入包。
      let target: string | undefined
      // SAF 落点（`content://`）写不了原生路径 ⇒ 先照常写 `exports/`、拿到结果再拷过去（§12.4 同一坑的写方向）。
      let safRef: string | null = null
      if (destination) {
        if (destination.pick === 'saveAs') {
          const picked = await fileChannel.saveAs(plan.artifactName)
          if (picked === null) return // 取消：静默收场（不是失败）
          if (picked.startsWith('content://')) safRef = picked
          else target = picked
        } else {
          const dir = await fileChannel.pickFolder()
          if (dir === null) return
          target = `${dir.replace(/\/+$/, '')}/${plan.artifactName}`
        }
      }
      const result = await exportPort.write(exportWriteOf(plan), target)
      if (safRef !== null) {
        await fileChannel.copyOut(result.path, safRef)
        result.path = safRef.startsWith('content://') ? `${plan.artifactName}（存到你选的位置）` : result.path
      }
      closeDialog()
    } catch (error) {
      notify(`导出失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setExportBusy(false)
    }
  }

  /**
   * V2c 路线 B：把若干块的拼音写进索引（`pinyinSourceText` 是「索引哪些内容」的单一规则，
   * 与浏览器通道共用）。**失败不打扰用户**：拼音只是多一条匹配通路，坏了不影响中文检索。
   *
   * `pinyin-pro` 按需装入（性能批 ⓒ ①：它 ≈300 KB 在主包外，首帧后趁空闲预取，
   * 见 `prefetchPinyinModule`）——这里 `await import` 拿到的就是同一份模块实例。
   */
  async function refreshPinyin(blocks: Map<string, Block>): Promise<unknown> {
    const { pinyinIndexText, pinyinSourceText } = await import('../application/pinyinSearch')
    const entries = [...blocks.values()].filter((block) => !block.deleted).map((block) => {
      const index = pinyinIndexText(pinyinSourceText(block))
      return { entityId: block.entityId, full: index.full, initials: index.initials }
    })
    if (entries.length === 0) return 0
    return searchPort.updatePinyinIndex(entries).catch(() => undefined)
  }

  /** 来源 chip 上写什么：页面给名字，块给首十字（问答范围通常是块）。 */
  const blockTitleForAsk = (blockId: string): string => {
    const block = store.get(blockId)
    if (!block) return '（已删除）'
    if (block.isObject) return block.objectName ?? '未命名页面'
    const text = textContent(block).replace(/\s+/g, ' ').trim()
    return text.length > 10 ? `${text.slice(0, 10)}…` : text || '（空块）'
  }

  /** 快照列表 + 数据目录：进设置页时读一次；「立即快照 / 恢复 / 导出」之后再读（数据变了就要重读）。 */
  const refreshBackup = useCallback(() => {
    void backupPort.list().then(setSnapshots).catch(() => setSnapshots([]))
    void backupPort.listPackages().then(setPackages).catch(() => setPackages([]))
    void backupPort.dataDirectory().then(setDataDirectory).catch(() => setDataDirectory(null))
  }, [backupPort])

  /**
   * 启动时留一份当天的快照（同一天只留一次，Rust / 浏览器通道各自保证）。
   * **失败不打扰用户**：快照是兜底，不是主流程——坏了只记一条 toast，写作照旧。
   */
  const snapshotTakenRef = useRef(false)
  useEffect(() => {
    if (snapshotTakenRef.current || initialBlocks === null) return
    snapshotTakenRef.current = true
    const now = new Date()
    void backupPort.createSnapshot(localDay(now), isoWeek(now))
      .then(() => refreshBackup())
      .catch((error: unknown) => notify(`快照没做成：${error instanceof Error ? error.message : String(error)}`))
  }, [backupPort, initialBlocks, refreshBackup]) // eslint-disable-line react-hooks/exhaustive-deps -- notify 由壳传入（身份每渲染都变）；外壳里它是函数声明、原实现也不列进依赖——ref 守门，语义不变

  useEffect(() => {
    if (settingsOpen) refreshBackup()
  }, [settingsOpen, refreshBackup])

  /**
   * 拼音模块（`pinyin-pro` ≈300 KB）在主包外、按需装入（性能批 ⓒ ①）：首帧后趁空闲先取回来——
   * 留到「首次保存 / 第一条拼音查询」才现取，下载 + 解析会正好落在写路径上。
   */
  useEffect(() => { prefetchPinyinModule() }, [])

  /** 「立即快照」：手动补一份（当天已有就是 no-op，如实告诉用户）。 */
  function takeSnapshot() {
    const now = new Date()
    void backupPort.createSnapshot(localDay(now), isoWeek(now))
      .then(() => { refreshBackup() })
      .catch((error: unknown) => notify(`快照没做成：${error instanceof Error ? error.message : String(error)}`))
  }

  /**
   * 从快照恢复：Rust 侧会**先给当前库留一份「恢复前」**再覆盖；之后把内存里的数据重载回快照那一刻。
   * 不能在「编辑中」偷偷做——这是不可逆动作，确认由卡片上的两步点击承担（`R09-SET-14`）。
   */
  function restoreFromSnapshot(name: string) {
    // 恢复之后**重载应用**（设计稿 §4.2 的原话：「覆盖主库 → 重启应用」）。
    // 为什么不能只 reloadFromStore：编辑器里还挂着「恢复前」的行内状态，重建编辑器这一拍本身就会
    // 把它再镜像回领域、排上一次保存（2026-10-05 验收实测：恢复成 2 块，紧接着又被写回 3 块、
    // 打的那一行也回来了）。整页重载是唯一把内存痕迹清干净的做法；结果用一条「启动通知」告诉用户。
    cancelPendingPersist()
    void backupPort.restore(name, restoreStamp(new Date()))
      .then(() => { window.location.reload() })
      .catch((error: unknown) => { refreshBackup(); notify(`恢复失败：${error instanceof Error ? error.message : String(error)}`) })
  }

  /**
   * 从备份包恢复（场景 B「换机器」闭环）：与快照恢复同一条路——**不可逆动作**、确认由卡片两步点击承担；
   * Rust 侧先校验（根级库 + SQLite 魔数 + blocks 表）再先留「恢复前」；成功后整页重载 + 启动通知。
   */
  function restoreFromPackage(name: string) {
    cancelPendingPersist()
    void backupPort.restorePackage(name, restoreStamp(new Date()))
      .then(() => { window.location.reload() })
      .catch((error: unknown) => { refreshBackup(); notify(`恢复失败：${error instanceof Error ? error.message : String(error)}`) })
  }

  /** 导出（整库 / 某一份快照）：落在数据目录的 `exports/` 下，路径写在 toast 里让用户找得到。 */
  function runExport(kind: 'database' | 'snapshot', fileName: string, snapshotName?: string) {
    const task = kind === 'database' ? backupPort.exportDatabase(fileName) : backupPort.exportSnapshot(snapshotName ?? '', fileName)
    void task
      .then(() => undefined)
      .catch((error: unknown) => notify(`导出失败：${error instanceof Error ? error.message : String(error)}`))
  }

  /** 导出文件名在这里拼（`墨契-备份-日期` / `墨契-快照名-日期`）——设置卡片只管点。 */
  function exportDatabase() {
    const now = new Date()
    runExport('database', `墨契-备份-${localDay(now)}`)
  }
  function exportSnapshot(name: string) {
    const now = new Date()
    runExport('snapshot', `墨契-${name.replace('.sqlite3', '')}-${localDay(now)}`, name)
  }

  const backupSummary: BackupSummary = {
    dataDirectory: backupPort.capabilities.dataDirectory ? dataDirectory : null,
    canExport: backupPort.capabilities.exportFile,
    snapshots,
    packages,
    onRestorePackage: restoreFromPackage,
    onCreateSnapshot: takeSnapshot,
    onRestoreSnapshot: restoreFromSnapshot,
    onExportDatabase: exportDatabase,
    onExportSnapshot: exportSnapshot,
  }

  return { exportTagChoices, runMarkdownExport, exportBusy, refreshPinyin, blockTitleForAsk, backupSummary }
}
