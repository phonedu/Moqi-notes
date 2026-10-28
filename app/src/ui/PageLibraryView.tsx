import { useLayoutEffect, useRef, type MouseEvent } from 'react'
import { Icon } from '@moqi/editor'
import type { LibraryViewMode } from './menuItems'
import type { LibraryCard } from './types'

type CardActions = {  onOpen: (id: string) => void
  onCardMenu: (card: LibraryCard, event: MouseEvent<HTMLButtonElement>) => void
  /** V2b：卡片头部 ★ 是星标的快捷取消入口（`R09-CARD-3`）。 */
  onToggleStar: (card: LibraryCard) => void
}

type PageLibraryViewProps = CardActions & {
  cards: LibraryCard[]
  /** 当前生效的标签筛选名；为 null 表示未筛选。 */
  activeTagName: string | null
  onClearFilter: () => void
  onCreate: () => void
  onSearch: () => void
  /** V2c：当前生效的筛选条件数（徽章读它，`R09-FILT-7`）。 */
  filterCount: number
  onFilter: (event: MouseEvent<HTMLButtonElement>) => void
  mode: LibraryViewMode
  onModeChange: (mode: LibraryViewMode) => void
  /** 当前打开的页面：列表 / 简约里高亮它。 */
  activePageId?: string | null
  /** 移动骨架（`10` §4.1，4a）：compact 档头部换成移动形态——左缘 ☰（开抽屉）+「页面库」标题；
      形态切换与 ＋新建由 CSS 收起（手机上一种形态、新建归 FAB）。 */
  compact?: boolean
  onOpenDrawer?: () => void
}

/** 头部信息段：更新时间 + 已星标 ★ + ⋯ 菜单。 */
function CardHeader({ card, onCardMenu, onToggleStar }: { card: LibraryCard; onCardMenu: CardActions['onCardMenu']; onToggleStar: CardActions['onToggleStar'] }) {
  return (
    <div className="hd">
      {/* 置顶标记放在时间之前（用户口径 ）：置顶页只是排在前面的话，
          页面一多就看不出置顶区到哪结束了。 */}
      {card.pinned ? <span className="ppin">已置顶</span> : null}
      <span className="tm"><b>{card.updatedLabel}</b></span>
      {/* `R09-CARD-3`：星标后头部出现 ★ 作为快捷取消入口；未星标时不占位。 */}
      {card.starred ? (
        <button
          type="button"
          className="pstar is-on"
          aria-label={`取消星标 ${card.name || '未命名页面'}`}
          title="取消星标"
          onClick={(event) => { event.stopPropagation(); onToggleStar(card) }}
        >
          <Icon name="star-filled" size={16} decorative />
        </button>
      ) : null}
      <button
        type="button"
        className="pmore"
        aria-label={`${card.name || '未命名页面'} 更多操作`}
        title="更多操作"
        onClick={(event) => { event.stopPropagation(); onCardMenu(card, event) }}
      >
        <Icon name="more" size={16} decorative />
      </button>
    </div>
  )
}

/**
 * 列表卡片：四段结构（头部信息 / 内容 / 属性行 / 反链行），三行正文**直接截断**（`-webkit-line-clamp`
 * 截在行边界 + 省略号；**不做渐隐遮罩**—— 用户裁决，docs/09 §4.1）：
 * - 「展开」在**内容区右下角**（`R09-CARD-2`）——不占卡片自己的行；
 * - 「收起」是**浮动**的 sticky 胶囊（原型 `.clps`：`position: sticky; bottom: 10px; margin: 12px 0 2px auto`，
 *   下限为内容末尾），展开后随滚动悬浮，落在内容末尾就位；
 * - 两者都只在内容真溢出时出现，且样式同为胶囊、不带图标（用户口径 ）。
 * 卡片固定默认高 `--list-card-h`（内容区吃剩余高度、属性 / 反链行贴底），展开时 `height: auto` 自增。
 */
