import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './ui/App'
import { installGlobalLogHandlers, logEvent, logLine } from './adapters/logging'

/**
 * 关掉宿主的默认右键菜单（docs/09 §三 `R09-SHELL-2`）。
 *
 * 桌面外壳里右键弹出「刷新 / 检查 / 另存为」是**漏出来的 WebView2 行为**，不是应用功能
 * （用户实测 ）。收口在应用入口这一处，不在各组件里各拦一次；应用自己的右键交互
 * 将来要走显式菜单组件，与这里不冲突——这里只挡宿主默认菜单。
 */
document.addEventListener('contextmenu', (event) => { event.preventDefault() })

// 未捕获错误 / 异步漏网进本地日志（第一现场）；只装一次。
installGlobalLogHandlers()
// 每次启动留一行：日志文件因此永远非空，「导出诊断日志」才有东西可导。
logLine('INFO', 'app boot')
// 启动分段读数：从导航开始到脚本跑起来（冷启动归因的第一个锚点）。
logEvent('perf', 'boot:script', Math.round(performance.now()))
window.addEventListener('load', () => logEvent('perf', 'boot:load', Math.round(performance.now())), { once: true })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
