import assert from 'node:assert/strict'
import test from 'node:test'
import { BrowserAssetPort, TauriAssetPort, createDefaultAssetPort } from '../../src/adapters/assets'
import type { AssetImportResult, AssetPort } from '../../src/application/assets'

/**
 * 桌面原生通道的契约门（T2，）。
 *
 * 为什么有它：「拖图报 `Cannot read properties of undefined (reading 'includes')`」那次，缺陷出在
 * **JS ↔ Rust 的边界形状**上——`import_asset` 在 Rust 侧返回元组 `(String, u64)`，过 IPC 是 **JSON 数组**，
 * 适配器必须映射成 `{diskName, originalName, sizeBytes}` 对象再交出去。当时三条媒体管道只端到端验了
 * 浏览器那两条（accept 是浏览器通道，天然盖不到 Rust 那条），单测也不碰适配器 ⇒ 形状错误稳定穿过全部门禁。
 *
 * 探针打法：`TauriAssetPort` 的 `invoke` 是**构造注入**的——单测里塞一个带桩 `invoke`，不启桌面窗口
 * 就能把这条边界钉住。桩的返回值**按 Rust 的真实形状给**（元组给数组、`write_asset` 给数字、
 * `Err(String)` 给字符串 reject），与 `src-tauri/src/lib.rs` 的命令包装逐条对应。
 *
 * 覆盖：端口形状快照（类型级）、命令名与参数键、五个方法的返回形状、`assets_directory` 失败与
 * 显示地址分隔符、`__TAURI_INTERNALS__` 通道开关。未覆盖：`watchDrops`（要真的 webview 事件源，
 * 属桌面运行时；在 node 里钉它只会钉到 Tauri SDK 自己）。
 */

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Assert<T extends true> = T

/** 端口形状快照：`AssetPort` 改了先改这里（正本在 `src/application/assets.ts`）。 */
type AssetPortShape = Assert<
  Equals<
    keyof AssetPort,
    'capabilities' | 'prepare' | 'watchDrops' | 'write' | 'importFromPath' | 'listNames' | 'remove' | 'saveCopy' | 'displayUrl'
  >
>
type AssetImportResultShape = Assert<Equals<keyof AssetImportResult, 'diskName' | 'originalName' | 'sizeBytes'>>

void (null as unknown as AssetPortShape)
void (null as unknown as AssetImportResultShape)

/**
 * 带桩 `invoke`：`replies` 按命令给 **Rust 的真实返回形状**（`lib.rs` 的命令包装逐条对应）；
 * `failures` 里的命令按「Rust 的 `Err(String)`」原样以**字符串** reject（Tauri 就是这么传的）。
 */
function stubInvoke(replies: Record<string, unknown>, failures: Record<string, string> = {}) {
  const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []
  const invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args })
    const failure = failures[command]
    if (failure !== undefined) throw failure
    return replies[command] as T
  }
  return { invoke, calls }
}

/**
 * `convertFileSrc` 读的是 `window.__TAURI_INTERNALS__`（Tauri 2 的实现），node 里没有窗口——
 * 测显示地址时自己塞一个，收尾删掉（本文件之外不靠它）。
 */
function setFakeWindow(convertFileSrc: (path: string, protocol: string) => string): void {
  ;(globalThis as unknown as { window: unknown }).window = { __TAURI_INTERNALS__: { convertFileSrc } }
}
function clearFakeWindow(): void {
  delete (globalThis as unknown as { window?: unknown }).window
}

test('CONTRACT-ASSET-1 打给 Rust 的请求形状：命令名与参数键（lib.rs 的命令包装逐条对应）', async () => {
  const { invoke, calls } = stubInvoke({
    assets_directory: 'C:\\数据\\assets',
    write_asset: 3,
    import_asset: ['原名.png', 3],
    save_asset_copy: 'C:\\数据\\exports\\原名.png',
    list_assets: ['a.png'],
    delete_asset: true,
  })
  const port = new TauriAssetPort(invoke)
  await port.prepare()
  await port.write('disk.png', new Uint8Array([0x89, 0x50]))
  await port.importFromPath('C:\\拖入\\原名.png', 'disk2.png')
  await port.saveCopy('disk.png', '名字.png')
  await port.listNames()
  await port.remove('disk.png')

  assert.deepEqual(
    calls,
    [
      { command: 'assets_directory', args: undefined },
      { command: 'write_asset', args: { fileName: 'disk.png', base64Data: 'iVA=' } },
      { command: 'import_asset', args: { sourcePath: 'C:\\拖入\\原名.png', diskName: 'disk2.png' } },
      { command: 'save_asset_copy', args: { fileName: 'disk.png', displayName: '名字.png' } },
      { command: 'list_assets', args: undefined },
      { command: 'delete_asset', args: { fileName: 'disk.png' } },
    ],
    '命令名 / 参数键漂了：Rust 侧是同一组键（src-tauri/src/lib.rs 的资产命令），字节走 base64',
  )
})

