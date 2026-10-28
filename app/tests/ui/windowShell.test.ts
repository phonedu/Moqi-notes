import assert from 'node:assert/strict'
import test from 'node:test'
import { MIN_WINDOW_HEIGHT, TauriWindowShell, type TauriWindowDeps } from '../../src/adapters/windowShell'

/**
 * 窗口壳桥接段的**机器验收**（`R04-ACCEPT-7` 补层）：`R09-RESP-19` 的算式链有单测
 * （`tests/ui/minWindowSize.test.ts`）、浏览器视口档有 `accept:WINDOW-FIT-1`——但
 * 「算出来的数字**写进真窗口**」这一段此前没有任何机器判据（只有真窗口人工 G 组兜着）。
 *
 * 为什么值得钉：`D-041` 的现场就是这一段——`LogicalSize` 类序列化成 `{ width, height }`
 * 会被 Rust 侧打回 `expected map with a single key`，最小宽度**静默失效**（浏览器通道与
 * 单测都看不见）。这里把 invoke 的**参数形状**逐字钉死。
 */
function makeDeps(overrides: Partial<Record<'invoke' | 'getCurrentWindow' | 'currentMonitor', unknown>> = {}): { deps: TauriWindowDeps; calls: Array<{ command: string; args: Record<string, unknown> | undefined }> } {
  const calls: Array<{ command: string; args: Record<string, unknown> | undefined }> = []
  const win = {
    label: 'main',
    scaleFactor: async () => 1.5,
    innerSize: async () => ({ width: 1536, height: 1000 }), // 物理 px ⇒ 逻辑 1024
    onResized: async () => () => {},
    onMoved: async () => () => {},
    onScaleChanged: async () => () => {},
  }
  const deps = {
    invoke: (async (command: string, args?: Record<string, unknown>) => { calls.push({ command, args }); return null }) as unknown as TauriWindowDeps['invoke'],
    getCurrentWindow: (() => win) as unknown as TauriWindowDeps['getCurrentWindow'],
    currentMonitor: (async () => ({ workArea: { size: { width: 2400, height: 1400 } }, scaleFactor: 2 })) as unknown as TauriWindowDeps['currentMonitor'],
    ...overrides,
  } as TauriWindowDeps
  return { deps, calls }
}

test('windowShell 桥接：applyMinWidth 用 Rust 侧要的**外部标签形状**调 set_min_size，且带最小高度（D-041 的形状回归）', async () => {
  const { deps, calls } = makeDeps()
  const shell = new TauriWindowShell(deps)
  await shell.applyMinWidth(520)
  assert.equal(calls.length, 1, '一次应用 = 一次 invoke')
  assert.equal(calls[0]!.command, 'plugin:window|set_min_size')
  assert.deepEqual(calls[0]!.args, { label: 'main', value: { Logical: { width: 520, height: MIN_WINDOW_HEIGHT } } })
})

test('windowShell 桥接：metrics 把物理 px ÷ 缩放读成逻辑 px、工作区按显示器缩放折算；无 DOM / 读数缺失不抛错', async () => {
  const { deps } = makeDeps()
  const shell = new TauriWindowShell(deps)
  const metrics = await shell.metrics()
  assert.ok(metrics)
  assert.equal(metrics.workAreaWidth, 1200) // 2400 / 2
  // node:test 无 `window`：cssWidth = 0 ⇒ 缩放折算记 1（有 DOM 时才 = 逻辑 ÷ css）
  assert.equal(metrics.cssToLogical, 1)
  // 显示器读数缺失（monitor null）⇒ 工作区退回窗口自己的逻辑宽
  const { deps: depsNoMonitor } = makeDeps({ currentMonitor: async () => null })
  const fallback = await new TauriWindowShell(depsNoMonitor).metrics()
  assert.equal(fallback?.workAreaWidth, 1024) // 1536 / 1.5
  // 读数抛错（能力表缺条）⇒ null，不向上抛
  const { deps: depsBroken } = makeDeps({ getCurrentWindow: () => { throw new Error('no window') } })
  assert.equal(await new TauriWindowShell(depsBroken).metrics(), null)
})

test('windowShell 桥接：applyMinWidth 失败静默（不清空既有约束）；watchMetrics 订阅三路事件、解除函数逐路调用', async () => {
  const { deps } = makeDeps({ invoke: async () => { throw new Error('denied') } })
  const shell = new TauriWindowShell(deps)
  await shell.applyMinWidth(520) // 不该抛
  let offs = 0
  const { deps: depsWatch } = makeDeps({
    getCurrentWindow: (() => ({
      label: 'main',
      onResized: async () => () => { offs += 1 },
      onMoved: async () => () => { offs += 1 },
      onScaleChanged: async () => () => { offs += 1 },
      scaleFactor: async () => 1,
      innerSize: async () => ({ width: 100, height: 100 }),
    })) as unknown as TauriWindowDeps['getCurrentWindow'],
  })
  const stop = await new TauriWindowShell(depsWatch).watchMetrics(() => {})
  stop()
  assert.equal(offs, 3, '三个事件各自的解除函数都要被调用')
})
