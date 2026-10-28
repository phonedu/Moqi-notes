import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { Icon } from '@moqi/editor'
import { BLOCK_TYPE_ITEMS, INSERT_ITEMS, insertItemsForMedia, type InsertKind } from './menuItems'
import { Popover, type AnchorRect } from './Popover'
import { Dialog } from './Dialogs'
import { MAX_PINNED_PAGES } from '@moqi/editor'
import type { EmbedCandidate } from '@moqi/editor'
import type { LibraryCard, NavEntry, TagMenuTarget } from './types'

type MenuProps = { anchor: AnchorRect; onClose: () => void }

/**
 * 移动端底部 Sheet（`10` §三/§2.3， 4b-①）：底滑面板——默高 72%、重面板 88%。
 * 浮层 = 全屏遮罩 + 底部面板；关闭 = ✕ / 点遮罩。**只由 compact 档的调用点渲染**（桌面各走
 * 原 Popover / Dialog，形态不动）。首个消费者 = 卡片 ⋯（§4.1.2 六项 + 底部说明）。
 */
export function Sheet({ title, tall, onClose, children }: { title: string; tall?: boolean; onClose: () => void; children: ReactNode }) {
  return (
    <>
      <div className="sh-backdrop" role="presentation" onMouseDown={onClose} />
      <div className={`sheet${tall ? ' is-tall' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="sh-head">
          <span className="sh-title">{title}</span>
          <button type="button" className="sh-x" aria-label="关闭" onClick={onClose}><Icon name="x" size={20} decorative /></button>
        </div>
        <div className="sh-body">{children}</div>
      </div>
    </>
  )
}

/** 大纲下拉（docs/09 §4.3.1）：编辑器顶栏 ☰ 正下方就地展开，点击条目滚动定位并闪烁。 */
export function OutlinePop({ anchor, entries, onJump, onClose }: MenuProps & { entries: NavEntry[]; onJump: (id: string) => void }) {
  const headings = entries.filter((entry) => entry.kind === 'block' || entry.depth === 0)
  return (
    <Popover anchor={anchor} width={268} maxHeight={420} className="pop-268" label="页面大纲" onClose={onClose}>
      <div className="pop-h">页面大纲</div>
      {headings.length === 0 ? <div className="outline-empty">本页还没有标题块，转换一个块为 H1/H2/H3 后会出现在这里。</div> : headings.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className="outline-item"
          style={{ paddingLeft: 10 + entry.depth * 16 }}
          onClick={() => { onJump(entry.id); onClose() }}
        >
          <span className="lv">H{Math.min(3, entry.depth + 1)}</span>
          <span className="l">{entry.label}</span>
        </button>
      ))}
    </Popover>
  )
}

/** 编辑器「…」更多菜单（docs/09 §4.3.2）：三段式——视图与导航 / 页面动作 / 危险区。 */
export function MoreMenu({ anchor, onClose, refOpen, onToggleRef, showRefPanel = true, onFind, onStats, onFocus, onCopyLink, onDuplicate, onDelete, onExport, starred, onToggleStar, onOpenProperties }: MenuProps & {
  refOpen: boolean
  /** M5 可选能力：反链关闭时不出「引用预览面板」项。 */
  showRefPanel?: boolean
  onToggleRef: () => void
  onFind: () => void
  onStats: () => void
  onFocus: () => void
  onCopyLink: () => void
  onDuplicate: () => void
  onDelete: () => void
  onExport: () => void
  starred: boolean
  onToggleStar: () => void
 /** 「属性」入口（`13-属性区重规划` §0-1， 裁决：摘要条不再常驻，入口回到 ⋯）。 */
  onOpenProperties: () => void
}) {
  const run = (action: () => void) => () => { onClose(); action() }
  return (
    <Popover anchor={anchor} align="right" width={256} maxHeight={520} label="更多" onClose={onClose}>
      <button type="button" onClick={run(onOpenProperties)} title="属性：添加 / 编辑本页属性（标签也在这里）">
        <span className="mi"><Icon name="properties" size={16} decorative /></span>
        <span>属性</span>
      </button>
      <button type="button" onClick={run(onFind)} title="本页正文块级查找（⌘F）">
        <span className="mi"><Icon name="search" size={16} decorative /></span>
        <span>页内查找</span>
        <span className="d">⌘F</span>
      </button>
      {showRefPanel ? (
        <button type="button" className={refOpen ? 'is-on' : ''} onClick={run(onToggleRef)}>
          <span className="mi"><Icon name="panel-right" size={16} decorative /></span>
          <span>引用预览面板</span>
          <span className="d">{refOpen ? '已开启 ✓' : '打开 / 关闭'}</span>
        </button>
      ) : null}
      <button type="button" onClick={run(onStats)}>
        <span className="mi"><Icon name="chart" size={16} decorative /></span>
        <span>页面统计</span>
      </button>
      <button type="button" onClick={run(onFocus)}>
        <span className="mi"><Icon name="expand" size={16} decorative /></span>
        <span>专注模式</span>
        <span className="d">⌘⇧F</span>
      </button>
      <hr />
      <button type="button" className={starred ? 'is-on' : ''} onClick={run(onToggleStar)} title="与页面库卡片上的 ★ 是同一数据源、双向同步（R09-MORE-8）">
        <span className="mi"><Icon name={starred ? 'star-filled' : 'star'} size={16} decorative /></span>
        <span>{starred ? '取消星标' : '星标'}</span>
      </button>
      <button type="button" onClick={run(onCopyLink)}>
        <span className="mi"><Icon name="link" size={16} decorative /></span>
        <span>复制链接</span>
      </button>
      <button type="button" onClick={run(onDuplicate)}>
        <span className="mi"><Icon name="file-copy" size={16} decorative /></span>
        <span>复制页面</span>
      </button>
      <button type="button" onClick={run(onExport)} title="导出 Markdown">
        <span className="mi"><Icon name="download" size={16} decorative /></span>
        <span>导出 Markdown</span>
      </button>
      <hr />
      <button type="button" className="is-danger" onClick={run(onDelete)}>
        <span className="mi"><Icon name="trash" size={16} decorative /></span>
        <span>移至回收站</span>
      </button>
    </Popover>
  )
}

/** 块类型下拉（常驻格式栏 Aa ▾）：作用于光标块或选中块，数据源与斜杠菜单「转换为」同一份。 */
export function BlockTypeMenu({ anchor, current, onPick, onClose }: MenuProps & { current: string; onPick: (type: string) => void; onClose: () => void }) {
  return (
    <Popover anchor={anchor} width={212} label="块类型" onClose={onClose}>
      <div className="pop-h">转换为</div>
      {BLOCK_TYPE_ITEMS.map((item) => (
        <button key={item.type} type="button" className={item.type === current ? 'is-on' : ''} onClick={() => { onPick(item.type); onClose() }}>
          <span className="mi"><Icon name={item.icon} size={16} decorative /></span>
          <span>{item.label}</span>
          <span className="d">{item.hint}</span>
        </button>
      ))}
    </Popover>
  )
}

/** 插入下拉（格式栏 ＋ 插入 ▾）：与斜杠菜单「插入」同一份数据源，未实现项就地标注版本。 */
export function InsertMenu({ anchor, onPick, onClose, compact, media = true }: MenuProps & { onPick: (kind: InsertKind) => void; onClose: () => void; compact?: boolean; media?: boolean }) {
  // 移动端（`10` §4.6「插入新块」）：底部 Sheet = 键盘上方格式栏「＋ 块」的落点——
  // 与桌面 ＋插入 ▾ / 斜杠菜单**同一数据源**（`INSERT_ITEMS`：待办 / 引用 / 代码 / 今天 / 现在 /
  // 嵌入块 / 图片块 / 附件块）。
  if (compact) {
    return (
      <Sheet title="插入新块" onClose={onClose}>
        {insertItemsForMedia(INSERT_ITEMS, media).map((item) => (
          <button key={item.kind} type="button" className="sg-row" disabled={Boolean(item.version)} onClick={() => { onPick(item.kind); onClose() }}>
            <span className="mi"><Icon name={item.icon} size={20} decorative /></span>
            <span>{item.label}</span>
            {item.version ? <span className="d">{item.version}</span> : <span className="d">{item.hint}</span>}
          </button>
        ))}
      </Sheet>
    )
  }
  return (
    <Popover anchor={anchor} width={212} label="插入新块" onClose={onClose}>
      <div className="pop-h">插入新块</div>
      {insertItemsForMedia(INSERT_ITEMS, media).map((item) => (
        <button
          key={item.kind}
          type="button"
          disabled={Boolean(item.version)}
          title={item.hint}
          onClick={() => { onPick(item.kind); onClose() }}
        >
          <span className="mi"><Icon name={item.icon} size={16} decorative /></span>
          <span>{item.label}</span>
          {item.version ? <span className="d">{item.version}</span> : null}
        </button>
      ))}
    </Popover>
  )
}

/** 页面卡片 ⋯ 菜单（docs/09 §4.1.2）。 */
export function CardMenu({ anchor, card, canPin, onClose, onCopyLink, onDelete, onExport, onTogglePin, onToggleStar, compact, onOpen }: MenuProps & {
  card: LibraryCard
  /** 已置顶 5 个时为 false —— 菜单据此把「置顶」置灰（真正的门禁在 store.setPinned）。 */
  canPin: boolean
  onCopyLink: () => void
  onDelete: () => void
  /** 导出 Markdown（页面上下文三选项，`R09-EXPORT-1`）。 */
  onExport: () => void
  onTogglePin: () => void
  onToggleStar: () => void
  /** 移动端形态（`10` §4.1.2，4b-①）：底部 Sheet = 六项（多一项「打开页面」）+ 底部说明。 */
  compact?: boolean
  onOpen: () => void
}) {
  const run = (action: () => void) => () => { onClose(); action() }
  const pinDisabled = !card.pinned && !canPin
  if (compact) {
    return (
      <Sheet title={`页面操作 · ${card.name || '未命名页面'}`} onClose={onClose}>
        <button type="button" className="sg-row" onClick={run(onOpen)}><span className="mi"><Icon name="file-text" size={20} decorative /></span><span>打开页面</span></button>
        <button type="button" className={`sg-row${card.pinned ? ' is-on' : ''}`} disabled={pinDisabled} onClick={run(onTogglePin)} title={pinDisabled ? `最多置顶 ${MAX_PINNED_PAGES} 个页面——先取消一个` : ''}><span className="mi"><Icon name="chevron-up" size={20} decorative /></span><span>{card.pinned ? '取消置顶' : '置顶'}</span>{pinDisabled ? <span className="d">最多 {MAX_PINNED_PAGES} 个</span> : null}</button>
        <button type="button" className={`sg-row${card.starred ? ' is-on' : ''}`} onClick={run(onToggleStar)}><span className="mi"><Icon name={card.starred ? 'star-filled' : 'star'} size={20} decorative /></span><span>{card.starred ? '取消星标' : '星标'}</span></button>
        <button type="button" className="sg-row" onClick={run(onCopyLink)}><span className="mi"><Icon name="link" size={20} decorative /></span><span>复制链接</span></button>
        <button type="button" className="sg-row" onClick={run(onExport)}><span className="mi"><Icon name="download" size={20} decorative /></span><span>导出 Markdown</span></button>
        <button type="button" className="sg-row is-danger" onClick={run(onDelete)}><span className="mi"><Icon name="trash" size={20} decorative /></span><span>移至回收站</span></button>
        <p className="sg-note">移至回收站后 30 天内可恢复（按子树）。</p>
      </Sheet>
    )
  }
  return (
    <Popover anchor={anchor} align="right" width={196} className="pop-256" label={`${card.name} 操作`} onClose={onClose}>
      <div className="pop-h">{card.name || '未命名页面'}</div>
      <button
        type="button"
        className={card.pinned ? 'is-on' : ''}
        disabled={pinDisabled}
        onClick={run(onTogglePin)}
        title={pinDisabled ? `最多置顶 ${MAX_PINNED_PAGES} 个页面——先取消一个` : (card.pinned ? '取消置顶，回到它原来的位置' : '置顶到页面库最前')}
      >
        <span className="mi"><Icon name="chevron-up" size={16} decorative /></span>
        <span>{card.pinned ? '取消置顶' : '置顶'}</span>
        {pinDisabled ? <span className="d">最多 {MAX_PINNED_PAGES} 个</span> : null}
      </button>
      <button
        type="button"
        className={card.starred ? 'is-on' : ''}
        onClick={run(onToggleStar)}
        title="与编辑器 … 菜单的星标是同一数据源、双向同步（R09-MORE-8）"
      >
        <span className="mi"><Icon name={card.starred ? 'star-filled' : 'star'} size={16} decorative /></span>
        <span>{card.starred ? '取消星标' : '星标'}</span>
      </button>
      <button type="button" onClick={run(onCopyLink)}>
        <span className="mi"><Icon name="link" size={16} decorative /></span>
        <span>复制链接</span>
      </button>
      <button type="button" onClick={run(onExport)} title="导出 Markdown（front-matter 写入属性与标签）">
        <span className="mi"><Icon name="download" size={16} decorative /></span>
        <span>导出 Markdown</span>
      </button>
      <hr />
      <button type="button" className="is-danger" onClick={run(onDelete)}>
        <span className="mi"><Icon name="trash" size={16} decorative /></span>
        <span>移至回收站</span>
      </button>
    </Popover>
  )
}

/** 侧栏标签行 ⋯ 菜单（docs/09 §6.8）：重命名 / 合并到… / 从所有页面移除。 */
export function TagMenu({ anchor, tag, onClose, onRename, onMerge, onRemoveAll }: MenuProps & {
  tag: TagMenuTarget
  onRename: () => void
  onMerge: () => void
  onRemoveAll: () => void
}) {
  const run = (action: () => void) => () => { onClose(); action() }
  return (
    <Popover anchor={anchor} width={230} label={`#${tag.name} 标签操作`} onClose={onClose}>
      <div className="pop-h"># {tag.name}<span className="st"> · {tag.count} 篇页面</span></div>
      <button type="button" onClick={run(onRename)}>
        <span className="mi"><Icon name="bold" size={16} decorative /></span>
        <span>重命名</span>
      </button>
      <button type="button" onClick={run(onMerge)} disabled={tag.count === 0} title="选择目标标签后批量指向">
        <span className="mi"><Icon name="link" size={16} decorative /></span>
        <span>合并到…</span>
      </button>
      <button type="button" className="is-danger" onClick={run(onRemoveAll)}>
        <span className="mi"><Icon name="x" size={16} decorative /></span>
        <span>从所有页面移除</span>
      </button>
    </Popover>
  )
}

export type FindHit = { blockId: string; label: string; preview: string }

/** 页内查找（docs/09 §6.3.1）：本页正文块级查找，回车循环定位并闪烁。 */
export function FindDialog({ pageName, hits, query, onQuery, onJump, onClose }: {
  pageName: string
  hits: FindHit[]
  query: string
  onQuery: (value: string) => void
  onJump: (blockId: string) => void
  onClose: () => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [index, setIndex] = useState(0)
  const [lastQuery, setLastQuery] = useState(query)
  // 关键词变化时把选中项复位到第一处（渲染期同步，避免额外一次 effect 渲染）。
  if (lastQuery !== query) {
    setLastQuery(query)
    setIndex(0)
  }

  const move = (step: number) => {
    if (hits.length === 0) return
    const next = (index + step + hits.length) % hits.length
    setIndex(next)
    onJump(hits[next].blockId)
  }

  return (
    <Dialog
      title="页内查找"
      subtitle={`在「${pageName || '当前页面'}」内按 Block 查找`}
      initialFocus={inputRef as React.RefObject<HTMLElement | null>}
      onClose={onClose}
      footer={<div className="fd-foot">↵ 下一处 · ⇧↵ 上一处 · Esc 关闭</div>}
    >
      <div className="search-input">
        <Icon name="search" size={16} decorative />
        <input
          ref={inputRef}
          value={query}
          placeholder="输入关键词…"
          aria-label="页内查找关键词"
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            move(event.shiftKey ? -1 : 1)
          }}
        />
        <span className="fd-cnt"><b>{hits.length}</b> 个匹配</span>
      </div>
      <div className="fd-list">
        {query.trim() === '' ? (
          <div className="fd-empty">输入关键词，实时检索本页所有 Block 的正文。</div>
        ) : hits.length === 0 ? (
          <div className="fd-empty">本页没有包含「{query}」的块。<br />试试 ⌘K 全局搜索。</div>
        ) : hits.map((hit, hitIndex) => (
          <button
            type="button"
            key={hit.blockId}
            className={`fd-item ${hitIndex === index ? 'is-active' : ''}`}
            onMouseEnter={() => setIndex(hitIndex)}
            onClick={() => { setIndex(hitIndex); onJump(hit.blockId) }}
          >
            <span className="fd-n">{hitIndex + 1}</span>
            <span className="fd-t">{highlight(hit.preview, query)}</span>
          </button>
        ))}
      </div>
    </Dialog>
  )
}

