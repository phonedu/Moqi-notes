import { Icon } from '@moqi/editor'

/**
 * 无边框窗口的标题栏（`09` `R09-WBAR-15`； 移动骨架批从 `EditorShell` 整块搬出——
 * 「按主题拆模块」，行为零变化）。左缘 = 面板开关（☰/▣，收起与否位置恒定）、中段 = 空白拖拽区
 * （双击最大化）、右缘 = 窗口三键（窄窗也要永远可达，`accept:WINDOW-FIT-1`）。
 *
 * 移动骨架（`10` §三）里两个开关由 CSS 在 compact 档收起——导航改由首页的 ☰（开抽屉）与
 * 编辑器的 ←（返回首页）承担；窗口三键不动（桌面窗口本身就是移动端版面的验收台）。
 */
export function WindowBar({ sidebarShown, pageListShown, onToggleSidebar, onTogglePageList, maximized, onMinimize, onToggleMaximize, onClose }: {
  sidebarShown: boolean
  pageListShown: boolean
  onToggleSidebar: () => void
  onTogglePageList: () => void
  maximized: boolean
  onMinimize: () => void
  onToggleMaximize: () => void
  onClose: () => void
}) {
  return (
    <div className="wbar" data-tauri-drag-region>
      {/* 侧栏 / 页面列表的快捷键真值是 ⌘\ 与 ⌘⇧\；提示文案此前漏了反斜杠（JSX 属性 `\` 字面量、JS 字符串 `\\`，见 `13-偏差台账` D-037）。 */}
      <button type="button" className={`tb-btn ${sidebarShown ? 'is-on' : ''}`} aria-label="折叠或展开侧栏（⌘\）" aria-pressed={sidebarShown} title={sidebarShown ? '折叠侧栏（⌘\\）' : '显示侧栏（⌘\\）'} onClick={onToggleSidebar}>
        <Icon name="panel-left" size={17} decorative />
      </button>
      <button type="button" className={`tb-btn ${pageListShown ? 'is-on' : ''}`} aria-label="页面列表（⌘⇧\）" aria-pressed={pageListShown} title={pageListShown ? '折叠页面列表（⌘⇧\\）' : '显示页面列表（⌘⇧\\）'} onClick={onTogglePageList}>
        <Icon name="list" size={17} decorative />
      </button>
      <span className="wbar-drag" data-tauri-drag-region="" />
      <button type="button" className="wctl" aria-label="最小化" title="最小化" onClick={onMinimize}><Icon name="minimize" size={14} decorative /></button>
      <button type="button" className="wctl" aria-label={maximized ? '还原' : '最大化'} title={maximized ? '还原' : '最大化'} onClick={onToggleMaximize}><Icon name={maximized ? 'window-restore' : 'maximize'} size={13} decorative /></button>
      <button type="button" className="wctl close" aria-label="关闭窗口" title="关闭窗口" onClick={onClose}><Icon name="x" size={15} decorative /></button>
    </div>
  )
}
