import { EditorComposer } from '@moqi/editor'
import { AppShell } from './AppShell'
import { EditorMainContent } from './EditorMainContent'
import { EditorOverlays } from './EditorOverlays'
import { resolveTheme } from './uiPrefs'
import { startWindowResize } from './windowChrome'
import type { EditorAppRuntime } from './useEditorRuntime'

/**
 * 应用外框（模块化 M1.7）：Lexical 宿主 + `AppShell`，主内容与浮层分别交给两个组件。
 * 这一层只做装配，不持有编辑器命令或保存队列。
 */
export function EditorChrome({ runtime }: { runtime: EditorAppRuntime }) {
  const { prefs, pageColumnVisible, wideEnoughForColumn, sidebarShown, compact, view, libraryCards, libraryFilter } = runtime
  return (
    <EditorComposer initialConfig={runtime.initialConfig}>
      <AppShell
        sidebarWidth={prefs.sidebarWidth}
        pagecolWidth={prefs.pagecolWidth}
        pagecolVisibleWidth={pageColumnVisible && wideEnoughForColumn ? prefs.pagecolWidth : 0}
        sidebarCollapsed={prefs.sidebarCollapsed}
        sidebarShown={sidebarShown}
        compact={compact}
        view={view}
        pageCount={libraryCards.length}
        libraryActive={view === 'editor' && libraryFilter.star !== 'starred'}
        starredActive={view === 'editor' && libraryFilter.star === 'starred'}
        starCount={libraryCards.filter((card) => card.starred).length}
        tags={runtime.tagSummaries}
        activeTagId={runtime.activeLibraryTagId}
        trashCount={runtime.trashEntries.length}
        syncStatus={runtime.syncStatus}
        stats={runtime.sidebarStats}
        theme={resolveTheme(prefs.mode)}
        drawerOpen={runtime.drawerOpen}
        narrow={runtime.narrow}
        onOpenStarred={() => { runtime.toggleStarFilter(); runtime.closeDrawer() }}
        onOpenLibrary={() => { runtime.setView('editor'); runtime.closeDrawer() }}
        onOpenTrash={() => { runtime.setView('trash'); runtime.closeDrawer() }}
        onOpenSettings={() => { runtime.openSettingsView(); runtime.closeDrawer() }}
        onToggleTheme={() => runtime.updatePrefs({ ...prefs, mode: resolveTheme(prefs.mode) === 'dark' ? 'light' : 'dark' })}
        onSelectTag={(tagId) => { runtime.toggleTagFilter(tagId); runtime.closeDrawer() }}
        onTagMenu={(tag, event) => {
          event.stopPropagation()
          runtime.openMenu('tag', event.currentTarget, { tag })
        }}
        onKeyboardHelp={() => { runtime.openDialog({ kind: 'keyboard' }); runtime.closeDrawer() }}
        onCloseDrawer={runtime.closeDrawer}
        onStartSidebarResize={runtime.startResize('sidebar')}
        onStartWindowResize={(direction) => { void startWindowResize(direction) }}
        pageListShown={!prefs.listColumnCollapsed}
        onToggleSidebar={runtime.toggleSidebar}
        onTogglePageList={runtime.togglePageList}
        onCloseRequest={runtime.requestClose}
        trashEntries={runtime.trashEntries}
        trashNoticeSlot={runtime.band(runtime.settingsOpen)}
        onTrashBack={() => runtime.setView('editor')}
        onTrashCloseSheet={() => runtime.setView('editor')}
        onRestoreTrash={runtime.restorePage}
        onPurgeTrash={(id) => runtime.openPurgeDialog([id])}
        onEmptyTrash={() => runtime.openPurgeDialog(runtime.trashEntries.map((entry) => entry.id))}
        main={<EditorMainContent runtime={runtime} />}
        overlays={<EditorOverlays runtime={runtime} />}
      />
    </EditorComposer>
  )
}
