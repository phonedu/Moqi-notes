import { useEffect, useState } from 'react'
import { WindowBar } from './WindowBar'
import { minimizeWindow, toggleMaximizeWindow, watchMaximized } from './windowChrome'

type WindowBarHostProps = {
  sidebarShown: boolean
  pageListShown: boolean
  onToggleSidebar: () => void
  onTogglePageList: () => void
  onClose: () => void
}

/**
 * 窗口标题栏宿主（模块化 M1.2b）：`WindowBar` + 「最大化」呈现状态/平台监听。
 *
 * 只接管窗口呈现（最大化 / 最小化 / 还原），**不接管关闭语义**——关闭要先落盘，
 * 仍由 `EditorShell` 的 `requestClose` 传进来。下一刀再把这一整块接到 `AppShell`。
 */
export function WindowBarHost({ sidebarShown, pageListShown, onToggleSidebar, onTogglePageList, onClose }: WindowBarHostProps) {
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    let stop: (() => void) | undefined
    let cancelled = false
    void watchMaximized(setMaximized).then((off) => { if (cancelled) off(); else stop = off })
    return () => { cancelled = true; stop?.() }
  }, [])

  return (
    <WindowBar
      sidebarShown={sidebarShown}
      pageListShown={pageListShown}
      onToggleSidebar={onToggleSidebar}
      onTogglePageList={onTogglePageList}
      maximized={maximized}
      onMinimize={() => void minimizeWindow()}
      onToggleMaximize={() => void toggleMaximizeWindow()}
      onClose={onClose}
    />
  )
}
