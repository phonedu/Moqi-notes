/**
 * 无边框窗口的窗口控制（docs/09 §3.1）。
 *
 * `tauri.conf.json` 里 `decorations: false` 之后，最小化 / 最大化 / 关闭与窗口拉伸
 * 都由应用自己提供。浏览器预览（`pnpm dev`）里没有 Tauri 运行时，这里一律安全降级：
 * 按钮仍然渲染但点了不做事，窗口栏本身照常显示——预览与桌面端长得一样，只是没有真窗口。
 */
export type ResizeDirection = 'North' | 'South' | 'East' | 'West' | 'NorthEast' | 'NorthWest' | 'SouthEast' | 'SouthWest'

const API_BASE = '/src-tauri' // 仅用于判断是否在 Tauri 运行时里（浏览器预览不会有 __TAURI_INTERNALS__）

export function inTauriShell(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function currentWindow(): Promise<{ minimize: () => Promise<void>; toggleMaximize: () => Promise<void>; close: () => Promise<void>; destroy: () => Promise<void>; startResizeDragging: (direction: ResizeDirection) => Promise<void>; isMaximized: () => Promise<boolean>; onResized: (handler: () => void) => Promise<() => void>; onCloseRequested: (handler: (event: { preventDefault: () => void }) => void) => Promise<() => void> } | null> {
  if (!inTauriShell()) return null
  try {
    const mod = await import('@tauri-apps/api/window')
    return mod.getCurrentWindow() as never
  } catch {
    return null
  }
}

export async function minimizeWindow(): Promise<void> {
  const win = await currentWindow()
  try { await win?.minimize() } catch { /* 预览环境或权限不足：忽略 */ }
}

export async function toggleMaximizeWindow(): Promise<void> {
  const win = await currentWindow()
  try { await win?.toggleMaximize() } catch { /* 同上 */ }
}

/**
 * 直接销毁窗口——关闭流程的终点。
 *
 * **不走 `close()`**：注册了 `onCloseRequested` 之后，`close()` 会再绕一圈「关闭请求 → JS 侧 `destroy()`」，
 * 中间任何一环失败（例如少 `core:window:allow-destroy` 权限）都会表现成「点了没反应」。
 * 我们的落盘流程自己决定「什么时候关」，所以直接销毁，路径只有一步、失败也能如实上报。
 */
export async function destroyWindow(): Promise<boolean> {
  const win = await currentWindow()
  if (!win) return true // 浏览器预览：没有真窗口，视为已结束
  try { await win.destroy(); return true } catch { return false }
}

/** 无边框会丢掉系统拉伸边：八个方向由应用自己接管（docs/09 §3.1）。 */
export async function startWindowResize(direction: ResizeDirection): Promise<void> {
  const win = await currentWindow()
  try { await win?.startResizeDragging(direction) } catch { /* 同上 */ }
}

/** 订阅最大化状态：窗口栏的最大化按钮要在「最大化 / 还原」字形之间切换。 */
export async function watchMaximized(handler: (maximized: boolean) => void): Promise<() => void> {
  const win = await currentWindow()
  if (!win) return () => undefined
  try {
    const sync = () => { void win.isMaximized().then(handler).catch(() => undefined) }
    sync()
    return await win.onResized(sync)
  } catch {
    return () => undefined
  }
}

/** 仅用于开发期自检：确认本模块没有被摇树掉。 */
export const WINDOW_CHROME_API_BASE = API_BASE

/**
 * 订阅系统级关闭请求（Alt+F4、任务栏关闭、系统关机）：关闭前要落盘保存队列，
 * 所以这里只负责「拦下请求并交给调用方」，由调用方决定什么时候真正关（docs/09 §3.1 关闭语义）。
 * 浏览器预览没有窗口事件，返回一个空的解除函数。
 */
export async function watchCloseRequested(handler: (event: { preventDefault: () => void }) => void): Promise<() => void> {
  const win = await currentWindow()
  if (!win) return () => undefined
  try {
    return await win.onCloseRequested(handler)
  } catch {
    return () => undefined
  }
}
