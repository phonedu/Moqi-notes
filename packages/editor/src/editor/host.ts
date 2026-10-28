import type { Block } from '../domain/block'

/**
 * 文档存储端口（M3）：编辑器只拿快照、只交快照，不关心底层是 SQLite、内存还是远端。
 * 这是公开 `EditorHost` 的最小面；墨契自己的事务/同步端口留在产品壳侧。
 */
export type DocumentStoragePort = {
  /** 没有文档时返回 null（编辑器会创建一张空白页）。 */
  load(): Promise<Block[] | null>
  save(blocks: Block[]): Promise<void>
}

/** 宿主提供的剪贴板能力；缺省时编辑器不显示依赖剪贴板的功能。 */
export type EditorClipboardPort = {
  writeText(text: string): Promise<void>
  readText?(): Promise<string>
}

/**
 * 编辑器宿主契约（`13-编辑器模块化` §4）：
 * 文档存储是必需的，其余能力按可选端口接；编辑器不直接 import `composition` / `adapters`。
 */
export type EditorHost = {
  storage: DocumentStoragePort
  clipboard?: EditorClipboardPort
  assets?: {
    displayUrl(diskName: string): string | null
  }
  navigate?: (target: { blockId: string }) => void
  theme?: 'light' | 'dark'
}
