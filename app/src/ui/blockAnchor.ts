import { useEffect, useRef, useState , type KeyboardEvent as ReactKeyboardEvent} from 'react'
import { anchorOf, type AnchorRect } from './Popover'

/**
 * 浮层 / 标记的**定位服务**（docs/09 §6.9 `R09-BEDIT-9`）。
 *
 * 一次测量要回答两件**互相独立**的事——历史上被混在一起写过好几遍（T7 收口）：
 * ① **坐标系**：坐标是视口的（`position: fixed` 浮层）还是**滚动容器内容坐标**的
 *   （`position: absolute`、画在 `.doc-col` 里的块标记与 AI 行）；
 * ② **可见带**：「该不该画」按哪块矩形判——正文锚点用 `.doc-col`，列表浮层用它所在的
 *   那个可滚动祖先。
 *
 * 本模块是这两件事的唯一所有者，外加 `useFrameMeasure` 这条「滚动 / 尺寸变化里只登记一帧」
 * 的节拍；`useBlockAnchor` / `useFloatingAnchor` 只是它的两个消费者。
 *
 * 两条踩出来的纪律（不要退回去）：
 * - **位置不能缓存在菜单状态里**：打开那一刻量一次、之后不量，滚动页面菜单就停在原地
 *  （斜杠菜单先踩，`[[` / `((` 双链菜单随后踩，用户实测 ）。位置是派生视图数据。
 * - **块滚出可见带就不许再画**：浮层是 `--z-popover`（高于 `--z-sticky`），跟到头部底下就会
 *   浮在格式栏与窗口栏之上（用户实测：「向上滚的时候菜单悬浮在格式栏窗口的上面」）。
 */

/** 浮层该画在哪：正文块的**内容盒下沿**（视口坐标）＋「它还该不该被画」。 */
export type BlockAnchorRect = {
  /** 这份测量属于哪个块：换块后旧位置立刻作废，浮层不会带着上一处的位置闪一帧。 */
  blockId: string
  top: number
  /** 锚块自己的顶沿（视口坐标）：`menuPlacement` 上翻的基准（下沿在 `top` 里）。 */
  blockTop: number
  left: number
  /** 锚点块是否还在正文滚动视口里（滚到格式栏底下 / 视口外时为假）。 */
  inView: boolean
}

/** 坐标系：`viewport` = 原样用视口坐标；`content` = 换算成滚动容器的内容坐标。 */
export type AnchorSpace = 'viewport' | 'content'

export type Band = { top: number; bottom: number; left: number; right: number }

/** 纯函数：视口矩形 → 滚动容器**内容坐标**（`相对容器的偏移 + 已滚过的量`）。 */
export function toContentRect(rect: Rect, frame: { containerTop: number; containerLeft: number; scrollTop: number; scrollLeft: number }): Rect {
  return {
    top: rect.top - frame.containerTop + frame.scrollTop,
    bottom: rect.bottom - frame.containerTop + frame.scrollTop,
    left: rect.left - frame.containerLeft + frame.scrollLeft,
    right: rect.right - frame.containerLeft + frame.scrollLeft,
    width: rect.width,
    height: rect.height,
  }
}

/** 纯函数：两个矩形相交（可见带的判据）。 */
export function overlaps(a: Band, b: Band): boolean {
  return a.bottom > b.top && a.top < b.bottom && a.right > b.left && a.left < b.right
}

/** 正文的滚动容器（`.doc-col`）：块标记与 AI 行的**定位祖先**，也是正文锚点的可见带。 */
export function docScrollerOf(element: HTMLElement): HTMLElement | null {
  return element.closest<HTMLElement>('.doc-col')
}

