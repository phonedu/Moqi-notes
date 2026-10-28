import type { Block } from '@moqi/editor'
import type { AssetPort } from './assets'

/**
 * 资产随同步（`docs/03` §14.2「媒体文件」；13-媒体设计（已归档） §2 第 3 行的裁决「最小形态」，
 * 2026-10-11 落地）。协议层只搬 `oplog` 与注册表行，**文件本体不在协议里**——这条通路补上它：
 * 每轮同步之后，把本机资产推到共享目录 `<同步目录>/assets/`、把共享目录里有的拉回来。
 *
 * 三条边界（与 Rust 侧 `sync_files::assets_exchange` 是同一份契约）：
 * - 推的是「被块引用的 ∩ 本机有的」；拉的是「被块引用的 − 本机有的」；两处都没有 → `missing` 如实报回。
 * - **共享端只增不减**：不覆盖、不广播删除（磁盘名是不透明随机名，同名 = 同一份内容）。
 * - 计划由「引用集合」推出来，纯函数、可单测（`SYNC-ASSET-1`）；不含任何磁盘遍历规则。
 */
export type SyncAssetsReport = { pushed: string[]; pulled: string[]; missing: string[] }

export interface AssetSyncPort {
  exchange(directory: string, push: string[], want: string[]): Promise<SyncAssetsReport>
}

/** 被块引用的资产磁盘名（**含回收站里的块**——还原后图要还在）。purge 过的块已不在图里，天然排除。 */
export function referencedAssetNames(blocks: Iterable<Block>): Set<string> {
  const names = new Set<string>()
  for (const block of blocks) if (block.asset?.fileName) names.add(block.asset.fileName)
  return names
}

/** 推 / 拉计划：`want` = 全部被引用名（稳定排序），`push` = 其中本机有的那部分。 */
export function assetSyncPlan(referenced: ReadonlySet<string>, local: ReadonlySet<string>): { push: string[]; want: string[] } {
  const want = [...referenced].sort()
  return { push: want.filter((name) => local.has(name)), want }
}

/**
 * 清掉**不再被任何块引用**的资产文件（彻底删除 / 到期清理 / 清空回收站之后调用；启动时也扫一次，
 * 这同时兜住历史遗留的孤儿）。此前 `AssetPort.remove` 是死代码：磁盘只涨不减、「从本机彻底删除」
 * 名不副实（2026-10-11 审计，`SYNC-ASSET-2`）。`onNames` 把清理后的名册交回界面（刷新「文件缺失」占位）。
 * 读不到名册就什么都不删——宁可留孤儿，不许误删（删文件是不可逆动作）。
 */
export async function cleanupUnreferencedAssets(
  port: AssetPort,
  blocks: Iterable<Block>,
  onNames?: (names: Set<string>) => void,
): Promise<string[]> {
  const referenced = referencedAssetNames(blocks)
  let names: string[]
  try {
    names = await port.listNames()
  } catch {
    return []
  }
  const orphans = names.filter((name) => !referenced.has(name))
  for (const name of orphans) {
    try {
      await port.remove(name)
    } catch {
      // 单个删不掉不拖整批（下轮启动还会扫）
    }
  }
  if (orphans.length > 0 && onNames) {
    try {
      onNames(new Set(await port.listNames()))
    } catch {
      // 名册刷新失败不影响清理结果本身
    }
  }
  return orphans
}
