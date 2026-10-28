import assert from 'node:assert/strict'
import test from 'node:test'
import { assetSyncPlan, cleanupUnreferencedAssets, referencedAssetNames, type AssetSyncPort } from '../../src/application/assetSync'
import type { AssetPort } from '../../src/application/assets'
import { TauriAssetSyncPort, createDefaultAssetSyncPort } from '../../src/adapters/assetSync'
import { createTextBlock, type Block } from '@moqi/editor'

/**
 * 资产随同步（`docs/03` §14.2「媒体文件」；13-媒体设计（已归档） §2 第 3 行的裁决「最小形态」，
 * 2026-10-11 落地）+ 孤儿资产清理（同日审计：`AssetPort.remove` 此前是死代码）。
 *
 * 这一层验三件事：① 推 / 拉计划的纯函数（被引用集 → push / want）；② 清理只清「不再被引用」的
 * 文件、读不到名册就不删；③ 打给 Rust 的请求形状（命令名与参数键——与 `lib.rs` 的命令包装对应，
 * `CONTRACT-ASSET-5`；Rust 侧的复制 / 只增不减 / 非法名跳过在 `src-tauri/src/sync_files.rs` 的单测里）。
 */

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Assert<T extends true> = T
/** 端口形状快照：`AssetSyncPort` 改了先改这里（正本在 `src/application/assetSync.ts`）。 */
type AssetSyncPortShape = Assert<Equals<keyof AssetSyncPort, 'exchange'>>
void (null as unknown as AssetSyncPortShape)

/** 带资产指针的块（`deleted` 用来验「回收站里的块也算引用」）。 */
function mediaBlock(id: string, fileName: string | null, deleted = false): Block {
  const block = createTextBlock({ entityId: id, blockUid: `${id}-uid`, text: '' })
  block.type = 'image'
  block.deleted = deleted
  if (fileName !== null) block.asset = { fileName, originalName: '原名.png', mime: 'image/png', size: 3 }
  return block
}

/** 内存资产端口：够 `cleanupUnreferencedAssets` 用就行；其余方法如实占位。 */
function memoryAssets(files: string[], failList = false) {
  const disk = new Set(files)
  const removed: string[] = []
  const port = {
    capabilities: { persistAssets: false },
    prepare: async () => undefined,
    watchDrops: async () => () => undefined,
    write: async () => 0,
    importFromPath: async () => ({ diskName: '', originalName: '', sizeBytes: 0 }),
    listNames: async () => {
      if (failList) throw '名册读不到'
      return [...disk]
    },
    remove: async (name: string) => {
      removed.push(name)
      return disk.delete(name)
    },
    saveCopy: async () => null,
    displayUrl: () => null,
  } satisfies AssetPort
  return { port, removed, disk }
}

test('SYNC-ASSET-1 推 / 拉计划：want = 全部被引用名（含回收站），push = 其中本机有的那部分', () => {
  const referenced = referencedAssetNames([
    mediaBlock('a', 'a.png'),
    mediaBlock('b', 'b.png', true), // 在回收站里——还原后图要还在，所以也算引用
    mediaBlock('c', null), // 没有资产的块不进集合
  ])
  assert.deepEqual([...referenced].sort(), ['a.png', 'b.png'])

  const plan = assetSyncPlan(referenced, new Set(['a.png', 'orphan.png']))
  assert.deepEqual(plan.push, ['a.png'], '本机有、被引用的才推（孤儿不共享）')
  assert.deepEqual(plan.want, ['a.png', 'b.png'], 'want 稳定排序，交给 Rust 决定拉 / 缺')
})

test('SYNC-ASSET-2 清理只清「不再被任何块引用」的文件；读不到名册就什么都不删', async () => {
  const live = memoryAssets(['keep.png', 'trash.png', 'orphan.png'])
  const survivors: Set<string>[] = []
  const gone = await cleanupUnreferencedAssets(
    live.port,
    [mediaBlock('a', 'keep.png'), mediaBlock('b', 'trash.png', true)],
    (names) => survivors.push(names),
  )
  assert.deepEqual(gone, ['orphan.png'], '只清孤儿')
  assert.deepEqual(live.removed, ['orphan.png'])
  assert.deepEqual([...survivors[0]!].sort(), ['keep.png', 'trash.png'], '名册回给界面（刷新「文件缺失」占位）')

  const blind = memoryAssets(['a.png'], true)
  const none = await cleanupUnreferencedAssets(blind.port, [])
  assert.deepEqual(none, [], '读不到名册宁可留孤儿，不许误删（删文件不可逆）')
  assert.deepEqual(blind.removed, [])
})

test('CONTRACT-ASSET-5 资产交换打给 Rust 的请求形状：命令名与参数键（lib.rs 的命令包装对应）', async () => {
  const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []
  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args })
    return { pushed: ['a.png'], pulled: [], missing: ['b.png'] } as T
  }
  const report = await new TauriAssetSyncPort(invoke).exchange('X:\\sync-share', ['a.png'], ['a.png', 'b.png'])
  assert.deepEqual(calls, [{ command: 'sync_assets_exchange', args: { directory: 'X:\\sync-share', push: ['a.png'], want: ['a.png', 'b.png'] } }])
  assert.deepEqual(report, { pushed: ['a.png'], pulled: [], missing: ['b.png'] }, '推 / 拉 / 缺三份回执原样透传')

  // 浏览器通道如实返回空回执（不落盘 ⇒ 不许装作同步过）
  const empty = await createDefaultAssetSyncPort().exchange('x', [], [])
  assert.deepEqual(empty, { pushed: [], pulled: [], missing: [] })
})