/**
 * 「选择来源页面 / 块」（13-媒体设计（已归档） §8、`R09-BLOCK-24`）——嵌入块空态的入口，
 * 也是 ⋯ 菜单里的「更换来源」。
 *
 * 候选与 `[[` / `((` 菜单同一个搜索源（`store.embedSourceTargets` → `searchEmbedTargets`），
 * 页面在前、块在后，每行标出它属于哪一档；选定由调用方写领域（一次事务一个撤销步），
 * 本组件**不改数据**（关掉对话框不产生 operation）。
 */
export function EmbedSourceDialog({ blockId, findTargets, onPick, onClose }: {
  blockId: string
  findTargets: (query: string, fromId: string) => EmbedCandidate[]
  onPick: (targetId: string) => void
  onClose: () => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const results = findTargets(query, blockId)
  const clamped = Math.min(index, Math.max(0, results.length - 1))

  const move = (step: number) => {
    if (results.length === 0) return
    setIndex((clamped + step + results.length) % results.length)
  }

  return (
    <Dialog
      title="选择来源页面 / 块"
      subtitle="嵌入块会把选中的块（连同它的子块）只读显示在这里；源块改了这边跟着改"
      initialFocus={inputRef as React.RefObject<HTMLElement | null>}
      onClose={onClose}
      footer={<div className="fd-foot">↑↓ 选择 · ↵ 确定 · Esc 关闭</div>}
    >
      <div className="search-input">
        <Icon name="search" size={16} decorative />
        <input
          ref={inputRef}
          value={query}
          placeholder="输入页面名或块里的文字…"
          aria-label="搜索来源页面或块"
          onChange={(event) => { setQuery(event.target.value); setIndex(0) }}
          onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); move(1); return }
            if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); return }
            if (event.key !== 'Enter') return
            event.preventDefault()
            if (results.length > 0) onPick(results[clamped].targetId)
          }}
        />
        <span className="fd-cnt"><b>{results.length}</b> 个候选</span>
      </div>
      <div className="fd-list">
        {results.length === 0 ? (
          <div className="fd-empty">没有匹配的页面或块。<br />换个词试试，或先取消、建好那块再回来选。</div>
        ) : results.map((item, itemIndex) => (
          <button
            type="button"
            key={`${item.kind}-${item.targetId}`}
            className={`fd-item ${itemIndex === clamped ? 'is-active' : ''}`}
            onMouseEnter={() => setIndex(itemIndex)}
            onClick={() => onPick(item.targetId)}
          >
            <span className="fd-n">{item.kind === 'object' ? '页' : '块'}</span>
            <span className="fd-t">
              <b>{item.label}</b>
              <em className="fd-hint">{item.hint}</em>
            </span>
          </button>
        ))}
      </div>
    </Dialog>
  )
}

