/**
 * 语义断点的唯一来源（`08-UI设计令牌与跨端一致性`「响应式断点」；条文执行见 `09-桌面端交互规范` §八）。
 *
 * 四档：**compact ≤700 / tablet 701–899 / desktop 900–1279 / wide ≥1280**——
 * 每个边界都由一条既有规则认领（≤700 手机排版档 `R09-RESP-14` / ≤899 侧栏抽屉 `R09-RESP-13` /
 * ≤1279 页面列改覆盖式抽屉 `R09-RESP-9/11` / ≥1280 三栏 `R09-RESP-1`）。
 *
 * **CSS 的媒体条件读不了 JS 常量**：`app.css` 的媒体块用同值字面量，两端一致性由
 * `pnpm check:breakpoints` 看住（脚本按本文件的表查 CSS / TS / `tauri.conf.json` 三处）。
 * 组件不许再写裸的 `matchMedia('(max-width: …)')`——一律引用 `MQ`。
 */

/** 各档上界（px）；`wide` 无上界。 */
export const TIER_MAX_WIDTH = { compact: 700, tablet: 899, desktop: 1279 } as const

export type WidthTier = keyof typeof TIER_MAX_WIDTH | 'wide'

/** 各档起点（含）——窗口最小宽度按它取「版面要求」（见 `minWindowSize.ts`）。 */
export const TIER_START_WIDTH: Record<WidthTier, number> = {
  compact: 0,
  tablet: TIER_MAX_WIDTH.compact + 1,
  desktop: TIER_MAX_WIDTH.tablet + 1,
  wide: TIER_MAX_WIDTH.desktop + 1,
}

/** 媒体条件（TS 侧唯一写法）。三个条件 = 三处「档位分叉」：手机排版档 / 侧栏常驻 / 页面列并排。 */
export const MQ = {
  compact: `(max-width: ${TIER_MAX_WIDTH.compact}px)`,
  belowDesktop: `(max-width: ${TIER_MAX_WIDTH.tablet}px)`,
  belowWide: `(max-width: ${TIER_MAX_WIDTH.desktop}px)`,
} as const