function ListCard({ card, actions, current }: { card: LibraryCard; actions: CardActions; current: boolean }) {
  return (
    <article
      className={`lcard ${current ? 'cur' : ''}`}
      onClick={(event) => {
        const target = event.target as HTMLElement
        if (target.closest('button')) return
        actions.onOpen(card.id)
      }}
    >
      <CardHeader card={card} onCardMenu={actions.onCardMenu} onToggleStar={actions.onToggleStar} />
      <div className="bd">
        <button type="button" className="bd-open" aria-label={`打开页面 ${card.name || '未命名页面'}`} onClick={() => actions.onOpen(card.id)}>
          <h3>{card.name || '未命名页面'}</h3>
        </button>
        <div className="cnt clamp">
          {card.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
        </div>
      </div>
      {/* 图片 / 附件缩略图条：V3 媒体块落地后接在这里（docs/09 §4.1）。 */}
    </article>
  )
}

/** 简约卡片：同样四段，压扁成「头部一行 + 标题与两行正文 + 脚注行（属性 / 反链）」，不设展开。 */
function CompactCard({ card, actions, current }: { card: LibraryCard; actions: CardActions; current: boolean }) {
 // 两行截断走 `-webkit-line-clamp`（截在行边界，不做渐隐——）；简约卡**不设展开入口**，
  // 所以不需要溢出测量（原来那套 `useContentOverflow` 只为渐隐服务，已随渐隐一起删）。
  return (
    <article
      className={`scard ${current ? 'cur' : ''}`}
      onClick={(event) => {
        const target = event.target as HTMLElement
        if (target.closest('button')) return
        actions.onOpen(card.id)
      }}
    >
      <CardHeader card={card} onCardMenu={actions.onCardMenu} onToggleStar={actions.onToggleStar} />
      <div className="bd">
        <button type="button" className="bd-open" aria-label={`打开页面 ${card.name || '未命名页面'}`} onClick={() => actions.onOpen(card.id)}>
          <h3>{card.name || '未命名页面'}</h3>
        </button>
        <div className="cnt clamp">
          {card.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
        </div>
      </div>
      <div className="foot">
        <span className="sp" />
        {card.backlinkCount > 0 ? (
          // 图谱入口隐藏优于灰着（`W5`）：条数留成纯文本。
          <span className="blb" title="反向链接条数（图谱入口随图谱功能一起来）"><Icon name="link" size={12} decorative /> {card.backlinkCount}</span>
        ) : null}
      </div>
    </article>
  )
}

/**
 * 列表滚动位置跨「折叠 / 展开」保留：页面列折叠时本组件**整体卸载**
 * （`EditorShell` 里是 `pageColumnVisible ? … : null`），不记一笔的话再打开就回到开头——
 * 用户实测 「点开一张卡片后再展开页面库，不保持在上次那张卡片的位置，直接回到开头」。
 * 键按「位置（整页 `full` / 侧列 `column`）× 列表形态（列表 / 简约）」分开，两种形态各有各的位置。
 * 放在模块级：它要活过组件的卸载。
 */
const stackScrollMemo = new Map<string, number>()

/**
 * 页面库 = **编辑器左侧那一栏**（`09-桌面端交互规范` §八 的 `R09-RESP-3`；整页页面库视图已移除）。
 * 两种形态共用一份卡片数据：列表 = 四段齐全、可展开；简约 = 紧凑多行，适合快速翻找。
 */
export function PageLibraryView({
  cards, activeTagName, onClearFilter, onOpen, onCreate, onCardMenu, onToggleStar, onSearch, onFilter, filterCount,
  mode, activePageId, compact, onOpenDrawer,
}: PageLibraryViewProps) {
  const filtering = activeTagName !== null
  const actions: CardActions = { onOpen, onCardMenu, onToggleStar }
  const effectiveMode: LibraryViewMode = mode

  const stackRef = useRef<HTMLDivElement | null>(null)
  const scrollKey = effectiveMode
  // 恢复上次的滚动位置（`useLayoutEffect`：在绘制前落位，不会先闪一帧顶部）。
  useLayoutEffect(() => {
    const element = stackRef.current
    const saved = stackScrollMemo.get(scrollKey)
    if (element && saved) element.scrollTop = saved
  }, [scrollKey])

  return (
    <>
      <div className="pagecol-head">
        {/* 移动骨架的首页头（`10` §三/§4.1）：[☰ 抽屉]「页面库」——形态切换与 ＋新建由 CSS 收起。 */}
        {compact ? (
          <>
            <button type="button" className="tb-btn" aria-label="打开抽屉" title="打开抽屉" onClick={onOpenDrawer}>
              <Icon name="menu" size={18} decorative />
            </button>
            <span className="pc-title">页面库</span>
          </>
        ) : null}
        {compact ? null : (
          <span className="pc-title">{activeTagName ? `#${activeTagName}` : '全部页面'}</span>
        )}
        <span className="sp" />
        <button type="button" className="tb-btn" aria-label="全局搜索（⌘K）" title="全局搜索（⌘K）" onClick={onSearch}>
          <Icon name="search" size={16} decorative />
        </button>
        <button type="button" className="tb-btn" aria-label="筛选" title="筛选（排序与条件）" onClick={onFilter}>
          {filterCount > 0 ? <span className="bdg" aria-label={`已设 ${filterCount} 个条件`}>{filterCount}</span> : null}
          <Icon name="filter" size={16} decorative />
        </button>
        {/* ＋新建（原型 `.lc-new`）：**就地新建的主入口**，住在页面库头部——
            按指令 §九-5「搜索 / 新建不放侧栏，唯一入口 = 中间栏页面库头部」。 */}
        <button type="button" className="col-new" aria-label="新建页面" title="新建页面（⌘N）" onClick={onCreate}>
          <Icon name="plus" size={16} decorative />
        </button>
      </div>

      {filtering ? (
        <div className="lib-chips">
          <button type="button" className="chip on" aria-label="清除标签筛选" title="清除标签筛选" onClick={onClearFilter}>#{activeTagName} ✕</button>
        </div>
      ) : null}

      {cards.length === 0 ? (
        <div className="pagecol-empty">
          {filtering ? (
            <div className="lib-empty">
              <div className="le-ico"><Icon name="filter" size={30} decorative /></div>
              <div className="le-t">该筛选下暂无页面</div>
              <div className="le-d">试着放宽条件，或清空筛选重新浏览</div>
              <button type="button" className="le-btn" onClick={onClearFilter}>清除全部筛选</button>
            </div>
          ) : (
            <div className="lib-empty">
              <div className="le-ico"><Icon name="file" size={30} decorative /></div>
              <div className="le-t">还没有页面</div>
              <div className="le-d">新建一个页面后，它会出现在这里</div>
              <button type="button" className="le-btn" onClick={onCreate}>新建页面</button>
            </div>
          )}
        </div>
      ) : (
        <div
          ref={stackRef}
          className={effectiveMode === 'compact' ? 'lib-stack is-compact' : 'lib-stack'}
          onScroll={(event) => { stackScrollMemo.set(scrollKey, event.currentTarget.scrollTop) }}
        >
          {effectiveMode === 'compact'
            ? cards.map((card) => <CompactCard key={card.id} card={card} actions={actions} current={card.id === activePageId} />)
            : cards.map((card) => <ListCard key={card.id} card={card} actions={actions} current={card.id === activePageId} />)}
        </div>
      )}
    </>
  )
}
