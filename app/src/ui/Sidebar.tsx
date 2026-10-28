import type { MouseEvent } from 'react'
import { Icon } from '@moqi/editor'
import { formatRelative } from './format'
import { SidebarStatsView } from './SidebarStats'
import type { SidebarStats } from '@moqi/editor'
import type { SyncStatus, TagSummary, ViewKind } from './types'
import type { ThemeMode } from './uiPrefs'

type SidebarProps = {
  collapsed: boolean
  view: ViewKind
  pageCount: number
  tags: TagSummary[]
  activeTagId: string | null
  /** 「只看星标页面」（活原型 `#navStar` 的 `starFilter`）：与页面库**同一份**筛选条件的 star 档——
      它不是第四个视图，进的是同一个页面库，只是把条件拨过去（`R09-PRIN-1`）。 */
  /** 「页面库」是不是当前所在（活原型 navLib 默认 active）：编辑视图且**没在看星标**——星标那个胶囊接管时要让位。 */
  libraryActive: boolean
  starredActive: boolean
  starCount: number
  onOpenStarred: () => void
  trashCount: number
  /** V2b：侧栏底部那一行归**同步**——它是应用级管道状态（`09-桌面端交互规范` `R09-SYNC-2…5`）。
   *  保存态是「这一篇落盘了没有」，搬到编辑器顶栏跟着页面走，两个状态的归属因此不重叠。 */
  syncStatus: SyncStatus
  theme: ThemeMode
  onOpenLibrary: () => void
  onOpenTrash: () => void
  onOpenSettings: () => void
  onToggleTheme: () => void
  onSelectTag: (tagId: string | null) => void
  onTagMenu: (tag: TagSummary, event: MouseEvent<HTMLButtonElement>) => void
  onKeyboardHelp: () => void
  /** 手机抽屉：不给「页面库」自指行（抽屉只在页面库首页打开）。 */
  compact?: boolean
  /** 侧栏统计（`R09-PRIN-13`）：可选，测试与旧调用点不传时不占位。 */
  stats?: SidebarStats
}

/** V2b：同步状态行四态各自的圆点与文案（`09-桌面端交互规范` `R09-SYNC-2…5`）。设置页复用同一份文案。*/
export function syncPresentation(status: SyncStatus): { st: string; text: string; title: string } {
  switch (status.kind) {
    case 'unconfigured':
      return { st: 'idle', text: '未配置同步', title: '还没设置同步位置——点开去设置' }
    case 'synced':
      return { st: 'ok', text: `已同步 · ${formatRelative(status.at)}`, title: '本机没有待传变更，远端也已经拉完' }
    case 'syncing':
      return { st: 'saving', text: `同步中 · ${status.done}/${status.total}`, title: '正在推送 / 拉取' }
    case 'offline':
      return { st: 'warn', text: `离线 · ${status.pending} 条待同步`, title: '传输不可达；编辑照常，连上后自动补传' }
  }
}

/**
 * 侧栏（docs/09 §1.1；`R09-PRIN-1`）：**只做导航、不放动作**——页面库 / 星标 / 标签列表 / 底部系统区。
 * 搜索与新建的唯一入口 = 页面库头部 🔍 与「＋」（`R09-ICON-4` / `R09-ICON-6`；2026-10-07 从侧栏删除）；
 * 侧栏不显示页面列表——页面浏览统一由页面库卡片网格承担。
 *
 * **任何宽度都不例外**（2026-10-08 用户裁决）：侧栏不放搜索入口——
 * 手机上页面库头部与编辑器顶栏各有一颗 🔍，入口并不缺（`R09-SEARCH-1`）。
 */
export function Sidebar({
  collapsed, view, tags, activeTagId, syncStatus,
  libraryActive, starredActive, starCount, onOpenStarred,
  onOpenLibrary, onOpenTrash, onOpenSettings, onSelectTag, onTagMenu, compact, stats,
}: SidebarProps) {
  const sync = syncPresentation(syncStatus)
  return (
    <aside className={`sidebar ${collapsed ? 'is-collapsed' : ''}`} aria-label="应用侧栏" aria-hidden={collapsed || undefined}>

      <div className="sb-brand">墨契</div>

      {/* 统计三格 → 热力图 → 页面库 → 星标 / 标签（用户 2026-10-24 定序）。 */}
      {stats ? <SidebarStatsView stats={stats} /> : null}

      {/* 侧栏只做导航、不放动作。**搜索也不在这里**（2026-10-08 用户裁决，第 N 次强调）：
          桌面被页面库头部的 🔍 取代；手机上页面库（列表页）自己也有一颗 🔍、看得见点得着 ⇒ 侧栏不再保留「搜索」行。
          新建同理（= 页面库头部的「＋」与手机 FAB）。 */}

      {compact ? null : (
        <button type="button" className={`sb-nav ${libraryActive ? 'is-active' : ''}`} onClick={onOpenLibrary}>
          <Icon name="grid" size={16} decorative />
          <span>页面库</span>
        </button>
      )}

      {/* 星标（活原型 `#navStar`）：进的是**同一个页面库**，只是把筛选条件的 star 档拨到「只看星标」——
          与侧栏标签同一个做法（筛选条件只有一份，住在 EditorShell 的 `libraryFilter`）。
          激活态用与页面库同一条 `is-active` 胶囊（主题色深档 + 翻转字），两者不会同时亮。 */}
      {starCount > 0 ? (
        <button type="button" className={`sb-nav ${starredActive ? 'is-active' : ''}`} onClick={onOpenStarred} title="只看星标页面">
          <Icon name="star" size={16} decorative />
          <span>星标</span>
          <span className="cnt">{starCount}</span>
        </button>
      ) : null}

      {tags.length > 0 ? (
        <>
          <div className="sb-sec">标签</div>
          <div className="sb-tags">
            {tags.map((tag) => (
              <div key={tag.id} className={`sb-tag ${activeTagId === tag.id ? 'is-active' : ''}`}>
                <button
                  type="button"
                  className="sb-tag-open"
                  style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0, color: 'inherit' }}
                  onClick={() => onSelectTag(activeTagId === tag.id ? null : tag.id)}
                  title={`按 #${tag.name} 筛选页面库`}
                >
                  <span className="hash">#</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tag.name}</span>
                </button>
                <button
                  type="button"
                  className="tmore"
                  aria-label={`#${tag.name} 标签操作`}
                  title="重命名 / 合并 / 从所有页面移除"
                  onClick={(event) => onTagMenu(tag, event)}
                >
                  <Icon name="more" size={16} decorative />
                </button>
                <span className="cnt">{tag.count}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <div className="sb-foot">
        <button type="button" className={`sb-tag ${view === 'trash' ? 'is-active' : ''}`} onClick={onOpenTrash}>
          <Icon name="trash" size={16} decorative />
          <span>回收站</span>
        </button>
        <button type="button" className="sb-tag" onClick={onOpenSettings}>
          <Icon name="settings" size={16} decorative />
          <span>设置</span>
        </button>
        {syncStatus.kind === 'syncing' || syncStatus.kind === 'offline' ? (
          <button type="button" className="sb-sync" data-st={sync.st} title={sync.title} onClick={onOpenSettings}>
            <span className="sdot" />
            <span className="stxt">{sync.text}</span>
          </button>
        ) : null}
      </div>
    </aside>
  )
}
