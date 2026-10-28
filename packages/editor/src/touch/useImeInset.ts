import { useEffect, useState } from 'react'

/**
 * 软键盘（IME）高度读数 —— `#8` 的**单一读数源**，口径住 `10` 二册 §6.3「软键盘与视口」。
 *
 * 键盘高度 = `innerHeight − visualViewport.height − visualViewport.offsetTop`（取 0 下限）；
 * 结果写成**运行时 CSS 变量 `--kb-h`**（挂 `document.documentElement`）——**不进 `tokens.css`**：
 * 它不是主题 / 结构令牌，只是本机瞬时读数（避免进值层主题门）。
 *
 * 为什么需要它（`#8` 的两条宿主档，一套代码不分叉）：
 * - 宿主 `adjustResize` 生效 ⇒ WebView 视口本身矮下去（`innerHeight` 与 `visualViewport.height` 同缩）
 *   ⇒ `--kb-h ≈ 0`，布局靠 `dvh` / `height:100%` 自然重排；
 * - 宿主不让位（edge-to-edge 未消费 IME inset / `adjustPan`）⇒ `--kb-h > 0`，由本变量把
 *   **下沿锚定面**抬到键盘上方（`.mbar` / `.capsule` / `.sheet` / `.mdock` / `.side-panel` /
 *   compact `.mask` / `.doc-col` 底部预留）。
 *
 * 谁消费：`app.css`（`var(--kb-h, 0px)`）。谁挂载：`ui/touchEditorLayer.tsx` 的 `useTouchEditorLayer`
 * （编辑器常驻，全应用唯一一次）。边界：`ui/` 不直连内核（边界门 ③），这里只碰 `visualViewport`。
 */

/** 纯读数（可测；无 `visualViewport` 的桌面 / SSR / 测试环境 ⇒ 0）。 */
export function readImeInset(
  viewport: { height: number; offsetTop: number } | null | undefined = typeof window === 'undefined' ? null : window.visualViewport,
  innerHeight: number = typeof window === 'undefined' ? 0 : window.innerHeight,
): number {
  if (!viewport || !innerHeight) return 0
  return Math.max(0, Math.round(innerHeight - viewport.height - viewport.offsetTop))
}

/**
 * 订阅键盘高度并把 `--kb-h` 写到根元素。**只在事件回调里 setState**（不在 effect 体内同步 setState ——
 * 初始值走 `useState` 派生，避免 `react-hooks/set-state-in-effect`）。
 */
export function useImeInset(): number {
  const [inset, setInset] = useState<number>(() => readImeInset())

  useEffect(() => {
    const update = () => setInset(readImeInset())
    window.visualViewport?.addEventListener('resize', update)
    window.visualViewport?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      window.visualViewport?.removeEventListener('resize', update)
      window.visualViewport?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [])

  useEffect(() => {
    document.documentElement.style.setProperty('--kb-h', `${inset}px`)
  }, [inset])

  return inset
}