test('CONTRACT-ASSET-2 返回形状：五个方法逐条钉（Rust 元组过 IPC 是 JSON 数组——`includes` of undefined 的历史现场）', async () => {
  const { invoke } = stubInvoke({
    write_asset: 42,
    import_asset: ['周报 截图.png', 12345],
    save_asset_copy: 'C:\\数据\\exports\\周报 配图.png',
    list_assets: ['opaque1.png', 'opaque2.png'],
    delete_asset: false,
  })
  const port = new TauriAssetPort(invoke)
  assert.equal(port.capabilities.persistAssets, true, '桌面通道真的落盘：能力如实上报 true')

  const imported = await port.importFromPath('C:\\拖入\\周报 截图.png', 'opaque1.png')
  assert.equal(
    Array.isArray(imported),
    false,
    '`import_asset` 的元组过 IPC 是数组——适配器必须映射成对象再交出去（原样透传 = 调用方三个字段全 undefined）',
  )
  assert.deepEqual(
    imported,
    { diskName: 'opaque1.png', originalName: '周报 截图.png', sizeBytes: 12345 },
    '`importFromPath` 的返回形状：磁盘名来自入参（Rust 不回显它），原名与字节数来自 Rust',
  )

  assert.equal(await port.write('opaque1.png', new Uint8Array([1])), 42, '`write` → 落盘字节数（number）')
  assert.deepEqual(await port.listNames(), ['opaque1.png', 'opaque2.png'], '`listNames` → 磁盘名数组（string[]；界面用它判「文件缺失」）')
  assert.equal(await port.remove('其实不在.png'), false, '`remove` → boolean（false = 文件本来就不在，幂等分支）')
  assert.equal(
    await port.saveCopy('opaque1.png', '周报 配图.png'),
    'C:\\数据\\exports\\周报 配图.png',
    '`saveCopy` → 副本路径（string；浏览器通道才是 null）',
  )

  const { invoke: failing } = stubInvoke({}, { import_asset: '拖进来的不是一个文件：C:\\没有.png' })
  await assert.rejects(
    new TauriAssetPort(failing).importFromPath('C:\\没有.png', 'x.png'),
    (error: unknown) => error === '拖进来的不是一个文件：C:\\没有.png',
    'Rust 的 `Err(String)` 过 IPC 是字符串 reject——如实向上传（调用方拿它当提示文案，别包成 Error）',
  )
})

test('CONTRACT-ASSET-3 显示地址：目录问不到就 null（降级不崩）；`\\` 与 `/` 两向分隔符都不叠', async () => {
  const { invoke: noDirectory } = stubInvoke({}, { assets_directory: '数据目录不可用' })
  const degraded = new TauriAssetPort(noDirectory)
  await degraded.prepare()
  assert.equal(degraded.displayUrl('a.png'), null, '没有目录 → null（界面降级成占位卡，不是崩）')

  const patched: string[] = []
  setFakeWindow((path, protocol) => {
    patched.push(path)
    return `${protocol}://${path}`
  })
  try {
    const windows = new TauriAssetPort(stubInvoke({ assets_directory: 'C:\\数据\\assets' }).invoke)
    await windows.prepare()
    assert.equal(windows.displayUrl('a.png'), 'asset://C:\\数据\\assets\\a.png', 'Windows 目录用 `\\` 接出显示地址')

    const trailing = new TauriAssetPort(stubInvoke({ assets_directory: 'C:\\数据\\assets\\' }).invoke)
    await trailing.prepare()
    assert.equal(trailing.displayUrl('a.png'), 'asset://C:\\数据\\assets\\a.png', '目录自带尾分隔符时不接出双 `\\`')

    const posix = new TauriAssetPort(stubInvoke({ assets_directory: '/data/assets' }).invoke)
    await posix.prepare()
    assert.equal(posix.displayUrl('a.png'), 'asset:///data/assets/a.png', 'POSIX 目录用 `/` 接')

    assert.deepEqual(
      patched,
      ['C:\\数据\\assets\\a.png', 'C:\\数据\\assets\\a.png', '/data/assets/a.png'],
      '喂给 `convertFileSrc` 的是拼完的绝对路径',
    )
  } finally {
    clearFakeWindow()
  }
})

test('CONTRACT-ASSET-4 通道开关：认 `__TAURI_INTERNALS__`（桌面）还是浏览器实现', async () => {
  clearFakeWindow()
  const browser = createDefaultAssetPort()
  assert.ok(browser instanceof BrowserAssetPort, '没有 Tauri 注入 → 浏览器通道')
  assert.equal(browser.capabilities.persistAssets, false, '浏览器通道不落盘：如实上报 false')

  const { invoke, calls } = stubInvoke({ write_asset: 2 })
  ;(globalThis as unknown as { window: unknown }).window = { __TAURI_INTERNALS__: { invoke } }
  try {
    const desktop = createDefaultAssetPort()
    assert.ok(desktop instanceof TauriAssetPort, '有 Tauri 注入 → 桌面通道（走 Rust 命令）')
    await desktop.write('a.png', new Uint8Array([1, 2]))
    assert.deepEqual(
      calls,
      [{ command: 'write_asset', args: { fileName: 'a.png', base64Data: 'AQI=' } }],
      '适配器要接到窗口注入的 invoke 上（字节走 base64）',
    )
  } finally {
    clearFakeWindow()
  }
})
