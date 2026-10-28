/**
 * 窗口最小宽度的一生（`09-桌面端交互规范` §八 `R09-RESP-19`）：读数 → 判据 → 应用，之后每次都重来。
 *
 * 为什么要重算：最小宽度的三个输入都可能在使用中变——窗口拖到别的显示器（工作区变了）、
 * 系统显示缩放改了、页面缩放了、窗口尺寸变了。只在启动算一次，换块屏幕就不对了。
 * **两路触发**（各管一段，都实测过）：
 * - **网页 `resize`**（主路径）：窗口尺寸变化与页面缩放都会让它响——`resize` 事件在真窗口里必达，
 *   不经过平台事件层；
 * - **`WindowShellPort.watchMetrics`**（补充）：跨显示器 / 系统缩放变化时尺寸可能**没变**，
 *   这时只有平台的 resize / move / scale 事件知道。
 * 事件合并：两路都会连发，`APPLY_DEBOUNCE_MS` 合并一次再算（IPC 不贵，但没必要每个像素打一次）。
 *
 * 判据在 `minWindowSize.ts`（纯函数），平台命令在 `adapters/windowShell.ts`——本模块只有生命周期。
 */
import { useEffect } from 'react'
import type { WindowShellPort } from '../application/windowShell'
import { WINDOW_FLOOR_TIER, minWindowWidth } from './minWindowSize'

const APPLY_DEBOUNCE_MS = 200

export function useWindowMinSize(shell: WindowShellPort): void {
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const apply = async (): Promise<void> => {
      const metrics = await shell.metrics()
      if (!alive || metrics === null) return
      await shell.applyMinWidth(minWindowWidth({ floorTier: WINDOW_FLOOR_TIER, ...metrics }).width)
    }
    const schedule = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => void apply(), APPLY_DEBOUNCE_MS)
    }
    void apply()
    window.addEventListener('resize', schedule)
    let stop: (() => void) | undefined
    void shell.watchMetrics(schedule).then((off) => { if (alive) stop = off; else off() })
    return () => {
      alive = false
      clearTimeout(timer)
      window.removeEventListener('resize', schedule)
      stop?.()
    }
  }, [shell])
}