/** 锚点元素所在的**可见带**：最近的可滚动祖先（没有就退回视口）。列表类浮层用它。 */
export function visibleBandOf(element: HTMLElement): Band {
  let parent = element.parentElement
  while (parent) {
    const style = getComputedStyle(parent)
    const scrollable = /(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflowX}`)
    if (scrollable && parent.scrollHeight > parent.clientHeight) {
      const rect = parent.getBoundingClientRect()
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
    }
    parent = parent.parentElement
  }
  return { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth }
}

function docBand(element: HTMLElement): Band {
  const scroller = docScrollerOf(element)
  if (!scroller) return { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth }
  const rect = scroller.getBoundingClientRect()
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right }
}

/**
 * 一次测量的框架：`rect()` 按坐标系换算，`inView()` 按可见带判「该不该画」。
 *
 * `band` 缺省是正文滚动容器（正文锚点 / 块标记 / AI 行都用它）；列表类浮层显式传 `'nearest'`。
 * 两个消费者各取所需地组合这两件事，不再各自抄一份换算（块标记与 AI 行原来各抄了一份）。
 */
export function anchorFrameOf(
  element: HTMLElement,
  space: AnchorSpace,
  band: Band | 'nearest' = docBand(element),
): { rect: (rect: Rect) => Rect; inView: (rect: Rect) => boolean } {
  const resolved = band === 'nearest' ? visibleBandOf(element) : band
  const inView = (rect: Rect) => overlaps(rect, resolved)
  if (space === 'viewport') return { rect: (rect) => rect, inView }
  const scroller = docScrollerOf(element)
  if (!scroller) return { rect: (rect) => rect, inView }
  const container = scroller.getBoundingClientRect()
  const frame = { containerTop: container.top, containerLeft: container.left, scrollTop: scroller.scrollTop, scrollLeft: scroller.scrollLeft }
  return { rect: (rect) => toContentRect(rect, frame), inView }
}

/**
 * **文字选区**的锚点矩形（`R09-BEDIT-9`）：这是「两个工具栏各算各的锚点矩形」的**文字侧**
 * （块侧是 `useBlockSelection.selectionRect`——第一个选中块的元素矩形，那边是单一所有者）。
 *
 * 三条「工具栏不该出」的守卫都在这儿：选区缺失 / 收拢（`isCollapsed`）、选区两端不在编辑器根里
 * （点在侧栏、面板里的选择不算）、退化矩形（宽高全 0，通常是空行上的落点）。返回 `null` = 不出。
 */

/**
 * 「滚动 / 尺寸变化里只登记一帧再测」的循环 —— 所有定位消费者共用这一条节拍。
 *
 * 测量挂 **window 的捕获阶段**：真正滚动的元素往往是锚点所在的那个滚动容器（`.doc-col`、
 * `.lib-stack`…），scroll 不冒泡、但会捕获，挂 window 才收得到。`restartKey` 变化时立刻重测一次
 * （换块 / 换锚点要马上量，不能等下一次滚动）；`measure` 走 ref，避免把 effect 绑到每次渲染。
 */
export function useFrameMeasure(measure: () => void, enabled: boolean, restartKey: unknown): void {
  const measureRef = useRef(measure)
  useEffect(() => { measureRef.current = measure })
  useEffect(() => {
    if (!enabled) return
    let frame: number | null = null
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(() => { frame = null; measureRef.current() })
    }
    schedule()
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    return () => {
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [enabled, restartKey])
}

/** 只依赖 `getRootElement`，不把 Lexical 的 `LexicalEditor` 类型带进 UI（模块化 M2-1）。 */
type EditorRootSource = { getRootElement(): HTMLElement | null }

export function useBlockAnchor(editor: EditorRootSource, blockId: string | null, enabled: boolean): BlockAnchorRect | null {
  const [measured, setMeasured] = useState<BlockAnchorRect | null>(null)

  useFrameMeasure(() => {
    if (blockId === null) return
    const root = editor.getRootElement()
    const element = root ? blockElementById(root, blockId) : null
    if (!element) {
      // 块没了（被删 / 换页）：没有锚点可跟，浮层据此收起。
      setMeasured((current) => (current === null ? current : null))
      return
    }
    const frame = anchorFrameOf(element, 'viewport')
    const rect = element.getBoundingClientRect()
    const next: BlockAnchorRect = { blockId, top: rect.bottom + 4, blockTop: rect.top, left: rect.left, inView: frame.inView(rect) }
    setMeasured((current) => current && current.blockId === next.blockId && current.top === next.top
      && current.left === next.left && current.inView === next.inView ? current : next)
  }, enabled && blockId !== null, blockId)

  if (!enabled || blockId === null) return null
  // 只认属于当前块的那份测量：换块瞬间不拿旧位置顶上。
  return measured && measured.blockId === blockId ? measured : null
}

/* 块锚菜单（斜杠 / `[[`·`((` 双链）的落位口径，与 `Popover` 同一套（GAP / EDGE / 220 门槛），
   只是锚形不同——那边是触发按钮的矩形，这边是块的下沿 / 顶沿。 */
const MENU_GAP = 4
const MENU_EDGE = 12
/** 「下方放不下这么高的菜单就考虑上翻」的门槛（同 `Popover` 的 220：约六条目，再多靠盒内滚动）。 */
const MENU_FLIP_H = 220
/** 高度下限：两侧都没空间时兜底——超大面积块（整屏表格 / 源码块）里的菜单也必须滚得到尾。 */
const MENU_MIN_H = 96

/**
 * 块锚菜单落位：优先就地展开在块下方；下方放不下（`MENU_FLIP_H`）且上方更宽就上翻到块顶上。
 * 再把高度夹进所在一侧的可用空间——**菜单盒任何情况下都要完整落在视口里**：此前只有
 * `max-height: 60dvh` 不夹视口，块贴近窗口底时盒子下半截被窗口截掉，盒内滚动永远够不着尾部
 * （「行内」组看不见，用户实测）。
 */
export function menuPlacement(anchor: { top: number; blockTop: number }, viewportHeight: number): { top: number | null; bottom: number | null; maxHeight: number } {
  const below = viewportHeight - anchor.top - MENU_EDGE
  const above = anchor.blockTop - MENU_GAP - MENU_EDGE
  const flip = below < MENU_FLIP_H && above > below
  return flip
    ? { top: null, bottom: viewportHeight - anchor.blockTop + MENU_GAP, maxHeight: Math.max(MENU_MIN_H, above) }
    : { top: anchor.top, bottom: null, maxHeight: Math.max(MENU_MIN_H, below) }
}

/** 视口高订阅（`Popover` 里那份订阅的块锚菜单读者）：键盘弹出 / WebView 首帧 innerHeight 会变，落位要随动。 */
export function useViewportHeight(): number {
  const [height, setHeight] = useState(() => (typeof window === 'undefined' ? 800 : window.innerHeight))
  useEffect(() => {
    const read = () => setHeight(window.innerHeight)
    window.addEventListener('resize', read)
    window.visualViewport?.addEventListener('resize', read)
    return () => {
      window.removeEventListener('resize', read)
      window.visualViewport?.removeEventListener('resize', read)
    }
  }, [])
  return height
}

/**
 * 锚在**任意元素**上的浮层（页面库卡片的 ⋯ 菜单、侧栏标签的 ⋯ 菜单）。可见带 = 它所在的列表
 * （`anchorFrameOf` 的 `'nearest'` 档）：卡片菜单曾经只在打开那一刻量一次，于是在页面库里滑动
 * 列表时菜单停在原处不动——既没跟着卡片、也没收起来（用户实测 ）。
 *
 * 这一版的口径（用户第二轮实测后定的）：**列表一滚动就收起**——判据是「锚点相对打开那一刻
 * 移动了，或滚出了可见带」。判据放在这里、拿**打开那一刻**的矩形当基准、在每次测量里比：
 * - 不用 scroll 事件：scroll 事件异步派发，点开菜单前那一下 `scrollIntoView` 的事件会晚到，
 *   正好把刚打开的菜单立刻关掉（accept 里实测踩到）；
 * - 不回读 React state 里的旧测量：同一个元素重开时，状态里可能还留着上一轮（滚动前）的位置，
 *   拿它和新位置一比就会误判成「移动了」（真窗口实测踩到）。
 * `onAnchorLost` 由测量（rAF）里调用，调用方据此收起菜单。
 */
export function useFloatingAnchor(
  element: HTMLElement | null,
  enabled: boolean,
  onAnchorLost?: () => void,
): { anchor: AnchorRect; inView: boolean } | null {
  const [measured, setMeasured] = useState<{ id: HTMLElement; anchor: AnchorRect; inView: boolean } | null>(null)
  const lostRef = useRef(onAnchorLost)
  useEffect(() => { lostRef.current = onAnchorLost })
  // **打开那一刻**的矩形：本次 effect 就是「打开 / 换锚点」触发的，基准在这里取（早于下面的测量）。
  const baselineRef = useRef<AnchorRect | null>(null)
  useEffect(() => { baselineRef.current = element ? anchorOf(element) : null }, [element, enabled])

  useFrameMeasure(() => {
    if (!element) return
    const anchor = element.isConnected ? anchorOf(element) : null
    if (!anchor) {
      setMeasured((current) => (current === null ? current : null))
      lostRef.current?.()
      return
    }
    const frame = anchorFrameOf(element, 'viewport', 'nearest')
    const inView = frame.inView(anchor)
    const baseline = baselineRef.current
    const moved = baseline !== null && (Math.abs(anchor.top - baseline.top) > 2 || Math.abs(anchor.left - baseline.left) > 2)
    if (moved || !inView) lostRef.current?.()
    setMeasured((current) => current && current.id === element && current.anchor.top === anchor.top
      && current.anchor.left === anchor.left && current.inView === inView ? current : { id: element, anchor, inView })
  }, enabled && element !== null, element)

  if (!enabled || !element) return null
  return measured && measured.id === element ? { anchor: measured.anchor, inView: measured.inView } : null
}

import type { Rect as RectT } from '@moqi/editor'
type Rect = RectT
export {
  textSelectionRectOf, toolbarPlacement, type Rect, type ToolbarAnchorKind,
} from '@moqi/editor'

export type BlockRect = { top: number; left: number; right: number; bottom: number; height: number; width: number }

export function rectOf(element: Element): BlockRect {
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
