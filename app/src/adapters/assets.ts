/**
 * `AssetPort` 的两条实现（13-媒体设计（已归档） §3 / §4 的 spike 结论）。
 *
 * - `TauriAssetPort`：走 Rust 命令（`write_asset` / `import_asset` / `list_assets` / `delete_asset` /
 *   `assets_directory`），显示地址用 `convertFileSrc`（asset 协议；`csp` 为 null，不用额外白名单）。
 *   桌面拖入走 Tauri 的拖放事件（**给的是路径**，不是字节——Windows 上 HTML5 drop 在那条通道里拿不到）。
 * - `BrowserAssetPort`：**不落盘**——磁盘名 → Blob 存内存、显示地址是 object URL，
 *   够跑通界面流程与 accept（页面刷新即丢，`persistAssets: false` 如实上报）。
 */
import { convertFileSrc } from '@tauri-apps/api/core'
import type { AssetImportResult, AssetPort } from '../application/assets'

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>


/** 字节 → base64（JSON IPC 的直接路；图片量级够用，理由见 Rust 侧 `write_asset` 的注释）。 */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

export class TauriAssetPort implements AssetPort {
  capabilities = { persistAssets: true }

  /** `<数据目录>/assets/` 的绝对路径（`prepare()` 问来的）；显示地址由它 + 磁盘名拼出来。 */
  private directory: string | null = null

  constructor(private readonly invoke: Invoke) {}

  async prepare(): Promise<void> {
    try {
      this.directory = await this.invoke<string>('assets_directory')
    } catch {
      this.directory = null
    }
  }

  /** OS 文件拖入：Tauri 的拖放事件给路径（HTML5 drop 在桌面通道里拿不到文件）。 */
  async watchDrops(handler: (paths: string[]) => void): Promise<() => void> {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview')
    const unlisten = await getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === 'drop' && event.payload.paths.length > 0) handler(event.payload.paths)
    })
    return unlisten
  }

  async write(diskName: string, bytes: Uint8Array): Promise<number> {
    return this.invoke<number>('write_asset', { fileName: diskName, base64Data: toBase64(bytes) })
  }

  async importFromPath(sourcePath: string, diskName: string): Promise<AssetImportResult> {
    // **Rust 返回的是元组 **（过 IPC 是 JSON 数组，磁盘名由调用方给）——这里必须
    // 映射成对象再交出去。直接原样返回会让调用方把数组当对象读，三个字段全是 undefined：
    // 症状 ① 拖图报 "Cannot read properties of undefined (reading 'includes')"；
    // 症状 ② 导入的图片块 payload 里名字为空 ⇒ 当场显示「文件缺失」灰色（2026-10-08 用户实测两条）。
    // 之前三条媒体管道只端到端验了浏览器那两条，桌面这条是第一次真跑 ⇒ 这个形状错一直没被逮到。
    const [originalName, sizeBytes] = await this.invoke<[string, number]>('import_asset', { sourcePath, diskName })
    return { diskName, originalName, sizeBytes }
  }

  async saveCopy(diskName: string, displayName: string): Promise<string | null> {
    return this.invoke<string>('save_asset_copy', { fileName: diskName, displayName })
  }

  async listNames(): Promise<string[]> {
    return this.invoke<string[]>('list_assets')
  }

  async remove(diskName: string): Promise<boolean> {
    return this.invoke<boolean>('delete_asset', { fileName: diskName })
  }

  displayUrl(diskName: string): string | null {
    if (!this.directory) return null
    const separator = this.directory.includes('\\') ? '\\' : '/'
    return convertFileSrc(`${this.directory}${this.directory.endsWith(separator) ? '' : separator}${diskName}`)
  }
}

export class BrowserAssetPort implements AssetPort {
  capabilities = { persistAssets: false }

  private readonly blobs = new Map<string, Blob>()
  private readonly urls = new Map<string, string>()

  async prepare(): Promise<void> {
    // 浏览器通道不落盘：没有目录要问（`persistAssets: false` 如实上报）。
  }

  async watchDrops(): Promise<() => void> {
    // 没有 Tauri 拖放事件源；HTML5 drop 由界面自己接（拿到的就是字节）。
    return () => undefined
  }

  async write(diskName: string, bytes: Uint8Array): Promise<number> {
    // 拷一份再入 Blob：TS 的 Uint8Array<ArrayBufferLike> 与 BlobPart 对不上（TS 5.7 的 BufferSource 收紧）
    this.blobs.set(diskName, new Blob([new Uint8Array(bytes)]))
    return bytes.byteLength
  }

  /** 浏览器预览拿不到本机路径（拖入走 HTML5 字节、粘贴走剪贴板字节、菜单走 `<input type=file>` 字节）。 */
  async importFromPath(): Promise<AssetImportResult> {
    throw new Error('浏览器预览拿不到本机文件路径，请用拖入 / 粘贴 / 选择文件')
  }

  /** 浏览器侧：直接触发一次下载（拿不到「路径」这回事，返回 null 让界面改口）。 */
  async saveCopy(diskName: string, displayName: string): Promise<string | null> {
    const blob = this.blobs.get(diskName)
    if (!blob) throw new Error('文件不在这次会话里（浏览器预览不落盘）')
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = displayName
    anchor.click()
    URL.revokeObjectURL(url)
    return null
  }

  async listNames(): Promise<string[]> {
    return [...this.blobs.keys()]
  }

  async remove(diskName: string): Promise<boolean> {
    const url = this.urls.get(diskName)
    if (url) URL.revokeObjectURL(url)
    this.urls.delete(diskName)
    return this.blobs.delete(diskName)
  }

  displayUrl(diskName: string): string | null {
    const blob = this.blobs.get(diskName)
    if (!blob) return null
    const existing = this.urls.get(diskName)
    if (existing) return existing
    const url = URL.createObjectURL(blob)
    this.urls.set(diskName, url)
    return url
  }
}

/** 桌面壳（含 Android）走 Tauri，其余走浏览器实现——与备份 / 导出端口同一个开关。 */
export function createDefaultAssetPort(): AssetPort {
  const tauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  if (!tauri) return new BrowserAssetPort()
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__
  return new TauriAssetPort((command, args) => internals.invoke(command, args))
}