function highlight(text: string, query: string): ReactNode {
  const needle = query.trim()
  if (!needle) return text
  const parts = text.split(needle)
  return parts.map((part, index) => (
    <span key={index}>{part}{index < parts.length - 1 ? <mark>{needle}</mark> : null}</span>
  ))
}

/** 快捷键速查面板（docs/09 §九）。 */
export function KeyboardDialog({ onClose }: { onClose: () => void }) {
 // 速查表（`R09-KEY-12`）**对的是真实路由**：⌘K 是已实现的全局搜索（ 撤掉「后续版本实现」
  // 那截陈旧括注）；本表随快捷键一起改（`W5`：补 ⌘U / ⌘L / ⌘⇧↑↓ / 块级 ⌘C ⌘X ⌫ / ⇧⌘Z / ⌘,）。
  const groups: { title: string; rows: [string, string[]][] }[] = [
    {
      title: '全局',
      rows: [
        ['全局搜索', ['⌘', 'K']],
        ['新建页面', ['⌘', 'N']],
        ['设置（开合居中模态）', ['⌘', ',']],
        ['折叠 / 展开侧栏', ['⌘', '\\']],
        ['折叠 / 展开页面列表（放大写作）', ['⌘', '⇧', '\\']],
        ['快捷键速查', ['⌘', '/']],
        ['逐层退出', ['Esc']],
      ],
    },
    {
      title: '编辑器 · 视图',
      rows: [
        ['页内查找', ['⌘', 'F']],
        ['专注模式', ['⌘', '⇧', 'F']],
        ['撤销', ['⌘', 'Z']],
        ['重做', ['⌘', '⇧', 'Z']],
      ],
    },
    {
      title: '编辑器 · 格式',
      rows: [
        ['加粗选中文字', ['⌘', 'B']],
        ['斜体选中文字', ['⌘', 'I']],
        ['下划线', ['⌘', 'U']],
        ['删除线', ['⌘', '⇧', 'S']],
        ['行内代码', ['⌘', 'E']],
        ['高亮', ['⌘', '⇧', 'H']],
        ['插入 / 编辑链接', ['⌘', 'L']],
      ],
    },
    {
      title: '编辑器 · 结构',
      rows: [
        ['缩进 / 反缩进', ['Tab', '⇧Tab']],
        ['斜杠菜单', ['/', '块内输入']],
        ['选中块', ['单击把手']],
        ['多选：加选 / 范围', ['⌘ 点把手', '⇧ 点把手']],
        ['折叠子树', ['⌘', '↑']],
        ['上移 / 下移块', ['⌘⇧↑', '⌘⇧↓']],
        ['复制 / 剪切 / 删除选中块', ['⌘C', '⌘X', '⌫']],
      ],
    },
  ]
  return (
    <Dialog title="快捷键" subtitle="完整键位表" onClose={onClose}>
      <div className="dlg-b">
        <div className="kb-grid">
          {groups.map((group) => (
            <div className="kb-group" key={group.title}>
              <h4>{group.title}</h4>
              {group.rows.map(([label, keys]) => (
                <div className="kb-row" key={label}>
                  <span>{label}</span>
                  <span className="kd">{keys.map((key) => <kbd key={key}>{key}</kbd>)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  )
}

/** 页面统计（docs/09 §4.4.2）：420px 只读四格，独立于属性面板。 */
export function StatDialog({ stats, onClose }: { stats: { blocks: number; backlinks: number; words: number; createdLabel: string }; onClose: () => void }) {
  return (
    <Dialog title="页面统计" subtitle="只读" small onClose={onClose}>
      <div className="dlg-b">
        <div className="stat-grid">
          <div className="stat-cell"><div className="k">块数</div><div className="v">{stats.blocks}</div></div>
          <div className="stat-cell"><div className="k">反向链接</div><div className="v">{stats.backlinks}</div></div>
          <div className="stat-cell"><div className="k">字数</div><div className="v">{stats.words}</div></div>
          <div className="stat-cell"><div className="k">创建日期</div><div className="v is-date">{stats.createdLabel}</div></div>
        </div>
      </div>
    </Dialog>
  )
}


/**
 * 图片预览（`R09-BLOCK-19`）：只读预览，不改数据。「另存副本」与附件的下载同一条路
 * （复制进认得的目录 + 显示路径；浏览器通道直接下载）。
 * **两态两形**（θ17， 用户裁定）：
 * - `tools`（编辑态）：**图标化工具条** = 适应 / 缩小 / 放大 / 保存副本 / ✕（去掉文件名与大小——「实在不行就取消他的名字和大小」）；
 * - `viewer`（只读态）：只留三个图标 = 关闭 / 保存 / 分享（**分享未接入 ⇒ 禁用并写明**，`R09-SET-20` 不做假按钮）。
 */
export function MediaPreview({ src, name, mode, onSaveCopy, onClose }: {
  src: string
  name: string
  mode: 'tools' | 'viewer'
  onSaveCopy: () => void
  onClose: () => void
}) {
  const [zoom, setZoom] = useState<'fit' | number>('fit')
  // Esc 收起（与其它浮层同一条退出约定；本预览不走 Dialog，得自己接）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])
  const scale = zoom === 'fit' ? 1 : zoom
  const tools = (
    <>
      <button type="button" aria-label="缩小" onClick={() => setZoom((current) => (current === 'fit' ? 1 : Math.max(0.25, current / 1.25)))}><Icon name="zoom-out" size={18} decorative /></button>
      <button type="button" aria-label="放大" onClick={() => setZoom((current) => (current === 'fit' ? 1 : Math.min(6, current * 1.25)))}><Icon name="zoom-in" size={18} decorative /></button>
      <button type="button" aria-label="保存副本" onClick={onSaveCopy}><Icon name="download" size={18} decorative /></button>
    </>
  )
  return (
    <div className="lb-mask" role="dialog" aria-label="图片预览" onClick={onClose}>
      <div className="lb-box" onClick={(event) => event.stopPropagation()}>
        <div className="lb-bar">
          {/* 工具条两态：`tools` = 图标化五键（编辑态）；`viewer` = 关闭 / 保存 / 分享（只读态）。文件名与大小不上条（θ17）。 */}
          {mode === 'tools' ? tools : (
            <>
              <button type="button" aria-label="保存" onClick={onSaveCopy}><Icon name="download" size={20} decorative /></button>
              <button type="button" aria-label="分享（未接入·后续）" disabled title="分享（未接入·后续）"><Icon name="share" size={20} decorative /></button>
            </>
          )}
          <button type="button" aria-label={mode === 'tools' ? '关闭' : '退出'} onClick={onClose}><Icon name="x" size={18} decorative /></button>
        </div>
        {/* 没有「适应」键了（用户 ）：**点图本身 = 回到适应**——缩放过就点一下回整幅。 */}
        <div className={zoom === 'fit' ? 'lb-stage is-fit' : 'lb-stage'} onClick={() => setZoom('fit')}>
          <img src={src} alt={name} style={zoom === 'fit' ? undefined : { transform: `scale(${scale})` }} />
        </div>
      </div>
    </div>
  )
}

/** 选中块样式辅助：把手选中后给块加高亮 class（只改 class，不改编辑器 DOM 结构）。 */
export function paintSelection(root: HTMLElement | null, selectedIds: string[]): void {
  if (!root) return
  for (const element of root.querySelectorAll<HTMLElement>('.moqi-block[data-entity-id]')) {
    const id = element.dataset.entityId
    element.classList.toggle('is-selected', id !== undefined && selectedIds.includes(id))
  }
}
