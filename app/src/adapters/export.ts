/**
 * `ExportPort` 的两条实现（`docs/03` §15.9 同一族的端口写法）。
 *
 * - `TauriExportPort`：走 Rust 命令（`list_export_files` 哑读 / `write_markdown_export` 落盘，zip 在 Rust 打）。
 * - `BrowserExportPort`：浏览器预览没有数据目录 ⇒ **写文件如实上报不可用**（这与 `BrowserBackupPort` 同一条规矩：
 *   语义对齐、能力如实上报；不许在浏览器里假装导出成功）。
 */
import type { ExportPort, MarkdownExportResult, MarkdownExportWrite } from '../application/export'

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

type NativeWriteOut = { path: string; sizeBytes: number; entries: number }

export class TauriExportPort implements ExportPort {
  capabilities = { writeFiles: true }

  constructor(private readonly invoke: Invoke) {}

  async listNames(): Promise<string[]> {
    return this.invoke<string[]>('list_export_files')
  }

  async write(plan: MarkdownExportWrite, targetPath?: string): Promise<MarkdownExportResult> {
    // `assets` 必须随行：Rust 侧照着搬运单复制 / 入包（缺这一步 = 导出的 .md / .zip 里图全丢，
  // 审计修复；`EXPORT-ASSET-1` 看住透传）。
    const out = await this.invoke<NativeWriteOut>('write_markdown_export', {
      plan: { kind: plan.kind, artifactName: plan.artifactName, files: plan.files, assets: plan.assets, targetPath: targetPath ?? null },
    })
    return { path: out.path, sizeBytes: out.sizeBytes, entries: out.entries }
  }

  /** 导入那条路：拖入给的是路径，正文由 Rust 读回来（只放行 `.md` / `.markdown` / `.txt`）。 */
  async readTextFile(path: string): Promise<string> {
    return this.invoke<string>('read_text_file', { path })
  }

  /** 拖入的 `.zip` 导入包：Rust 解开、逐条 base64（分拣判据在 `domain/mdPackage.ts`）。 */
  async readPackageEntries(path: string): Promise<{ entries: { name: string; base64: string }[]; skipped: number }> {
    return this.invoke<{ entries: { name: string; base64: string }[]; skipped: number }>('read_zip_entries', { path })
  }

  /** 「选择文件夹」导入（`T-18`）：Rust 递归列 `.md` / `.markdown`（上限 500 篇、按路径排序）。 */
  async listMarkdownFiles(dir: string): Promise<string[]> {
    return this.invoke<string[]>('list_markdown_files', { dir })
  }
}

export class BrowserExportPort implements ExportPort {
  capabilities = { writeFiles: false }

  async listNames(): Promise<string[]> {
    return []
  }

  /** 浏览器通道没有「写进数据目录」这回事（`capabilities.writeFiles = false`），如实拒绝。 */
  async write(_plan: MarkdownExportWrite, _targetPath?: string): Promise<MarkdownExportResult> {
    throw new Error('浏览器预览不提供文件导出，请用桌面版')
  }

  /** 浏览器通道也没有「读本机路径」这条（拖入给的是字节 ⇒ 调用方直接 `File.text()`），如实拒绝。 */
  async readTextFile(): Promise<string> {
    throw new Error('浏览器预览读不到本机路径：拖入的 .md 直接按字节读，请走那条路')
  }

  /** 同上：拖入的 `.zip` 直接按字节解（`fflate`），没有本机路径这条。 */
  async readPackageEntries(): Promise<{ entries: { name: string; base64: string }[]; skipped: number }> {
    throw new Error('浏览器预览读不到本机路径：拖入的 .zip 直接按字节解，请走那条路')
  }

  /** 浏览器通道没有本机目录：如实返回空（界面按 `fileChannel.capabilities.pickFolder` 早已禁用该入口）。 */
  async listMarkdownFiles(): Promise<string[]> {
    return []
  }
}

export function createDefaultExportPort(): ExportPort {
  const tauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  if (tauri) {
    const invoke = (<T>(command: string, args?: Record<string, unknown>) => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__
      return internals.invoke<T>(command, args)
    }) as Invoke
    return new TauriExportPort(invoke)
  }
  return new BrowserExportPort()
}
