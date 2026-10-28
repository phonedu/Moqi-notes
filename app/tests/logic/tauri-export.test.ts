import assert from 'node:assert/strict'
import test from 'node:test'
import { TauriExportPort } from '../../src/adapters/export'
import { exportWriteOf } from '../../src/application/export'
import { planMarkdownExport } from '@moqi/editor'
import { createTextBlock, type Block } from '@moqi/editor'

/**
 * Markdown 导出的原生通道（`EXPORT-ASSET-1`， 审计）。
 *
 * 为什么有它：桌面端「设置 → 导出」的整条链此前**三处断**——① 调用点不传 `existingAssets`
 * ⇒ 每张图都走「（图片缺失）」降级；② `plan.assets`（搬运单）在端口边界被丢 ⇒ Rust 收不到；
 * ③ `export.rs` 的四个结构体缺 `rename_all` ⇒ 前端送的 `artifactName` 反序列化必挂。
 * 测试全绿是因为它们自己传了 `existingAssets`、且没人跑过真实 IPC 路径。这条用例从域层计划
 * 一路钉到 `invoke` 参数：改掉任何一环先红。
 */

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

function stubInvoke(replies: Record<string, unknown>) {
  const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []
  const invoke: Invoke = async (command, args) => {
    calls.push({ command, args })
    return replies[command] as never
  }
  return { invoke, calls }
}

function imageBlock(id: string, parent: string, fileName: string, originalName: string): Block {
  const block = createTextBlock({ entityId: id, blockUid: `${id}-uid`, text: '图注', parent })
  block.type = 'image'
  block.asset = { fileName, originalName, mime: 'image/png', size: 3 }
  return block
}

test('EXPORT-ASSET-1 导出的资产链贯通：计划带 existingAssets → 搬运单随行 → 适配器照单交给 Rust', async () => {
  const page = createTextBlock({ entityId: 'pg', blockUid: 'pg000001', text: '甲页', isObject: true, objectName: '甲页' })
  const present = imageBlock('im1', 'pg', 'disk-1.png', '截图.png')
  const missing = imageBlock('im2', 'pg', 'disk-2.png', '丢了.png')
  page.children = [present.entityId, missing.entityId] // 手工图：父块的 children 是导出遍历的入口
  const blocks = new Map<string, Block>([[page.entityId, page], [present.entityId, present], [missing.entityId, missing]])

  // ① 域层：本机存在的资产出搬运单，缺文件的正文降级（两条都要在，不许静默丢）
  const plan = planMarkdownExport(blocks, { properties: [], tags: [] }, { kind: 'page', pageId: 'pg' }, {
    today: '2026-10-11',
    existingAssets: ['disk-1.png'],
  })
  assert.ok(plan, '这一页导出得出来')
  assert.deepEqual(plan.assets, [{ from: 'disk-1.png', to: 'assets/截图.png' }], '存在的资产进搬运单')
  assert.match(plan.files[0]!.content, /!\[图注\]\(assets\/截图\.png\)/)
  assert.match(plan.files[0]!.content, /（图片缺失：丢了\.png）/, '缺文件降级成文字（此前**全部**图都走这一条）')

  // ② 端口层：`exportWriteOf` 必须把搬运单带上（此前调用点在这一步丢掉它）
  const { invoke, calls } = stubInvoke({ write_markdown_export: { path: 'C:\\exports\\甲页.md', sizeBytes: 9, entries: 2 } })
  const result = await new TauriExportPort(invoke).write(exportWriteOf(plan))
  assert.equal(result.path, 'C:\\exports\\甲页.md')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.command, 'write_markdown_export')
  assert.deepEqual(calls[0]!.args, {
    plan: {
      kind: 'file',
      artifactName: '甲页.md',
      files: plan.files,
      assets: [{ from: 'disk-1.png', to: 'assets/截图.png' }],
      targetPath: null, // `T-18`：不给落点 = 数据目录的 exports/（给了才走「另存为 / 存到文件夹」）
    },
  }, '字段名按 camelCase（Rust 侧 rename_all = "camelCase" 对得上；`ipc_payload_uses_camel_case_field_names` 是对面的同一半）')
  // ③ 落点那条路（`T-18`）：给了绝对路径 ⇒ 随 plan 透传给 Rust（同一写入口，不另开通路）
  const picked = stubInvoke({ write_markdown_export: { path: 'X:\export-target\甲页.md', sizeBytes: 9, entries: 1 } })
  await new TauriExportPort(picked.invoke).write(exportWriteOf(plan), 'X:\export-target\甲页.md')
  assert.equal((picked.calls[0]!.args as { plan: { targetPath: string | null } }).plan.targetPath, 'X:\export-target\甲页.md', '另存为的落点透传到 plan.targetPath')
})
