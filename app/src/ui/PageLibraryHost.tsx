import type { MouseEvent, ReactNode } from 'react'
import { Icon } from '@moqi/editor'
import { PageLibraryView } from './PageLibraryView'
import type { LibraryViewMode } from './menuItems'
import type { LibraryCard } from './types'

type PageLibraryHostProps = {
  visible: boolean
  wideEnoughForColumn: boolean
  compact: boolean
  cards: LibraryCard[]
  activeTagName: string | null
  filterCount: number
  mode: LibraryViewMode
  activePageId: string | null
  noticeSlot: ReactNode
  onSearch: () => void
  onCreate: () => void
  onClearFilter: () => void
  onOpen: (id: string) => void
  onCardMenu: (card: LibraryCard, event: MouseEvent<HTMLButtonElement>) => void
  onToggleStar: (card: LibraryCard) => void
  onFilter: (event: MouseEvent<HTMLButtonElement>) => void
  onModeChange: (mode: LibraryViewMode) => void
  onOpenDrawer: () => void
  onStartResize: (event: MouseEvent) => void
  onBackdrop: () => void
}

/**
 * 页面库列宿主（模块化 M1.4）：页面列 + 手机档 FAB + 窄档遮罩 + 页面列拖拽条。
 *
 * `.ed-split` 与编辑列仍在 `EditorShell`；本组件只负责页面库这一列，
 * `PageLibraryView` 的字段在这里收敛，外壳不再逐个拼。
 */
export function PageLibraryHost({
  visible, wideEnoughForColumn, compact, cards, activeTagName, filterCount, mode, activePageId, noticeSlot,
  onSearch, onCreate, onClearFilter, onOpen, onCardMenu, onToggleStar, onFilter, onModeChange,
  onOpenDrawer, onStartResize, onBackdrop,
}: PageLibraryHostProps) {
  return (
    <>
      {visible ? (
        <>
          {!wideEnoughForColumn ? (
            <div className="col-backdrop" role="presentation" onMouseDown={onBackdrop} />
          ) : null}
          <aside className={`pagecol ${wideEnoughForColumn ? '' : 'is-drawer'}`} aria-label="页面列表">
            {/* 抽屉宿主（窄档抽屉盖住编辑器列）；宽档由编辑器列那份承担。 */}
            {wideEnoughForColumn ? null : noticeSlot}
            <PageLibraryView
              onSearch={onSearch}
              cards={cards}
              activeTagName={activeTagName}
              onClearFilter={onClearFilter}
              onOpen={onOpen}
              onCreate={onCreate}
              onCardMenu={onCardMenu}
              onToggleStar={onToggleStar}
              onFilter={onFilter}
              filterCount={filterCount}
              mode={mode}
              onModeChange={onModeChange}
              activePageId={activePageId}
              compact={compact}
              onOpenDrawer={onOpenDrawer}
            />
            {compact ? (
              <button type="button" className="fab" aria-label="新建页面" title="新建页面" onClick={onCreate}>
                <Icon name="plus" size={22} decorative />
              </button>
            ) : null}
          </aside>
        </>
      ) : null}
      {visible && wideEnoughForColumn ? (
        <div
          className="resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整页面列宽度"
          onMouseDown={onStartResize}
        />
      ) : null}
    </>
  )
}
