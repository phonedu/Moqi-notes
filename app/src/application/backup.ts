/**
 * 数据安全端口（`docs/03` §15.9；用户 2026-10-05 裁决排 0.5 第一项）。
 *
 * **本地快照**（自动，同盘）× **整库导出**（手动，可带走）× **异地副本引导**（把同步位置指到云盘）
 * ——三者互补，让每一种丢失都有恢复路径（设计稿：13-数据安全设计（已归档））。
 *
 * 两条通路的边界（如实写在端口上，界面据此显示）：
 * - 桌面 / Android：走 Rust 命令（`VACUUM INTO` 产出一致的单文件副本，不停写、不用管 WAL）；
 * - 浏览器预览：快照存在 `localStorage` 里（够跑通界面流程与验收），**导出与数据目录不可用**。
 */
export type SnapshotKind = 'daily' | 'weekly' | 'restore'

export type SnapshotInfo = {
  name: string
  kind: SnapshotKind
  sizeBytes: number
  /** 文件修改时间（毫秒）——排序与显示只用它，不从名字反推。 */
  modifiedMs: number
}

/** 导出的落点：路径 + 大小——界面要显示路径，用户才找得到。 */
export type ExportResult = { path: string; sizeBytes: number }

/** \`exports/\` 下的一条**备份包**（含根级 \`project-b.sqlite3\` 的 .zip）——「从备份包恢复」列它用。 */
export type BackupPackageInfo = { name: string; sizeBytes: number; modifiedMs: number }

/** 从备份包恢复的报告：后悔药快照名 + 落回的资产数。 */
export type PackageRestoreResult = { regret: string; assets: number }

export interface BackupPort {
  /** 能力如实上报：界面按它决定哪些按钮能点、并说明原因（不许装作能用）。 */
  capabilities: { snapshots: boolean; exportFile: boolean; dataDirectory: boolean }
  /**
   * 建今天的快照（今天已有则 no-op 返回 null）。`day` = `YYYY-MM-DD`，`week` = `YYYY-Www`：
   * 由**界面按本地时间**算好传进来——时间来源只有一处，Rust 不引日历库。
   */
  createSnapshot(day: string, week: string): Promise<SnapshotInfo | null>
  list(): Promise<SnapshotInfo[]>
  /** 从快照恢复（实现里**先给当前库留一份后悔药**再覆盖）；调用方负责重载数据。 */
  restore(name: string, stamp: string): Promise<void>
  /** 当前库 → 数据目录下 （只收文件名，路径由实现拼）。 */
  exportDatabase(fileName: string): Promise<ExportResult>
  /** 某一份快照 → 数据目录下 。 */
  exportSnapshot(name: string, fileName: string): Promise<ExportResult>
  /** \`exports/\` 下的备份包列表（「两种 zip 分不清」在这一层就分开：只列含根级库的包）。 */
  listPackages(): Promise<BackupPackageInfo[]>
  /**
   * 从备份包恢复（第 13 项尾巴 · 场景 B「换机器」闭环）：Rust 侧**先校验**（根级库 + SQLite
   * 魔数 + \`blocks\` 表）再**先留「恢复前」**、换库并落 \`assets/\`；调用方负责重载数据。
   */
  restorePackage(name: string, stamp: string): Promise<PackageRestoreResult>
  dataDirectory(): Promise<string | null>
}

/** 本地日期串（`YYYY-MM-DD`）——快照文件名与「今天有没有留过」的判据。 */
export function localDay(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/**
 * ISO 周串（`YYYY-Www`）——周一算一周的开始，跨年周按 ISO 规则归到有那一年星期四的那一周。
 * 为什么自己算：不引日历库（前端也只有这一处需要周），而 `Date` 的 `getDay()` 一周从周日算起。
 */
export function isoWeek(at: Date): string {
  const date = new Date(Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()))
  const day = date.getUTCDay() || 7 // 周日 → 7，好让「周四」判定统一
  date.setUTCDate(date.getUTCDate() + 4 - day) // 挪到本周四
  const year = date.getUTCFullYear()
  const yearStart = new Date(Date.UTC(year, 0, 1))
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** 恢复前那份后悔药的文件名戳（文件名安全，不含冒号）。 */
export function restoreStamp(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${localDay(at)}T${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
}

/** 载入失败屏要的一行（`G-34` 最小步；行构件的家在界面，序与文案的判据住这里）。 */
export type RecoveryRow = { name: string; kindLabel: string; meta: string }

/**
 * 快照列表 → 恢复屏展示序（`LOAD-RECOVER-1` 看住）：**新的在前**（最可能救回来的先给），
 * 标签按类型（日 / 周 / 恢复前后悔药），meta = 大小 + 本地时间。
 * 纯函数住端口家族——与 `localDay` / `isoWeek` / `restoreStamp` 同一条分工（界面只画不判）。
 */
export function recoveryRows(snapshots: SnapshotInfo[]): RecoveryRow[] {
  const kindLabelOf = (kind: SnapshotKind): string =>
    kind === 'weekly' ? '周快照' : kind === 'restore' ? '恢复前后悔药' : '日快照'
  const sizeLabelOf = (bytes: number): string =>
    bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
  return [...snapshots]
    .sort((left, right) => right.modifiedMs - left.modifiedMs)
    .map((snapshot) => ({
      name: snapshot.name,
      kindLabel: kindLabelOf(snapshot.kind),
      meta: `${sizeLabelOf(snapshot.sizeBytes)} · ${new Date(snapshot.modifiedMs).toLocaleString()}`,
    }))
}
