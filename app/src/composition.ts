/**
 * 合成根（composition root， 收口；见 `06` §6 落点四问第 ② 条与「外壳新代码免入」）。
 *
 * **唯一职责**：把端口的**构造**收在一处——存储 / 同步文件 IO / 检索 / 备份 / 导出 / 资产 / AI / 窗口壳。
 * 上层（`ui/`）只从这里取；**不许直接 `import '../adapters/…'`**（边界门 `tests/logic/import-boundaries.test.ts` 会红）。
 * 这样换实现（Tauri ↔ 浏览器通道、换 AI 供应商）只改这一处，UI 永远不知道平台是谁。
 */
import { createDefaultClipboardPort } from './adapters/clipboard'
export {
  createDefaultStoragePort,
  createDefaultSyncFileIo,
  type TransactionStoragePort,
  type SyncState,
} from './adapters/ports'
export { createDefaultSearchPort } from './adapters/search'
export { createDefaultBackupPort } from './adapters/backup'
export { createDefaultExportPort } from './adapters/export'
export { createDefaultAssetPort } from './adapters/assets'
export { createDefaultAssetSyncPort } from './adapters/assetSync'
export { createDefaultFileChannelPort } from './adapters/fileChannel'
export type { FileChannelPort, FileChannelCapabilities, PickedFile } from './application/fileChannel'
export { createDefaultClipboardPort }
export type { ClipboardPort } from './application/clipboard'
/** 剪贴板无状态，一份单例给全部调用点：复制 / 剪切 / 复制为块引用 / 粘贴检测共用同一条路。 */
export const clipboardPort = createDefaultClipboardPort()
export { createDefaultWindowShell } from './adapters/windowShell'
export { OpenAICompatibleAIPort, type AiConfig } from './adapters/ai'
// 端口**接口**的家在应用层（适配器实现它）——这里一起再导出，好让 ui 只认合成根这一处。
export type { ExportPort } from './application/export'
export type { AssetPort } from './application/assets'
export type { AssetSyncPort, SyncAssetsReport } from './application/assetSync'
export type { WindowShellMetrics, WindowShellPort } from './application/windowShell'
