import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { EditorTextFormat } from '@moqi/editor'
import { BLOCK_FORMAT_ITEMS } from './menuItems'
import { Icon } from '@moqi/editor'
import { $findBlockNode as findBlockNode } from '@moqi/editor'
import { EMBED_CARD_GEOMETRY, embedCardChromePlacement, hoveredIdFromPointer, listOrdinal, markerBoxStyle, markerPlacement, markersForBlock, ownLineCenter, type MarkerKind } from '@moqi/editor'
import { applyAssetVars } from './assetVars'
import { clearDropLine, showDropLine } from '@moqi/editor'
import { aiBarsFrom, type AiBar, type AiBarSource } from './aiBars'
import type { DropPosition } from '@moqi/editor'
import type { AiAction, BlockType } from '@moqi/editor'
import type { EmbedView } from '@moqi/editor'
import { AI_UI_OPS } from './aiMenu'
import { anchorOf, Popover, type AnchorRect } from './Popover'
import { anchorFrameOf, toolbarPlacement } from './blockAnchor'
import type { SelectMode } from './useBlockSelection'

export type BlockRect = { top: number; left: number; right: number; bottom: number; height: number; width: number }
export type { SelectMode } from './useBlockSelection'
export type { DropPosition } from '@moqi/editor'

function rectOf(element: Element): BlockRect {
  const rect = element.getBoundingClientRect()
  return { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, height: rect.height, width: rect.width }
}

export function blockElementById(root: HTMLElement | null, blockId: string): HTMLElement | null {
  if (!root) return null
  for (const element of root.querySelectorAll<HTMLElement>('.moqi-block[data-entity-id]')) {
    if (element.dataset.entityId === blockId) return element
  }
  return null
}

/**
 * 浮动工具栏的键盘闭环（docs/08 §4 / docs/09 §十一）：方向键在按钮间移动焦点，
 * Home/End 跳到首尾，Esc 关闭并把焦点交回调用方（通常是正文）。
 * 鼠标打开时不抢焦点——编辑器里抢焦点会打断光标与输入法，所以这里保证的是「一旦聚焦就完全可用」。
 */
export function toolbarKeyDown(event: ReactKeyboardEvent<HTMLDivElement>, onEscape?: () => void): void {
  if (event.key === 'Escape') {
    if (!onEscape) return
    event.preventDefault()
    event.stopPropagation()
    onEscape()
    return
  }
  if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return
  const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])')]
  if (items.length === 0) return
  event.preventDefault()
  const current = items.indexOf(document.activeElement as HTMLButtonElement)
  let next = current < 0 ? 0 : current
  if (event.key === 'ArrowRight') next = current < 0 ? 0 : (current + 1) % items.length
  else if (event.key === 'ArrowLeft') next = current <= 0 ? items.length - 1 : current - 1
  else if (event.key === 'Home') next = 0
  else next = items.length - 1
  items[next]?.focus()
}

/**
 * 在 Lexical 更新/读取上下文里按 entityId 找到 BlockNode。
 *
 * 名字行收口（T5）：实现**下沉**到 `editor/blockNode.ts` 的 `$findBlockNode`
 * （编辑器层也要它，而 `editor/` 不许反向引用 `ui/`）。这里保留原名转出，UI 侧的调用点一个字不用改。
 */
export { findBlockNode }

type Marker = {
  id: string
  kind: MarkerKind
  rect: BlockRect
  /** 块自己那一行的垂直中心：标记贴在这一行上，不跟着子树盒子跑。 */
  lineTop: number
  blockType: BlockType
  collapsed: boolean
  checked: boolean
}

/**
 * 嵌入卡卡头里的三个真元素（`R09-BLOCK-24`）：图标块、标题两行、「来源 ↗」胶囊。
 *
 * 卡片本体由 CSS 画（块元素 + `::before` 卡头占位 + `::after` 正文区），但**伪元素既点不了、
 * 一个 `attr()` 字符串也放不下三种样式**（标题 13/600、副行 11 弱色——原型 `.eb-t` / `.eb-s`），
 * 所以卡头这三块在这一层渲染——落点由同一趟测量给出（`embedCardChromePlacement`）。
 * `state` 决定文案：有来源 =「来源 ↗」跳转；空态 / 悬空 =「选择来源 ↗」重选（标题同步降级）。
 */
type EmbedCard = {
  id: string
  state: 'empty' | 'ok' | 'dangling'
  /** 卡头标题（有来源 =「页 › 块」；空态 / 悬空 = 状态话术）。超长由 CSS 省略号截，不在这里截。 */
  title: string
  /** 内容坐标里的块矩形（与标记同一套坐标）。 */
  rect: BlockRect
}

