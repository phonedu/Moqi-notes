/**
 * `FileChannelPort` 的两条实现（`03` §12.4 · 0.6 第 11 项）。
 *
 * - `TauriFileChannelPort`：`@tauri-apps/plugin-dialog` 的 `open` / `save`——**桌面 = 原生对话框**，
 *   **Android = SAF 系统选择器**（同一个 API 落到各自系统能力上）。返回的 `ref` 在 Android 是
 *   `content://…` 内容 URI：**不能直接 `std::fs` 读**，调用方按 §12.4 的固定走法先复制进应用缓存目录。
 * - `BrowserFileChannelPort`：浏览器预览**三能力全 false**（界面据此禁用并把原因写在界面上）。
 *
 * **2026-10-16 真机修复（台账 `D-088`）：搬缓存 / 拷落点这两步改由 Rust 命令执行**
 * （`src-tauri/src/saf.rs` 的 `stage_saf_document` / `write_saf_document`）。原因：`fs` 插件的
 * **所有 JS 命令**（`readFile` / `writeFile` / `copyFile` / `stat`）在 Rust 侧都先过
 * `SafeFilePath::into_path()` —— `content://` 转不成路径，一律 `InvalidPathUrl`（真机上导入与导出
 * 双双失败）；插件里支持内容 URI 的通道只有 Rust 的 `Fs::open()`（Android 侧走 ContentResolver 拿 fd）。
 * 端口形状、8 MB 上限与走法（先搬缓存再走既有通路 / 写入逻辑只有一条）都没变。
 */
import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import { extensionOf, type FileChannelCapabilities, type FileChannelPort, type PickedFile } from '../application/fileChannel'

/** 单文件上限（与导入页那行「单文件 8 MB」同源）。 */
const PICK_LIMIT_BYTES = 8 * 1024 * 1024

/** 超限的**唯一文案**：Rust 侧只回哨兵（`saf.rs` 的 `TOO_LARGE_SENTINEL`），翻译只在这里做一处。 */
const TOO_LARGE_TEXT = '单文件上限 8 MB，这个文件更大——请先拆分或压成 .zip 再导'

/** Rust 侧 SAF 暂存命令的返回形状（`saf.rs` 的 `StagedSafDocument`）。 */
type StagedSafDocument = { path: string; size: number; isZip: boolean }

/**
 * SAF 内容 URI 的**固定走法**（`03` §12.4 第一条坑）：`content://` 走不了 `std::fs` ⇒
 * **先搬进应用缓存目录、再把缓存里的绝对路径交给既有通路**——校验（扩展名 / 8 MB）与解析全留在原处，
 * **不给第二个入口**。文件名同样拿不到（上游已知）⇒ 用「导入的文档」兜底，类型靠**魔数**判
 * （zip = `PK`，判在 Rust 侧）；页名最终由 `importMarkdownDocument` 取文档第一处 `# ` 标题。
 */
async function stageContentUri(uri: string): Promise<PickedFile> {
  let staged: StagedSafDocument
  try {
    staged = await invoke<StagedSafDocument>('stage_saf_document', { uri })
  } catch (error) {
    if (String(error).includes('__MOQI_TOO_LARGE__')) throw new Error(TOO_LARGE_TEXT)
    throw error instanceof Error ? error : new Error(String(error))
  }
  if (staged.size > PICK_LIMIT_BYTES) throw new Error(TOO_LARGE_TEXT) // 兜底：Rust 侧已挡，这句防契约漂移
  const name = staged.isZip ? '导入的文档.zip' : '导入的文档.md'
  return { ref: staged.path, name, ext: staged.isZip ? 'zip' : 'md' }
}
/** Android 上 folder picker 官方不支持（`03` §12.4 的第三条已知面）——能力面在这里如实收敛。 */
const onAndroid = () => typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)

export class TauriFileChannelPort implements FileChannelPort {
  capabilities: FileChannelCapabilities = { pickFile: true, pickFolder: !onAndroid(), saveAs: true }

  async pickFile(extensions: string[]): Promise<PickedFile | null> {
    const picked = await open({ multiple: false, directory: false, filters: [{ name: '可导入的文件', extensions }] })
    if (typeof picked !== 'string') return null
    // Android（SAF）：`content://` 先搬缓存再交给既有通路；桌面给的就是绝对路径，直接用。
    if (picked.startsWith('content://')) return stageContentUri(picked)
    // 内容 URI 拿不到文件名（上游已知）⇒ 页名兜底走默认名，**不把「读文件名」当必成项**。
    const name = picked.split(/[\\/]/).pop() ?? ''
    return { ref: picked, name: name || '导入的文档', ext: extensionOf(name) }
  }

  async pickFolder(): Promise<string | null> {
    if (!this.capabilities.pickFolder) return null
    const picked = await open({ directory: true, multiple: false })
    return typeof picked === 'string' ? picked : null
  }

  /** 「另存为」：桌面 = 原生保存对话框（返回路径）；Android = SAF 目标位置（返回内容 URI）。 */
  async saveAs(defaultName: string): Promise<string | null> {
    const picked = await save({ defaultPath: defaultName })
    return picked ?? null
  }

  /** SAF 写方向（`03` §12.4）：把已经写进 `exports/` 的那一份拷到用户选的位置（内容 URI）。 */
  async copyOut(fromPath: string, toRef: string): Promise<void> {
    // 参数名要对上 Rust 侧（`saf.rs` 的 `write_saf_document(from_path, uri)`）：Tauri v2 把
    // `from_path` 映射成 JS 的 `fromPath`，`uri` 原样——**这里写成 `toRef` 会以「missing required
    // key `uri`」当场被拒**（2026-10-16 真机实测，见台账 `D-088`）。
    await invoke('write_saf_document', { fromPath, uri: toRef })
  }
}

export class BrowserFileChannelPort implements FileChannelPort {
  capabilities: FileChannelCapabilities = { pickFile: false, pickFolder: false, saveAs: false }

  async pickFile(): Promise<PickedFile | null> { return null }
  async pickFolder(): Promise<string | null> { return null }
  async saveAs(): Promise<string | null> { return null }
  async copyOut(): Promise<void> { /* 浏览器通道没有 SAF 落点 */ }
}

export function createDefaultFileChannelPort(): FileChannelPort {
  const tauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  return tauri ? new TauriFileChannelPort() : new BrowserFileChannelPort()
}
