/**
 * `BackupPort` 的两条实现（`docs/03` §15.9）。
 *
 * - `TauriBackupPort`：走 Rust 命令（`VACUUM INTO`；保留策略与服务端一样在 Rust 里）。
 * - `BrowserBackupPort`：浏览器预览用——快照存在 `localStorage`（够跑通界面流程与验收），
 *   **导出与数据目录如实上报不可用**（`capabilities` 里为 false，界面据此禁用并说明原因）。
 */
import type { BackupPackageInfo, BackupPort, ExportResult, PackageRestoreResult, SnapshotInfo, SnapshotKind } from '../application/backup'

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

type NativeSnapshot = { name: string; kind: string; sizeBytes: number; modifiedMs: number }

export class TauriBackupPort implements BackupPort {
  capabilities = { snapshots: true, exportFile: true, dataDirectory: true }

  constructor(private readonly invoke: Invoke) {}

  private static toInfo(raw: NativeSnapshot): SnapshotInfo {
    const kind: SnapshotKind = raw.kind === 'weekly' ? 'weekly' : raw.kind === 'restore' ? 'restore' : 'daily'
    return { name: raw.name, kind, sizeBytes: raw.sizeBytes, modifiedMs: raw.modifiedMs }
  }

  async createSnapshot(day: string, week: string): Promise<SnapshotInfo | null> {
    const made = await this.invoke<NativeSnapshot | null>('create_snapshot', { day, week })
    return made ? TauriBackupPort.toInfo(made) : null
  }

  async list(): Promise<SnapshotInfo[]> {
    const rows = await this.invoke<NativeSnapshot[]>('list_snapshots')
    return rows.map((row) => TauriBackupPort.toInfo(row))
  }

  async restore(name: string, stamp: string): Promise<void> {
    await this.invoke<void>('restore_snapshot', { name, stamp })
  }

  /** 当前库 → `exports/<fileName>`（只收文件名，路径由 Rust 拼）；返回落点与大小。 */
  async exportDatabase(fileName: string): Promise<ExportResult> {
    return this.invoke<ExportResult>('export_backup', { fileName })
  }

  /** 某一份快照 → `exports/<fileName>`；返回落点与大小。 */
  async exportSnapshot(name: string, fileName: string): Promise<ExportResult> {
    return this.invoke<ExportResult>('export_snapshot', { name, fileName })
  }

  async dataDirectory(): Promise<string | null> {
    return this.invoke<string>('data_directory')
  }

  async listPackages(): Promise<BackupPackageInfo[]> {
    return this.invoke<BackupPackageInfo[]>('list_backup_packages')
  }

  async restorePackage(name: string, stamp: string): Promise<PackageRestoreResult> {
    return this.invoke<PackageRestoreResult>('restore_backup_package', { name, stamp })
  }
}

const KEY_PREFIX = 'moqi-project-b:snapshot:'
const BLOCKS_KEY = 'moqi-project-b:blocks'

/**
 * 浏览器通道的快照：把整份块表序列化进 `localStorage`（键 = `…:snapshot:<name>`）。
 * 它**不是**给生产用的备份（同盘同浏览器 ✗），存在的理由是让界面流程与验收在浏览器通道里能跑通——
 * 与 `BrowserSearchPort` 同一个定位：**语义对齐，能力如实上报**。
 */
export class BrowserBackupPort implements BackupPort {
  capabilities = { snapshots: true, exportFile: false, dataDirectory: false }

  private entries(): SnapshotInfo[] {
    const out: SnapshotInfo[] = []
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (!key || !key.startsWith(KEY_PREFIX)) continue
      const name = key.slice(KEY_PREFIX.length)
      const raw = localStorage.getItem(key) ?? '[]'
      const kind: SnapshotKind = name.startsWith('restore-backup-') ? 'restore' : name.includes('-W') ? 'weekly' : 'daily'
      out.push({ name, kind, sizeBytes: raw.length, modifiedMs: 0 })
    }
    return out.sort((left, right) => right.name.localeCompare(left.name))
  }

  async createSnapshot(day: string, week: string): Promise<SnapshotInfo | null> {
    const blocks = localStorage.getItem(BLOCKS_KEY) ?? '[]'
    const written: string[] = []
    for (const name of [`${day}.sqlite3`, `${week}.sqlite3`]) {
      if (localStorage.getItem(KEY_PREFIX + name) === null) {
        localStorage.setItem(KEY_PREFIX + name, blocks)
        written.push(name)
      }
    }
    this.prune()
    if (written.length === 0) return null
    const info = this.entries().find((entry) => entry.name === written[0])
    return info ?? null
  }

  async list(): Promise<SnapshotInfo[]> {
    return this.entries()
  }

  async restore(name: string): Promise<void> {
    const raw = localStorage.getItem(KEY_PREFIX + name)
    if (raw === null) throw new Error(`快照不存在：${name}`)
    // 先留后悔药，再覆盖——与 Rust 侧同一条规矩
    localStorage.setItem(`${KEY_PREFIX}restore-backup-now.sqlite3`, localStorage.getItem(BLOCKS_KEY) ?? '[]')
    localStorage.setItem(BLOCKS_KEY, raw)
  }

  /** 浏览器通道没有「导出成文件」这回事（`capabilities.exportFile = false`），如实拒绝。 */
  async exportDatabase(): Promise<ExportResult> {
    throw new Error('浏览器预览不提供文件导出，请用桌面版')
  }

  async exportSnapshot(): Promise<ExportResult> {
    throw new Error('浏览器预览不提供文件导出，请用桌面版')
  }

  async dataDirectory(): Promise<string | null> {
    return null
  }

  /** 浏览器通道没有数据目录，也就没有 exports/ 可列（能力如实上报：空表，不是假按钮）。 */
  async listPackages(): Promise<BackupPackageInfo[]> {
    return []
  }

  /** 同上：没有本机文件系统，恢复备份包这条走不了——如实拒绝并指路。 */
  async restorePackage(): Promise<PackageRestoreResult> {
    throw new Error('浏览器预览不提供从备份包恢复，请用桌面版 / 真机')
  }

  /** 保留策略的浏览器版：与 Rust 侧同一条（7 日 + 4 周 + 3 份后悔药）——两侧语义不许漂。 */
  private prune(): void {
    const all = this.entries()
    const keep = (list: SnapshotInfo[], limit: number) => list.slice(0, limit).map((entry) => entry.name)
    const alive = new Set([
      ...keep(all.filter((entry) => entry.kind === 'daily'), 7),
      ...keep(all.filter((entry) => entry.kind === 'weekly'), 4),
      ...keep(all.filter((entry) => entry.kind === 'restore'), 3),
    ])
    for (const entry of all) {
      if (!alive.has(entry.name)) localStorage.removeItem(KEY_PREFIX + entry.name)
    }
  }
}

export function createDefaultBackupPort(): BackupPort {
  const tauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  if (tauri) {
    const invoke = (<T>(command: string, args?: Record<string, unknown>) => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__
      return internals.invoke<T>(command, args)
    }) as Invoke
    return new TauriBackupPort(invoke)
  }
  return new BrowserBackupPort()
}