/**
 * 块装饰层（docs/09 §五 / §6.2、docs/04 §7）。
 *
 * 设计要点：标记的位置**由布局推导**，不靠 hover 记账缓存 rect。任何会让块移动的事情
 * （输入换行、滚动、折叠、类型转换、结构操作）都会重新测量，因此把手/折叠箭头/复选框
 * 始终贴在各自的块上——此前「输入文字后把手留在原地或消失」就是缓存 rect 不更新的结果。
 *
 * 标记全部是真实按钮（可 Tab 可达、有 aria-label、按 docs/04 §7 给足点击目标），
 * 只调用已有的领域入口；编辑器托管的 DOM 树不被改写，标记层渲染在 Lexical 根节点之外。
 */
export function BlockDecorations({ scopeRef, contentRef, selectedIds, enabled, revision, onSelect, onInsertAfter, onMove, onToggleCollapse, onToggleChecked, assetUrl, onOpenMedia, embedView, onPickEmbedSource, onOpenEmbedSource, compact }: {
  scopeRef: React.RefObject<HTMLElement | null>
  contentRef: React.RefObject<HTMLElement | null>
  selectedIds: string[]
  enabled: boolean
  /** 触屏档（`10` §4.3 · `W2` 后半）：标记集与折叠箭头几何走紧凑档（见 blockMarkers）。 */
  compact?: boolean
  /** 领域修订号：来源块在**别的页面**被改动时 DOM 不会变（也就没有 MutationObserver 回调），
   *  嵌入卡的标题 / 正文要靠它触发一次重扫。 */
  revision: number
  onSelect: (blockId: string, mode: SelectMode) => void
  onInsertAfter: (blockId: string) => void
  onMove: (dragId: string, targetId: string, position: DropPosition) => void
  onToggleCollapse: (blockId: string) => void
  onToggleChecked: (blockId: string) => void
  /** 点图片区域 → 开灯箱（`R09-BLOCK-19`）；点图注不算（那是编辑）。 */
  onOpenMedia: (blockId: string) => void
  /** 磁盘名 → 显示地址（拿不到 = 文件缺失 / 还没准备好）：媒体块的 CSS 变量由它来。 */
  assetUrl: (diskName: string) => string | null
  /** 嵌入卡的数据源（`R09-BLOCK-24`）：标题 / 正文 / 悬空都由领域算，这一层只写数据属性。 */
  embedView: (blockId: string) => EmbedView | null
  /** 空态 / 悬空卡：点它 = 选来源（`选择来源 ↗`）。 */
  onPickEmbedSource: (blockId: string) => void
  /** 有来源的卡：点胶囊 = 跳到来源（跨页时先切页）。 */
  onOpenEmbedSource: (blockId: string) => void
}) {
  const [markers, setMarkers] = useState<Marker[]>([])
  const [cards, setCards] = useState<EmbedCard[]>([])
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const hoveredIdRef = useRef<string | null>(null)
  const selectedIdsRef = useRef(selectedIds)
  const signatureRef = useRef('')
  const frameRef = useRef<number | null>(null)
  const pendingRef = useRef<{ id: string; x: number; y: number; shift: boolean; toggle: boolean } | null>(null)
  const dragRef = useRef<{ id: string; target: { id: string; position: DropPosition } | null } | null>(null)
  const draggedRef = useRef(false)

  /** 一次测量：遍历当前页面的块，得出应显示的标记与它们的实时位置。 */
  const measure = useCallback(() => {
    const content = contentRef.current
    if (!content) return
    const hovered = hoveredIdRef.current
    const selected = selectedIdsRef.current
    // 标记画在**滚动容器（`.doc-col`）的内容坐标**里（`position: absolute`）。此前是
    // 「`position: fixed` + 视口坐标」：快速滚动时标记会落后内容一帧、再弹回原处（用户实测
  // 「移动页面太快时上下抖动」）。改成内容坐标后，滚动由浏览器自己带着走，不需要每帧追。
    // **可见带仍按视口坐标判断**：块滚到格式栏 / 原生栏底下时不给它画标记。
    // 坐标系与可见带都由定位服务回答（'content' = 内容坐标 + 正文滚动容器那条可见带）：
    // 原来这里自己抄了一份换算，AI 行那边又抄了一份（T7 收口，见 ui/blockAnchor.ts）。
    const frame = anchorFrameOf(content, 'content')
    // 编号列表的序号（docs/09 §五 R09-BLOCK-30）：**数据驱动**，由 listOrdinal 按「同级相邻同类型」
    // 算出后写进 data-ordinal，CSS 只读 attr(data-ordinal)。
    // 为什么不用 CSS 计数器：标记画在 ::after 上，而 ::after 排在块的子树**之后**——带子编号的那一项
  // 读到的计数器已经被子项加过（「第二条」显示成 3，用户实测 ）。
    // 写在这里的另一层理由：这一层已经在监听 childList / data-block-type（插入、删除、类型转换都会触发
    // 一次重测），序号的失效条件正好被它全覆盖；写在编辑器节点上则要自己盯兄弟变化。
    for (const element of content.querySelectorAll<HTMLElement>('.moqi-block[data-entity-id][data-block-type="numbered"]')) {
      const siblings = [...(element.parentElement?.children ?? [])].filter((child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains('moqi-block'))
      const ordinal = listOrdinal(siblings.map((child) => (child.dataset.blockType ?? 'text') as BlockType), siblings.indexOf(element), 'numbered')
      if (ordinal === null) delete element.dataset.ordinal
      else if (element.dataset.ordinal !== String(ordinal)) element.dataset.ordinal = String(ordinal)
    }
    const next: Marker[] = []
    // 媒体块（`R09-BLOCK-19/20`）：把磁盘名换成显示地址写进 CSS 变量（属性驱动，不动子节点）。
    // 拿不到地址 = 文件缺失 / 端口还没准备好 ⇒ 打 is-asset-missing，由 CSS 画占位卡（数据合法、界面降级）。
    // 点图片区域开灯箱：矩形里「图片那一段」才算（按 payload 的比例算，点图注是编辑）
    for (const element of content.querySelectorAll<HTMLElement>('.moqi-block-image[data-entity-id]')) {
      if (element.dataset.mediaClick === '1') continue
      element.dataset.mediaClick = '1'
      element.addEventListener('click', (event) => {
        const id = element.dataset.entityId
        // θ4/真机：触控**编辑态**点图不开灯箱（只弹图片工具条，灯箱由「扩展」开）。监听挂载时注册一次、
        // 闭包里的 prop 是旧值 ⇒ 只能看 DOM（`.doc-col.is-touch-edit`）。
        if (!id || (compact && document.querySelector('.doc-col.is-touch-edit'))) return
        const rect = element.getBoundingClientRect()
        const ratio = Number(element.dataset.assetRatio ?? '') || 16 / 9
        if (event.clientY - rect.top > rect.width / ratio + 4) return
        onOpenMedia(id)
      })
    }
    for (const element of content.querySelectorAll<HTMLElement>('.moqi-block[data-asset-file]')) {
      const file = element.dataset.assetFile
      applyAssetVars(element, file ? assetUrl(file) : null)
    }
    // 嵌入卡（`R09-BLOCK-24`）：**卡片是 CSS 画的**（块元素 ＋ 两个伪元素 = 头部/正文区，换行由浏览器撑高），这一层只做两件事——① 把领域算好的标题 / 正文写进
    // 数据属性（CSS 用 attr() 读，卡片自己不碰 store）；② 量出卡头里两个**真元素**（图标块、
    // 「来源 ↗」胶囊——伪元素点不了）的落点，交给同一层渲染。
    const cards: EmbedCard[] = []
    for (const element of content.querySelectorAll<HTMLElement>('.moqi-block-embed[data-entity-id]')) {
      const id = element.dataset.entityId
      if (!id) continue
      const view = embedView(id)
      const state = view?.state ?? 'empty'
      element.dataset.embedState = state
      element.dataset.embedPage = view?.pageLabel ?? ''
      // 标题合成「来源页 › 块」；目标是整页时没有后半段（不写「页 › 页」）。
      // 卡头标题是**真元素**（chrome 层 `.eb-t`）：超长交给 CSS 省略号（不再按字符数硬截），
      // 空态 / 悬空换成状态话术；副行是常量「嵌入块 · 引用自其他页面」（`.eb-s`）。
      const title = view ? [view.pageLabel, view.blockLabel].filter(Boolean).join(' › ') : ''
      element.dataset.embedTitle = title
      element.dataset.embedHidden = String(view?.hiddenLines ?? 0)
      // 正文与「还有 N 行」提示合成一段文字：CSS 只有一个 attr() 能用（`::after` 同时是分隔线下的正文区）。
      const note = view && view.hiddenLines > 0 ? `…（余下 ${view.hiddenLines} 行，导出含完整内容）` : ''
      element.dataset.embedBody = view && view.lines.length > 0 ? [view.lines.join('\n'), note].filter(Boolean).join('\n') : ''
      // 空态 / 悬空：**整张卡**就是「选来源」的按钮（伪元素点不了，落点由块自己接）；
      // 有来源时点正文是选中块本身，不改数据。处理器绑一次，状态在点击那一刻从 dataset 读。
      if (element.dataset.embedClick !== '1') {
        element.dataset.embedClick = '1'
        element.addEventListener('click', () => {
          if ((element.dataset.embedState ?? 'empty') !== 'ok') onPickEmbedSource(id)
        })
      }
      const cardRect = rectOf(element)
      if (!frame.inView(cardRect)) continue
      const cardTitle = state === 'ok' ? title : state === 'empty' ? '选择来源页面 / 块' : '来源已删除'
      cards.push({ id, state, title: cardTitle, rect: frame.rect(cardRect) })
    }
    for (const element of content.querySelectorAll<HTMLElement>('.moqi-block[data-entity-id]')) {
      const id = element.dataset.entityId
      if (!id) continue
      const blockType = (element.dataset.blockType ?? 'text') as BlockType
      const kinds = markersForBlock({
        type: blockType,
        isObject: element.dataset.blockObject === 'true',
        hasChildBlocks: element.querySelector(':scope > .moqi-block') !== null,
        collapsed: element.dataset.collapsed === 'true',
        hovered: hovered === id,
        selected: selected.includes(id),
        compact,
      })
      if (kinds.length === 0) continue
      const rect = rectOf(element)
      if (!frame.inView(rect)) continue
      const style = getComputedStyle(element)
      // **整条矩形都要换成内容坐标**：`left` 与 `right` 是两个不同的定位基准（把手的锚在左边、
   // ＋ 的锚在右边），只换 `top` / `left` 会让靠右锚定的标记跑到块外去（ 实测：
      // 最后一个块的 ＋ 落在块右边缘外 522px —— 视口坐标的 right 被当成内容坐标的 left 用了）。
      const localRect = frame.rect(rect)
      const lineTop = ownLineCenter(parseFloat(style.lineHeight), parseFloat(style.paddingTop) || 0, localRect)
      for (const kind of kinds) next.push({ id, kind, rect: localRect, lineTop, blockType, collapsed: element.dataset.collapsed === 'true', checked: element.dataset.checked === 'true' })
    }
    const signature = [
      ...next.map((marker) => `${marker.kind}:${marker.id}:${Math.round(marker.rect.top)}:${Math.round(marker.rect.left)}:${Math.round(marker.lineTop)}:${marker.collapsed}:${marker.checked}`),
      ...cards.map((card) => `card:${card.id}:${card.state}:${Math.round(card.rect.top)}:${Math.round(card.rect.left)}`),
    ].join('|')
    if (signature === signatureRef.current) return
    signatureRef.current = signature
    setMarkers(next)
    setCards(cards)
  }, [contentRef, embedView, onPickEmbedSource])

  const schedule = useCallback(() => {
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      measure()
    })
  }, [measure])

  // 布局变化的全部来源：内容 DOM 变动（输入、类型转换、折叠）、滚动、窗口尺寸。
  useEffect(() => {
    const scope = scopeRef.current
    const content = contentRef.current
    if (!scope || !content || !enabled) return
    const observer = new MutationObserver(() => schedule())
    observer.observe(content, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-collapsed', 'data-checked', 'data-block-type'] })
  // 滚动监听挂在 **window 的捕获阶段**（ 修）：真正滚动的元素是正文列的**父级**
    // `.editor-body`，挂在 `.doc-col` 上根本收不到它的滚动事件——标记层用的是视口坐标，
    // 于是滚动时标记不跟着走（AI 块的标签 / 操作行「飘起来」就是这个原因）。
    // scroll 不冒泡但会捕获，window 捕获能拿到任意滚动容器的滚动事件（斜杠菜单早就用这条）。
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    schedule()
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      if (frameRef.current !== null) { cancelAnimationFrame(frameRef.current); frameRef.current = null }
    }
  }, [enabled, scopeRef, contentRef, schedule])

  // hover 与选中只决定「显示谁的标记」，但它们变化后必须重新测量一次：
  // 鼠标移动本身不改变布局，MutationObserver 不会触发，否则悬停后标记根本不出现。
  useEffect(() => { selectedIdsRef.current = selectedIds; schedule() }, [selectedIds, schedule])
  useEffect(() => { schedule() }, [hoveredId, schedule])
  // 领域修订号：源块在别的页面被改（或刚选了来源）时，嵌入块的 DOM 一个字节都没动，
  // MutationObserver 不会响——嵌入卡的标题 / 正文要靠这一次重扫才跟上。
  useEffect(() => { schedule() }, [revision, schedule])

  // 指针与拖拽：hover 只决定「显示谁的标记」，位置一律来自 measure。
  useEffect(() => {
    const scope = scopeRef.current
    const content = contentRef.current
    if (!scope || !content || !enabled) return

    const clearDropMarkers = () => { clearDropLine() }
    const setHoveredId2 = (id: string | null) => {
      if (hoveredIdRef.current === id) return
      // 悬停点亮用**显式标记**（docs/06 §4 禁令：不用 `:hover` + `:has()` 去猜结构）。
      // 这一层已经是「悬停哪个块」的唯一计算者，标记由它写，CSS 只读标记。
      const previous = hoveredIdRef.current ? blockElementById(content, hoveredIdRef.current) : null
      if (previous) delete previous.dataset.hovered
      hoveredIdRef.current = id
      const next = id ? blockElementById(content, id) : null
      if (next) next.dataset.hovered = 'true'
      setHoveredId(id)
    }
    const blockUnder = (target: EventTarget | null): HTMLElement | null =>
      target instanceof HTMLElement ? target.closest<HTMLElement>('.moqi-block[data-entity-id]') : null
    /** 指针下的「属于某个块的附属行」：块标记（把手 / ＋ / 折叠 / 复选框）与 AI 块的标签行、操作行。 */
    const attachmentUnder = (target: EventTarget | null): string | null =>
      target instanceof HTMLElement ? target.closest<HTMLElement>('[data-marker-for]')?.dataset.markerFor ?? null : null

    const onMouseMove = (event: MouseEvent) => {
      const pending = pendingRef.current
      if (pending && !dragRef.current) {
        if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > 4) {
          pendingRef.current = null
          draggedRef.current = true
          dragRef.current = { id: pending.id, target: null }
          blockElementById(content, pending.id)?.classList.add('is-dragging')
        }
        return
      }
      const drag = dragRef.current
      const target = blockUnder(event.target)
      if (drag) {
        // 拖拽中离开有效块就清空落点：松手时不落位（docs/09 §6.2「取消拖拽不产生 transaction」）。
        if (!target) {
          drag.target = null
          clearDropMarkers()
          return
        }
        const targetId = target.dataset.entityId
        if (!targetId || targetId === drag.id) {
          drag.target = null
          clearDropMarkers()
          return
        }
        const rect = target.getBoundingClientRect()
        const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5
        const position: DropPosition = ratio < 0.3 ? 'before' : ratio > 0.7 ? 'after' : 'into'
        drag.target = { id: targetId, position }
        clearDropMarkers()
        showDropLine(target, position)
        return
      }
      setHoveredId2(hoveredIdFromPointer(target?.dataset.entityId ?? null, attachmentUnder(event.target), hoveredIdRef.current))
    }

    const onMouseLeave = () => {
      if (dragRef.current || pendingRef.current) return
      setHoveredId2(null)
    }
    const onMouseUp = () => {
      const pending = pendingRef.current
      pendingRef.current = null
      if (pending) {
        onSelect(pending.id, pending.shift ? 'range' : pending.toggle ? 'toggle' : 'single')
        return
      }
      const drag = dragRef.current
      if (!drag) return
      dragRef.current = null
      draggedRef.current = false
      clearDropMarkers()
      for (const element of content.querySelectorAll<HTMLElement>('.is-dragging')) element.classList.remove('is-dragging')
      if (drag.target) onMove(drag.id, drag.target.id, drag.target.position)
    }

    scope.addEventListener('mousemove', onMouseMove)
    scope.addEventListener('mouseleave', onMouseLeave)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      scope.removeEventListener('mousemove', onMouseMove)
      scope.removeEventListener('mouseleave', onMouseLeave)
      window.removeEventListener('mouseup', onMouseUp)
      clearDropMarkers()
      for (const element of content.querySelectorAll<HTMLElement>('[data-hovered]')) delete element.dataset.hovered
    }
  }, [enabled, onMove, onSelect, scopeRef, contentRef])

  if (!enabled) return null

  const startGesture = (blockId: string) => (event: ReactMouseEvent<HTMLElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    draggedRef.current = false
    pendingRef.current = { id: blockId, x: event.clientX, y: event.clientY, shift: event.shiftKey, toggle: event.metaKey || event.ctrlKey }
  }

  /** 定位层只负责把标记送到块的左/右外侧；盒尺寸与点击区落在按钮自己身上（都是 MARKER_GEOMETRY）。 */
  const place = (marker: Marker): { style: CSSProperties } => ({ style: markerPlacement(marker.kind, marker.rect, marker.lineTop, compact) })
  const boxStyle = (kind: MarkerKind): CSSProperties => {
    const box = markerBoxStyle(kind, compact)
    return { width: box.width, height: box.height, '--hit': box.hit } as CSSProperties
  }

  return (
    <>
      {markers.map((marker) => (
        <span
          className="block-rail"
          key={`${marker.kind}-${marker.id}`}
          data-block-marker=""
          data-marker-kind={marker.kind}
          data-marker-for={marker.id}
          {...place(marker)}
        >
          {marker.kind === 'handle' ? (
            <button
              type="button"
              className="b-handle"
              style={boxStyle(marker.kind)}
              aria-label="块操作把手"
              title={selectedIds.includes(marker.id) ? '已选中 · ⌘点加选 · ⇧点范围 · 拖拽移动' : '单击选中 · ⌘点加选 · ⇧点范围 · 拖拽移动'}
              onMouseDown={startGesture(marker.id)}
            >
              <Icon name="grip" size={16} decorative />
            </button>
          ) : marker.kind === 'plus' ? (
            <button
              type="button"
              className="b-plus"
              style={boxStyle(marker.kind)}
              aria-label="在下方插入同级块"
              title="在下方插入同级块"
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => { event.stopPropagation(); onInsertAfter(marker.id) }}
            >
              <Icon name="plus" size={16} decorative />
            </button>
          ) : marker.kind === 'collapse' ? (
            <button
              type="button"
              className="b-collapse"
              style={boxStyle(marker.kind)}
              aria-expanded={!marker.collapsed}
              aria-label={marker.collapsed ? '展开子树' : '收起子树'}
              title={marker.collapsed ? '展开子树（⌘↑）' : '收起子树（⌘↑）'}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => { event.stopPropagation(); onToggleCollapse(marker.id) }}
            >
              <Icon name={marker.collapsed ? 'chevron-right' : 'chevron-down'} size={16} decorative />
            </button>
          ) : (
            <button
              type="button"
              className={`b-check ${marker.checked ? 'is-checked' : ''}`}
              style={boxStyle(marker.kind)}
              role="checkbox"
              aria-checked={marker.checked}
              aria-label={marker.checked ? '取消勾选待办' : '勾选待办'}
              title={marker.checked ? '取消勾选' : '标记完成'}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => { event.stopPropagation(); onToggleChecked(marker.id) }}
            >
              {/* 勾选态的对勾由 CSS 画（`.b-check.is-checked::before` 双边框 + .16s 弹入，指令 §6.10 指定的画法） */}
            </button>
          )}
        </span>
      ))}
      {cards.map((card) => {
        const chrome = embedCardChromePlacement(card.rect)
        return (
          <span className="eb-chrome" key={`embed-${card.id}`} data-embed-card-for={card.id} data-embed-state={card.state}>
            <span className="eb-icon" style={{ top: chrome.icon.top, left: chrome.icon.left }}>
              {/* 卡头图标 = 链接（链条）图标（原型 `.eb-ico` + 指令 §6.7「嵌入块用链接图标」）；
                  插入菜单里那个「卡片」图标（`embed`）是菜单的事，别混用。 */}
              <Icon name="link" size={16} decorative />
            </span>
            <span className="eb-meta" style={{ top: chrome.meta.top, left: chrome.meta.left, width: chrome.meta.width }}>
              <span className="eb-t">{card.title}</span>
              <span className="eb-s">嵌入块 · 引用自其他页面</span>
            </span>
            <button
              type="button"
              className="eb-pill"
              style={{ top: chrome.pill.top, left: chrome.pill.left, height: EMBED_CARD_GEOMETRY.pillHeight }}
              aria-label={card.state === 'ok' ? '跳转到来源' : '选择来源'}
              title={card.state === 'ok' ? '跳转到来源' : '选择来源页面 / 块'}
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation()
                if (card.state === 'ok') onOpenEmbedSource(card.id)
                else onPickEmbedSource(card.id)
              }}
            >
              {card.state === 'ok' ? '来源 ↗' : '选择来源 ↗'}
            </button>
          </span>
        )
      })}
    </>
  )
}


