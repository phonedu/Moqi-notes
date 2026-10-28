/**
 * 窗口壳端口（`09-桌面端交互规范` §八 `R09-RESP-19`）：窗口最小宽度的**读**与**写**。
 *
 * 为什么是端口：这两件事都是**平台 IO**（读显示器与窗口的缩放、给真窗口设最小尺寸）——
 * UI 不许直接碰 `@tauri-apps/**`（边界门 ④）。实现放 `adapters/windowShell.ts`、从合成根 `composition.ts` 接线。
 * 浏览器预览没有真窗口：`metrics()` 返回 `null`、`applyMinWidth` 是 no-op、订阅返回空解除函数
 * （与 `windowChrome.ts` 的降级同一口径——预览照常跑，只是没有真窗口可约束）。
 */
export interface WindowShellMetrics {
  /** 当前显示器工作区宽（逻辑 px）——最小宽度的封顶依据。 */
  workAreaWidth: number
  /** 界面缩放 = 逻辑 px ÷ CSS px（无页面缩放 = 1；OS 显示缩放不进入这个数，见 `ui/minWindowSize.ts`）。 */
  cssToLogical: number
}

export interface WindowShellPort {
  /** 读一次「算最小宽度要什么」；无真窗口（浏览器预览）或读数失败时为 `null`（本次不应用，等下一次事件）。 */
  metrics(): Promise<WindowShellMetrics | null>
  /** 应用窗口最小宽度（逻辑 px）；无真窗口时 no-op，失败静默（不清空任何既有约束）。 */
  applyMinWidth(width: number): Promise<void>
  /** 订阅「读数可能变了」：跨显示器 / 分辨率 / 系统缩放 / 页面缩放 / 窗口尺寸变化。返回解除函数。 */
  watchMetrics(handler: () => void): Promise<() => void>
}
