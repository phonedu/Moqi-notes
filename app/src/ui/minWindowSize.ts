/**
 * 桌面窗口最小宽度的判据（`09-桌面端交互规范` §八 `R09-RESP-19`）。
 *
 * **为什么不是 `tauri.conf.json` 里一个写死的数**：用户机器的屏幕大小与界面缩放都不知道——
 * 写死一个值会在小屏 / 放大档上**大过屏幕**（窗口放不下、人被卡住），写小了又挡不住
 * 「把电脑端窗口拖进手机档」。所以最小宽度按下面三样现算，**每一样都是读数而不是常量**：
 *
 *   `width = min(版面要求 × 界面缩放, 当前显示器工作区 × WORK_AREA_SHARE)`
 *
 * - **版面要求** = 电脑端界面从哪一档起算（`WINDOW_FLOOR_TIER` → 该档起点，见 `breakpoints.ts`）；
 * - **界面缩放** = 逻辑 px ÷ CSS px（`WindowShellPort.metrics()` 现读）。**OS 显示缩放不进入这个数**——
 *   逻辑 px 已经把它吸收掉了：150% 缩放下 1 逻辑 px 与 CSS px 仍一一对应，这正是「用逻辑 px 说话」的理由；
 *   页面缩放（WebView 自己放大）会改变两者的比例，所以要乘进来；
 * - **封顶** = 屏幕工作区（不含任务栏）× `WORK_AREA_SHARE`：屏幕天生放不下版面要求时以屏幕为准
 *   （`limited: 'screen'`），让窗口能落在这块屏幕上——更窄的档位本来就是响应式的职责。
 *
 * 纯函数：读数由 `WindowShellPort` 给、应用由 `useWindowMinSize` 做、平台命令在 `adapters/windowShell.ts`。
 */
import { TIER_START_WIDTH, type WidthTier } from './breakpoints'

/** 绝对下限（逻辑 px）= **手机档已验证的最窄宽度**（360：`accept:MOBILE-A1` 的视口 / `10` §十 的 375
 *  取更窄者）——比这更窄的窗口不提供支持：再往下是没设计过的区域（工具栏那类桌面件会溢出来）。 */
export const MIN_WINDOW_FLOOR = 360

/** 屏幕工作区占比上限。不取 100%：总要留出「还能拖窗、还能并排看一眼别的窗口」的余地。 */
export const WORK_AREA_SHARE = 0.9

/**
 * 版面要求从哪一档起算 = 电脑端界面允许进入的最窄档。
 *
 * - `compact`（现值）：窗口可缩到手机宽度——**验证期口径**：要在电脑端窗口上直接验收移动端版面；
 * - `tablet` / `desktop`（验证期后按 `05` 的待裁项定）：最小值随之上移到该档起点。
 *   两档的差别只有一句：**电脑端要不要进入平板档**（`tablet` = 只挡手机档，`desktop` = 只走电脑端界面）。
 */
export const WINDOW_FLOOR_TIER: WidthTier = 'tablet' // 2026-10-14 裁决（触发点观察区第 8 项）：验证期结束，下限从手机档上移到 tablet——701–899 段留给 0.7 平板两轴当验收台；手机档版面改由真机 / 无头 360 视口验收

export interface MinWindowInput {
  /** 版面要求从哪一档起算（生产调用方一律用 `WINDOW_FLOOR_TIER`；参数留着是为了让用例能逐档验算）。 */
  floorTier: WidthTier
  /** 界面缩放 = 逻辑 px ÷ CSS px（无页面缩放 = 1）。读数非法（≤0 / NaN）时按 1 算。 */
  cssToLogical: number
  /** 当前显示器工作区宽（逻辑 px）。读数缺失（≤0 / NaN）时不封顶。 */
  workAreaWidth: number
}

export interface MinWindowResult {
  /** 要设进窗口的最小宽度（逻辑 px）。 */
  width: number
  /** `layout` = 按版面要求；`screen` = 屏幕放不下，已压到工作区占比（窗口会比版面要求更窄）。 */
  limited: 'layout' | 'screen'
}

export function minWindowWidth(input: MinWindowInput): MinWindowResult {
  const floorCss = input.floorTier === 'compact' ? MIN_WINDOW_FLOOR : TIER_START_WIDTH[input.floorTier]
  const zoom = Number.isFinite(input.cssToLogical) && input.cssToLogical > 0 ? input.cssToLogical : 1
  const wanted = Math.ceil(Math.max(floorCss * zoom, MIN_WINDOW_FLOOR))
  const cap = Math.floor(input.workAreaWidth * WORK_AREA_SHARE)
  if (!Number.isFinite(cap) || cap <= 0) return { width: wanted, limited: 'layout' }
  return { width: Math.min(wanted, cap), limited: wanted > cap ? 'screen' : 'layout' }
}
