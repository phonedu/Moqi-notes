import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { Sidebar } from './Sidebar'
import { TrashHost } from './TrashHost'
import { WindowBarHost } from './WindowBarHost'
import type { SidebarStats } from '@moqi/editor'
import type { SyncStatus, TagSummary, TrashEntry, ViewKind } from './types'
import type { ThemeMode } from './uiPrefs'
import type { ResizeDirection } from './windowChrome'

type AppShellProps = {
  sidebarWidth: number
  pagecolWidth: number
  pagecolVisibleWidth: number
  sidebarCollapsed: boolean
  sidebarShown: boolean
  compact: boolean
  view: ViewKind
  pageCount: number
  libraryActive: boolean
  starredActive: boolean
  starCount: number
  tags: TagSummary[]
  activeTagId: string | null
  trashCount: number
  syncStatus: SyncStatus
  stats: SidebarStats
  theme: ThemeMode
  drawerOpen: boolean
  narrow: boolean
  onOpenStarred: () => void
  onOpenLibrary: () => void
  onOpenTrash: () => void
  onOpenSettings: () => void
  onToggleTheme: () => void
  onSelectTag: (tagId: string | null) => void
  onTagMenu: (tag: TagSummary, event: ReactMouseEvent<HTMLButtonElement>) => void
  onKeyboardHelp: () => void
  onCloseDrawer: () => void
  onStartSidebarResize: (event: ReactMouseEvent) => void
  onStartWindowResize: (direction: ResizeDirection) => void
  pageListShown: boolean
  onToggleSidebar: () => void
  onTogglePageList: () => void
  onCloseRequest: () => void
  trashEntries: TrashEntry[]
  trashNoticeSlot: ReactNode
  onTrashBack: () => void
  onTrashCloseSheet: () => void
  onRestoreTrash: (id: string) => void
  onPurgeTrash: (id: string) => void
  onEmptyTrash: () => void
  /** 编辑区/页面库/设置/EditorPlugins 的 `.main` 内容。 */
  main: ReactNode
  /** 菜单、浮层与全局弹窗；排在 `.main` 之后、`.app-body` 之内。 */
  overlays: ReactNode
}

/**
 * 应用外壳（模块化 M1.1）：窗口拉伸边、三栏骨架、侧栏、抽屉遮罩、侧栏拖拽条。
 *
 * **不含**编辑器内容与浮层——那些作为 `children` 原样放回 `.app-body` 里，
 * 所以这一刀不改变 DOM 顺序、也不让外壳知道 Lexical。页面库/回收站/设置/同步的搬出
 * 是后续 M1 小步，不在这一刀里。
 */
export function AppShell({
  sidebarWidth, pagecolWidth, pagecolVisibleWidth, sidebarCollapsed, sidebarShown,
  compact, view, pageCount, libraryActive, starredActive, starCount, tags, activeTagId,
  trashCount, syncStatus, stats, theme, drawerOpen, narrow,
  onOpenStarred, onOpenLibrary, onOpenTrash, onOpenSettings, onToggleTheme, onSelectTag,
  onTagMenu, onKeyboardHelp, onCloseDrawer, onStartSidebarResize, onStartWindowResize,
  pageListShown, onToggleSidebar, onTogglePageList, onCloseRequest,
  trashEntries, trashNoticeSlot, onTrashBack, onTrashCloseSheet, onRestoreTrash, onPurgeTrash, onEmptyTrash,
  main, overlays,
}: AppShellProps) {
  const style = {
    '--side-w': `${sidebarWidth}px`,
    '--pagecol-w': `${pagecolWidth}px`,
    // 标题栏左缘基准（三色分块体系 §一-3/4）：页面列在流里时 = 页面库宽度；否则 0。
    '--pagecol-visible-w': `${pagecolVisibleWidth}px`,
  } as CSSProperties

  return (
    <div className="app" style={style}>
      {/* 无边框窗口丢掉系统拉伸边，八个方向由应用接管。 */}
      {(['North', 'South', 'East', 'West', 'NorthEast', 'NorthWest', 'SouthEast', 'SouthWest'] as const).map((dir) => (
        <div key={dir} className={`wresize wresize-${dir}`} onMouseDown={() => onStartWindowResize(dir)} role="presentation" />
      ))}
      <div className="app-body">
        <Sidebar
          collapsed={!sidebarShown}
          compact={compact}
          view={view}
          pageCount={pageCount}
          libraryActive={libraryActive}
          starredActive={starredActive}
          starCount={starCount}
          onOpenStarred={onOpenStarred}
          tags={tags}
          activeTagId={activeTagId}
          trashCount={trashCount}
          syncStatus={syncStatus}
          stats={stats}
          theme={theme}
          onOpenLibrary={onOpenLibrary}
          onOpenTrash={onOpenTrash}
          onOpenSettings={onOpenSettings}
          onToggleTheme={onToggleTheme}
          onSelectTag={onSelectTag}
          onTagMenu={onTagMenu}
          onKeyboardHelp={onKeyboardHelp}
        />
        {narrow && drawerOpen ? (
          <div className="side-backdrop" role="presentation" onMouseDown={onCloseDrawer} />
        ) : null}

        {/* 三栏宽度可拖（docs/09 §八）：侧栏右侧的分隔条。 */}
        {sidebarCollapsed || narrow ? null : (
          <div
            className="resizer"
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动调整侧栏宽度"
            onMouseDown={onStartSidebarResize}
          />
        )}

        <div className="main">
          <WindowBarHost
            sidebarShown={sidebarShown}
            pageListShown={pageListShown}
            onToggleSidebar={onToggleSidebar}
            onTogglePageList={onTogglePageList}
            onClose={onCloseRequest}
          />
          <TrashHost
            view={view}
            compact={compact}
            entries={trashEntries}
            noticeSlot={trashNoticeSlot}
            onBack={onTrashBack}
            onCloseSheet={onTrashCloseSheet}
            onRestore={onRestoreTrash}
            onPurge={onPurgeTrash}
            onEmptyTrash={onEmptyTrash}
          />
          {main}
        </div>
        {overlays}
      </div>
    </div>
  )
}