/** 块浮动工具栏（docs/09 §6.2 `R09-BEDIT-1`）：把手选中后浮在块上方——高频项在条上，长尾在块菜单（`⋯` 与右键同一份清单，`R09-BEDIT-10`）。 */
export function BlockFlybar({ rect, count, activeFormats, onToggleFormat, onConvert, onIndent, onOutdent, onAi, onDelete, onOpenAiPanel, onOpenBlockMenu, onEscape }: {
  rect: AnchorRect
  count: number
  activeFormats: string[]
  onToggleFormat: (format: EditorTextFormat) => void
  onConvert: (event: ReactMouseEvent<HTMLButtonElement>) => void
  onIndent: () => void
  onOutdent: () => void
  onAi?: (action: AiAction) => void
  onDelete: () => void
  onOpenAiPanel?: () => void
  onOpenBlockMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void
  onEscape: () => void
}) {
  const { top, left } = toolbarPlacement('blocks', rect, { width: 560, viewportWidth: typeof window === 'undefined' ? 1200 : window.innerWidth })
  const style: CSSProperties = { top, left }
  // AI 是**下拉**（`R09-BEDIT-5`）：六项按 `AI_UI_OPS` 单一数据源渲染；未实现项的死分支已删（B 批：现无数据命中，由 `accept:R09-SCOPE-17` 看护）。
  const [aiAnchor, setAiAnchor] = useState<AnchorRect | null>(null)
  return (
    <>
      <div
        className="flybar"
        role="toolbar"
        aria-label="块工具栏"
        aria-orientation="horizontal"
        tabIndex={-1}
        style={style}
        onKeyDown={(event) => toolbarKeyDown(event, onEscape)}
        title="⌘/Ctrl+点把手多选 · 拖拽把手移动 · Esc 取消选中"
      >
        {count > 1 ? <span className="fb-count">已选 {count} 块</span> : null}
        {BLOCK_FORMAT_ITEMS.map((item) => (
          <button
            key={item.format}
            type="button"
            className={activeFormats.includes(item.format) ? 'is-on' : ''}
            aria-label={item.label}
            aria-pressed={activeFormats.includes(item.format)}
            title={item.label}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onToggleFormat(item.format)}
          >
            <Icon name={item.icon} size={17} decorative />
          </button>
        ))}
        <span className="div" />
        <button type="button" aria-label="转换块类型" title="转换为块类型（同常驻格式栏的 `Aa ▾`，同一数据源）" onClick={onConvert}><Icon name="heading" size={17} decorative /></button>
        <button type="button" aria-label="缩进" title="缩进（Tab）" onClick={onIndent}><Icon name="indent" size={17} decorative /></button>
        <button type="button" aria-label="反缩进" title="减少缩进（⇧Tab）" onClick={onOutdent}><Icon name="outdent" size={17} decorative /></button>
        <span className="div" />
        <button type="button" aria-label="更多块操作" title="更多块操作（右键块体 / 把手同样打开）" onClick={onOpenBlockMenu}><Icon name="more-vertical" size={17} decorative /></button>
        {onAi ? (
        <button
          type="button"
          aria-label="AI 指令"
          title="AI 指令（作用于选中块）"
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => setAiAnchor((current) => (current ? null : anchorOf(event.currentTarget)))}
        >
          <Icon name="sparkles" size={17} decorative />AI<Icon name="chevron-down" size={13} decorative />
        </button>
        ) : null}
        <span className="div" />
        <button type="button" className="is-danger" aria-label="删除" title="删除选中块（⌘Z 可撤销）" onClick={onDelete}><Icon name="trash" size={17} decorative /></button>
      </div>
      {aiAnchor && onAi ? (
        <Popover anchor={aiAnchor} width={196} label="AI 指令" onClose={() => setAiAnchor(null)}>
          {AI_UI_OPS.map((item) => (
            <button
              key={item.op}
              type="button"
              disabled={!item.action}
              title={item.hint}
              onClick={() => { setAiAnchor(null); if (item.action) onAi?.(item.action) }}
            >
              <span className="mi"><Icon name={item.icon} size={16} decorative /></span>
              <span>{item.label}</span>
              {/* B 批（`R09-STATE-5` / “隐藏优于灰着”）：未实现项的「后续版本」死分支已删（V2c 六项已全实现，现无数据命中）；
                  将来真出现未实现项时，按 `R09-SCOPE-17` 补标注——执行者是 `accept:R09-SCOPE-17` 那三条断言。 */}
            </button>
          ))}
          <hr />
          <button type="button" onClick={() => { setAiAnchor(null); onOpenAiPanel?.() }}>
            <span className="mi"><Icon name="list-tree" size={16} decorative /></span>
            <span>打开 AI 助手</span>
          </button>
        </Popover>
      ) : null}
    </>
  )
}

