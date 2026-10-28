/**
 * `WindowShellPort` 的两条实现（端口接口在 `application/windowShell.ts`）。
 *
 * - `TauriWindowShell`：`@tauri-apps/api/window` 的 `innerSize` / `scaleFactor` / `currentMonitor`，
 *   加最小尺寸用 `plugin:window|set_min_size`（形状见 `applyMinWidth` 的注）。
 *   每条命令各自包 try——能力表少一条不该让别处崩：读数失败返 `null`（本次不应用），应用失败留一条 warn。
 * - `BrowserWindowShell`：浏览器预览没有真窗口——读数为 `null`、应用是 no-op（`pnpm dev` 照常跑）。
 */
import { invoke } from '@tauri-apps/api/core'
import { currentMonitor, getCurrentWindow } from '@tauri-apps/api/window'
import type { WindowShellMetrics, WindowShellPort } from '../application/windowShell'

/**
 * 窗口最小高度（逻辑 px）——**与 `src-tauri/tauri.conf.json` 的 `minHeight` 同值**，
 * 由 `pnpm check:breakpoints` 看住（两处都在，是因为 JS 起来之前只有配置生效）。
 */
export const MIN_WINDOW_HEIGHT = 520

/**
 * Tauri 侧依赖（注入化，`R04-ACCEPT-7` 补层）：`R09-RESP-19` 的「写进真窗口」这一段此前没有
 * 任何验收——只有真窗口人工 G 组兜着。形状错一处的教训就在 `D-041`（`LogicalSize` 类会被
 * Rust 侧打回、最小宽度**静默失效**，浏览器通道与真窗口都看不见报错）。注入之后，
 * `tests/ui/windowShell.test.ts` 把 invoke 的参数形状钉死。
 */
export type TauriWindowDeps = {
  invoke: typeof invoke
  getCurrentWindow: typeof getCurrentWindow
  currentMonitor: typeof currentMonitor
}

const REAL_DEPS: TauriWindowDeps = { invoke, getCurrentWindow, currentMonitor }

export class TauriWindowShell implements WindowShellPort {
  constructor(private readonly deps: TauriWindowDeps = REAL_DEPS) {}

  async metrics(): Promise<WindowShellMetrics | null> {
    try {
      const win = this.deps.getCurrentWindow()
      const scale = await win.scaleFactor()
      const inner = await win.innerSize() // 物理 px
      const logicalWidth = inner.width / scale // 逻辑 px（= CSS px 除以页面缩放，见下）
      const cssWidth = typeof window === 'undefined' ? 0 : window.innerWidth
      const monitor = await this.deps.currentMonitor() // 窗口当前所在显示器；可能为 null（读数缺失）
      const workAreaWidth = monitor ? monitor.workArea.size.width / monitor.scaleFactor : logicalWidth
      return { workAreaWidth, cssToLogical: cssWidth > 0 ? logicalWidth / cssWidth : 1 }
    } catch {
      return null
    }
  }

  /**
   * **形状照 Rust 侧给，刻意不用 `LogicalSize` 类**（2026-10-09 真窗口实测，台账 `D-041`）：
   * 锁版本下 `@tauri-apps/api@2.8.0` 的 `LogicalSize` 序列化成 `{ width, height }`（不带标签），
   * 而 `tauri@2.11.6` 的 `Size` 反序列化要**外部标签** `{ Logical: { … } }`——传类会被打回
   * `invalid args \`value\` … expected map with a single key`，最小宽度**静默失效**（浏览器通道与单测都看不见）。
   * 高度一起给：`set_min_size` 是一整组约束，不给高度等于把 `minHeight` 清掉。
   * 升级轮（`05` 第 11 行 / `D-023`：api 2.12 + crate 2.12）要连同真窗口复验一起过。
   */
  async applyMinWidth(width: number): Promise<void> {
    try {
      const win = this.deps.getCurrentWindow()
      await this.deps.invoke('plugin:window|set_min_size', { label: win.label, value: { Logical: { width, height: MIN_WINDOW_HEIGHT } } })
    } catch (error) {
      console.warn('[windowShell] 应用窗口最小宽度失败（能力表 / 版本形状变了？）', error)
    }
  }

  async watchMetrics(handler: () => void): Promise<() => void> {
    try {
      const win = this.deps.getCurrentWindow()
      const offs = await Promise.all([
        win.onResized(handler),
        win.onMoved(handler), // 跨显示器：工作区与缩放都可能变，而尺寸可能没变
        win.onScaleChanged(handler), // 系统显示缩放变化
      ])
      return () => { for (const off of offs) off() }
    } catch {
      return () => undefined
    }
  }
}

class BrowserWindowShell implements WindowShellPort {
  async metrics(): Promise<WindowShellMetrics | null> { return null }
  async applyMinWidth(): Promise<void> { /* 浏览器预览没有真窗口可约束 */ }
  async watchMetrics(): Promise<() => void> { return () => undefined }
}

/** 桌面壳（含 Android）走 Tauri，其余走浏览器实现——与备份 / 导出 / 资产端口同一个开关。 */
export function createDefaultWindowShell(): WindowShellPort {
  const tauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  return tauri ? new TauriWindowShell() : new BrowserWindowShell()
}
