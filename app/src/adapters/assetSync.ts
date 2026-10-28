/**
 * `AssetSyncPort` 的两条实现（`docs/03` §14.2「媒体文件」；与 `adapters/assets.ts` 同一族写法）。
 *
 * - `TauriAssetSyncPort`：走 Rust 命令 `sync_assets_exchange`（推 / 拉 / 缺失三份回执；Rust 负责
 *   文件名闸与「只增不减」）。
 * - `BrowserAssetSyncPort`：浏览器预览不落盘（`persistAssets: false`），没有「共享目录里的文件」
 *   这回事 ⇒ 如实返回空回执（**不许装作同步过**——与 `BrowserExportPort` 同一条规矩）。
 */
import type { AssetSyncPort, SyncAssetsReport } from '../application/assetSync'

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

export class TauriAssetSyncPort implements AssetSyncPort {
  constructor(private readonly invoke: Invoke) {}

  async exchange(directory: string, push: string[], want: string[]): Promise<SyncAssetsReport> {
    return this.invoke<SyncAssetsReport>('sync_assets_exchange', { directory, push, want })
  }
}

export class BrowserAssetSyncPort implements AssetSyncPort {
  async exchange(): Promise<SyncAssetsReport> {
    return { pushed: [], pulled: [], missing: [] }
  }
}

/** 桌面壳（含 Android）走 Tauri，其余走浏览器实现——与资产 / 导出 / 备份端口同一个开关。 */
export function createDefaultAssetSyncPort(): AssetSyncPort {
  const tauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  if (!tauri) return new BrowserAssetSyncPort()
  const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__
  return new TauriAssetSyncPort((command, args) => internals.invoke(command, args))
}