/**
 * AI 块的常驻标记与操作行（docs/09 §6.11、原型 `.ai-block`）。
 *
 * 块**顶部**是状态与来源标签（`AI 生成` / `AI 生成中` + 操作标签 + 来源标签 + 生成中的 ■停止 与三点），
 * 块**底端**是操作条（✓采用 / ↻重新生成 / ✕丢弃 / 💬继续追问，虚线分隔）。
 * 两条行都由块自己用 CSS 预留出空间（顶部行高 / 底端操作条高度），行贴在块的**内容盒**外沿，
 * 视觉上落在块自己的虚线框里，与原型把 `.lab` / `.ai-ops` 放进块内一致。
 *
 * 常驻不依赖 hover：悬浮方案里操作条长在块外，鼠标一移过去就触发容器的 mouseleave，
 * 操作条先消失——四个操作在真实窗口里根本点不到。
 *
 * 行内容渲染在 Lexical 托管的块之外，块本身仍是普通正文块（可以点进去编辑）。
 */
export function AiBlockBars({ scopeRef, contentRef, enabled, onStop, onAccept, onRegenerate, onDiscard, onFollow, onEscape }: {
  scopeRef: React.RefObject<HTMLElement | null>
  contentRef: React.RefObject<HTMLElement | null>
  enabled: boolean
  onStop: (blockId: string) => void
  onAccept: (blockId: string) => void
  onRegenerate: (blockId: string) => void
  onDiscard: (blockId: string) => void
  onFollow: (blockId: string) => void
  onEscape: () => void
}) {
  const [bars, setBars] = useState<AiBar[]>([])
  const signatureRef = useRef('')
  const frameRef = useRef<number | null>(null)

  /** 一次测量：读出编辑器里每个 AI 块的状态与盒子，算出两条行该贴在哪。 */
  const measure = useCallback(() => {
    const content = contentRef.current
    if (!content) return
    // 行画在**滚动容器的内容坐标**里（`position: absolute` 挂在 `.doc-col` 上），不是视口坐标：
  // 视口坐标 + `position: fixed` 时，快速滚动会让它们落后一帧再弹回原位（用户实测 
    // 「移动页面太快，AI 块上下抖动、移动然后回到原位」——合成器滚动不等主线程，这是必然结果）。
    // 内容坐标由浏览器自己带着滚。**可见带的判断仍用视口坐标**：块滚到顶栏底下就不画行。
    // 坐标系与可见带都由定位服务回答（'content' = 内容坐标 + 正文滚动容器那条可见带）：
    // 原来这里自己抄了一份换算，AI 行那边又抄了一份（T7 收口，见 ui/blockAnchor.ts）。
    const frame = anchorFrameOf(content, 'content')
    const sources: AiBarSource[] = []
    for (const element of content.querySelectorAll<HTMLElement>('.moqi-block[data-ai-status][data-entity-id]')) {
      const id = element.dataset.entityId
      if (!id) continue
      const rect = element.getBoundingClientRect()
      if (!frame.inView(rect)) continue
      const style = getComputedStyle(element)
      sources.push({
        id,
        status: element.dataset.aiStatus ?? '',
        op: element.dataset.aiOp ?? '',
        src: element.dataset.aiSrc ?? '',
        rect: frame.rect(rect),
        padding: {
          top: parseFloat(style.paddingTop) || 0,
          right: parseFloat(style.paddingRight) || 0,
          bottom: parseFloat(style.paddingBottom) || 0,
          left: parseFloat(style.paddingLeft) || 0,
        },
      })
    }
    const next = aiBarsFrom(sources)
    /**
     * 操作条会因为正文列变窄而换行，块底端预留的高度按**实测行高**写回块上
   * （`--ai-ops-h`，CSS 兜底 53px）。两条稳定性规则（，用户报「AI 块文字滚动时上下抖动」）：
     * - **只在值真的变了才写**：这段代码跑在滚动重测的每一帧上，每帧写一次自定义属性会让浏览器
     *   在滚动过程中反复重排（整块文字随之上下抖）；
     * - **读不到操作行时保留上一次的值**，不要退回 CSS 兜底：实测行高 54px 与兜底 53px 会来回跳，
     *   每帧一跳就是 1px 的抖动，正是用户看到的现象。行宽不变时行高本来就不变。
     */
    const scope = scopeRef.current
    if (scope) {
      for (const bar of next) {
        const element = blockElementById(content, bar.id)
        if (!element) continue
        const row = scope.querySelector<HTMLElement>(`.ai-block-bar[data-marker-for="${bar.id}"] > .ai-ops`)
        const height = row ? row.getBoundingClientRect().height : 0
        const measured = height > 0 ? `${Math.ceil(height + 14)}px` : element.style.getPropertyValue('--ai-ops-h')
        if (measured && element.style.getPropertyValue('--ai-ops-h') !== measured) {
          element.style.setProperty('--ai-ops-h', measured)
        }
      }
    }
    const signature = next
      .map((bar) => `${bar.id}:${bar.variant}:${Math.round(bar.box.top)}:${Math.round(bar.box.left)}:${Math.round(bar.box.width)}:${Math.round(bar.box.height)}`)
      .join('|')
    if (signature === signatureRef.current) return
    signatureRef.current = signature
    setBars(next)
  }, [contentRef, scopeRef])

  const schedule = useCallback(() => {
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      measure()
    })
  }, [measure])

  // 行的位置来自布局：内容变动（流式写入、光标换行、采用/丢弃）、滚动、窗口尺寸都要重新测量。
  useEffect(() => {
    const scope = scopeRef.current
    const content = contentRef.current
    if (!scope || !content || !enabled) return
    const observer = new MutationObserver(() => schedule())
    observer.observe(content, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-ai-status'] })
    // 同标记层：滚动元素是正文列的父级 `.editor-body`，只有 window 捕获阶段收得到（见上一处的说明）。
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    schedule()
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      if (frameRef.current !== null) { cancelAnimationFrame(frameRef.current); frameRef.current = null }
    }
  }, [enabled, scopeRef, contentRef, schedule])

  if (!enabled) return null

  return (
    <>
      {bars.map((bar) => (
        <div
          className="ai-block-bar"
          key={bar.id}
          data-marker-for={bar.id}
          data-ai-variant={bar.variant}
          style={{ top: bar.box.top, left: bar.box.left, width: bar.box.width, height: bar.box.height }}
        >
          <div className="ai-lab">
            <Icon name="sparkles" size={12} decorative />
            {bar.variant === 'generating' ? 'AI 生成中' : 'AI 生成'}
            <span className="op-tag">{bar.op}</span>
            <span className="src-tag" title="来源关联保留至采用 / 丢弃">{bar.src}</span>
            {bar.variant === 'generating' ? (
              <>
                <button type="button" className="ai-stop" onClick={() => onStop(bar.id)}>■ 停止</button>
                <span className="ai-dots" aria-hidden="true"><i /><i /><i /></span>
              </>
            ) : null}
          </div>
          {bar.variant === 'done' ? (
            <div
              className="ai-ops"
              role="toolbar"
              aria-label="AI 块操作"
              aria-orientation="horizontal"
              onKeyDown={(event) => toolbarKeyDown(event, onEscape)}
            >
              <button type="button" className="ok" onMouseDown={(event) => event.preventDefault()} onClick={() => onAccept(bar.id)}>✓ 采用<span className="sub">合并为普通块</span></button>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => onRegenerate(bar.id)}>↻ 重新生成</button>
              <button type="button" className="no" onMouseDown={(event) => event.preventDefault()} onClick={() => onDiscard(bar.id)}>✕ 丢弃</button>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => onFollow(bar.id)}>💬 继续追问</button>
            </div>
          ) : null}
        </div>
      ))}
    </>
  )
}
