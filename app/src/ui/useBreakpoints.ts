/**
 * 断点三问（`08` 四档表 / `09` §八）：窗口宽度 →「是不是窄屏」「是不是手机排版档」「页面列放不放得下」。
 *
 * - **首屏就按真实宽度判定**：只在跨断点时更新的话，窗口本来就窄时抽屉 / 遮罩 / 关闭入口都不会生效。
 * - **媒体条件取自 `breakpoints.ts` 的 `MQ`**：组件不许裸写 `matchMedia('(max-width: …)')`（`check:breakpoints` 看住）。
 * - **`onNarrowCrossed`** 只做一件事：跨 ≤899px 时通知调用方重置抽屉「呈现」
 *   （`panelLayout.onBreakpointCrossed`——它绝不包含用户意图，见 `09` §八 `R09-RESP-15`）。
 *   **调用方给它稳定引用**（`useCallback`）：它变了就重装订阅（EditorShell 就是这么传的）。
 */
import { useEffect, useState } from 'react'
import { MQ } from './breakpoints'
import { matchMediaSafe } from './shellSupport'

export interface WidthTiers {
  /** 侧栏是不是覆盖式抽屉（≤899px）。 */
  narrow: boolean
  /** 是不是手机排版档（≤700px）。 */
  compact: boolean
  /** 页面列放不放得下并排（≥1280px 才放得下三栏）。 */
  wideEnoughForColumn: boolean
}

export function useBreakpoints(onNarrowCrossed: () => void): WidthTiers {
  const [tiers, setTiers] = useState<WidthTiers>(() => ({
    narrow: matchMediaSafe(MQ.belowDesktop),
    compact: matchMediaSafe(MQ.compact),
    wideEnoughForColumn: !matchMediaSafe(MQ.belowWide),
  }))

  useEffect(() => {
    const narrowQuery = window.matchMedia(MQ.belowDesktop)
    const compactQuery = window.matchMedia(MQ.compact)
    const columnQuery = window.matchMedia(MQ.belowWide)
    const onNarrow = (event: MediaQueryListEvent) => {
      setTiers((current) => ({ ...current, narrow: event.matches }))
      onNarrowCrossed()
    }
    const onCompact = (event: MediaQueryListEvent) => setTiers((current) => ({ ...current, compact: event.matches }))
    const onColumn = (event: MediaQueryListEvent) => setTiers((current) => ({ ...current, wideEnoughForColumn: !event.matches }))
    narrowQuery.addEventListener('change', onNarrow)
    compactQuery.addEventListener('change', onCompact)
    columnQuery.addEventListener('change', onColumn)
    return () => {
      narrowQuery.removeEventListener('change', onNarrow)
      compactQuery.removeEventListener('change', onCompact)
      columnQuery.removeEventListener('change', onColumn)
    }
  }, [onNarrowCrossed])

  return tiers
}
