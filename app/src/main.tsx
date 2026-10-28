import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './ui/App'

/**
 * 关掉宿主的默认右键菜单（docs/09 §三 `R09-SHELL-2`）。
 *
 * 桌面外壳里右键弹出「刷新 / 检查 / 另存为」是**漏出来的 WebView2 行为**，不是应用功能
 * （用户实测 2026-09-30）。收口在应用入口这一处，不在各组件里各拦一次；应用自己的右键交互
 * 将来要走显式菜单组件，与这里不冲突——这里只挡宿主默认菜单。
 */
document.addEventListener('contextmenu', (event) => { event.preventDefault() })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
