/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { BlockType } from '../domain/block'

/**
 * 块级可交互元素的规则与几何（docs/09 §五 / §6.2、docs/04 §7）。
 *
 * 这里是唯一真相：**哪些块在什么状态下、在什么位置出现哪个标记**。
 * 装饰层只负责照着这份规则把真实按钮摆上去，不再用坐标命中去猜用户想点哪里。
 *
 * 规范依据与取舍：
 * - 把手 hover 显示，盒左边缘在块左侧 -22px（§五）；行尾 ＋ 的盒右边缘在块右侧 -8px（原型 `.b-plus{right:8px}`）。
 * - 折叠箭头只属于**标题块**（§6.2「标题折叠｜标题块 hover 的折叠箭头」），并且只有真的有子块才出现；
 *   其他类型仍可用 ⌘↑ 折叠（领域允许），但箭头是标题的专用入口。
 * - 待办复选框只属于待办块，且**常驻可见**（不是 hover 才出现）。
 * - **页面对象块是容器，不是正文块**：它不带把手、＋、折叠、复选框。空页面曾经出现
 *   「一整排两个小图标 + 整页可折叠」，就是容器被当成普通块的结果（旧实现用 CSS `:has(> .moqi-block)` 猜结构）。
 * - 点击目标按 docs/04 §7：桌面至少 32px。视觉盒沿用原型尺寸，点击区用 `hit` 向外扩，
 *   但**左右扩的量必须保证相邻标记的点击区不重叠**，否则把手会吃掉折叠箭头的命中。
 */
/**
 * 编号列表的序号（docs/09 §五）：**同级、相邻、同类型的连续段各自从 1 开始**。
 *
 * 用户 2026-09-30 问的就是这条口径：一段编号列表 → 普通文字 → 又一段编号列表，
 * 后一段**重新从 1 开始**（不是全文流水号）；缩进到下一层的编号也**在自己的层级里从 1 开始**
 * （不与父级共用序号）。同段的切分就是这条纯函数：碰到别的类型就归零。
 *
 * 过去这份数字是 CSS 计数器算的，结果踩了一个更隐蔽的坑：标记画在 `::after` 上，而
 * `::after` 排在**块的子树之后**——带子编号的那一项读到的计数器已经被子项加过，
 * 于是「第二条」显示成 3、子条也显示 3（用户实测 2026-09-30）。现在改成数据驱动：
 * 序号由这里算、写进 `data-ordinal`，CSS 只读 `attr(data-ordinal)`。
 */
export function listOrdinal(siblingTypes: BlockType[], index: number, type: BlockType): number | null {
  if (type !== 'numbered') return null
  if (index < 0 || index >= siblingTypes.length) return null
  let ordinal = 0
  for (let i = 0; i <= index; i += 1) ordinal = siblingTypes[i] === type ? ordinal + 1 : 0
  return ordinal > 0 ? ordinal : null
}

export type MarkerKind = 'handle' | 'plus' | 'collapse' | 'check'

export type MarkerInput = {
  type: BlockType
  /** 页面对象块（容器）：不参与任何块级操作。 */
  isObject: boolean
  /** 该块在编辑器里是否有直接子块（DOM 结构，不是领域字段）。 */
  hasChildBlocks: boolean
  collapsed: boolean
  hovered: boolean
  selected: boolean
  /** 触屏档（`10` §4.3 · `W2` 后半）：只留折叠箭头与待办圈——把手 / ＋ 是 hover 桌面件，不上手机。 */
  compact?: boolean
}

export type MarkerGeometry = {
  /** 锚点：左边缘的标记用块左侧定位，行尾 ＋ 用块右侧定位。 */
  anchor: 'left' | 'right'
  /** 视觉盒水平偏移：左锚点是盒左边缘相对块左边缘，右锚点是盒左边缘相对块右边缘（负值=向内）。 */
  offset: number
  width: number
  height: number
  /** 点击区相对视觉盒向外扩展 [上, 右, 下, 左]，正值向外，`0` 表示该侧不扩。 */
  hit: [number, number, number, number]
}

export const MARKER_GEOMETRY: Record<MarkerKind, MarkerGeometry> = {
  handle: { anchor: 'left', offset: -22, width: 22, height: 32, hit: [5, 10, 5, 0] },
  collapse: { anchor: 'left', offset: -44, width: 22, height: 32, hit: [5, 0, 5, 10] },
  check: { anchor: 'left', offset: 10, width: 16, height: 16, hit: [8, 8, 8, 0] },
  plus: { anchor: 'right', offset: -30, width: 22, height: 32, hit: [5, 8, 5, 5] },
}

/**
 * 触屏档折叠箭头的几何（`10` §2.3 / §4.3 · `W2` 后半）：住正文列左侧 **30px 折叠沟槽**——
 * 文字起于 34px（`.doc-col` 的左内边距），视觉盒落在沟槽里（块左缘 −26..−4，视口 8..30）；
 * 命中区 30×42（贴沟槽限宽，是 §1.2「≥44px」原则的**唯一例外项**，垂直向为整行高）。
 */
const COMPACT_COLLAPSE_GEOMETRY: MarkerGeometry = { anchor: 'left', offset: -26, width: 22, height: 32, hit: [5, 0, 5, 8] }

/** 取几何：触屏档的折叠箭头单独一套（其余沿用桌面档）。 */
export function markerGeometryOf(kind: MarkerKind, compact = false): MarkerGeometry {
  return compact && kind === 'collapse' ? COMPACT_COLLAPSE_GEOMETRY : MARKER_GEOMETRY[kind]
}

/** 该块当前应显示哪些标记，顺序固定（左→右）。 */
export function markersForBlock(input: MarkerInput): MarkerKind[] {
  if (input.isObject) return []
  const kinds: MarkerKind[] = []
  // 折叠箭头：**有子块的块都能折叠，不限标题**（`R09-BLOCK-7`，2026-10-10 裁决 `W2`）。
  // **触屏档常显**（`10` §6.2 定稿 · 2026-10-14 裁决 `D10`）：`hovered` 是鼠标事件，触屏只在
  // tap 后的 hover 残留里偶现 ⇒ 有子块的块一律出箭头（可发现性；真机读作噪声时退路 = 只在编辑 / 选中态）。
  if (input.hasChildBlocks && (input.hovered || input.collapsed || input.compact)) kinds.push('collapse')
  // 触屏档只留折叠箭头 + 待办圈（把手 / ＋ 是 hover 桌面件；`MOD-MOBILE`「桌面件不上手机」）。
  if (input.compact) {
    if (input.type === 'todo') kinds.push('check')
    return kinds
  }
  if (input.hovered || input.selected) kinds.push('handle')
  if (input.type === 'todo') kinds.push('check')
  if (input.hovered) kinds.push('plus')
  return kinds
}

/**
 * 标记在块坐标里的水平区间（0 = 块左边缘，`blockWidth` = 块右边缘），
 * 用于断言「看得见的控件互不重叠」。行尾 ＋ 是右锚点，必须给出块宽。
 */
export function markerSpan(kind: MarkerKind, blockWidth: number, compact = false): [number, number] {
  const geometry = markerGeometryOf(kind, compact)
  const base = geometry.anchor === 'right' ? blockWidth + geometry.offset : geometry.offset
  return [base, base + geometry.width]
}

/** 点击区在块坐标里的水平区间（视觉盒 + `hit` 扩展）。 */
export function markerHitSpan(kind: MarkerKind, blockWidth: number, compact = false): [number, number] {
  const geometry = markerGeometryOf(kind, compact)
  const base = geometry.anchor === 'right' ? blockWidth + geometry.offset : geometry.offset
  return [base - geometry.hit[3], base + geometry.width + geometry.hit[1]]
}

/** 点击区的实际尺寸（docs/04 §7 要求桌面 ≥32px）。 */
export function markerHitSize(kind: MarkerKind): { width: number; height: number } {
  const { width, height, hit } = MARKER_GEOMETRY[kind]
  return { width: width + hit[1] + hit[3], height: height + hit[0] + hit[2] }
}

function overlaps(a: [number, number], b: [number, number]): boolean {
  return Math.max(a[0], b[0]) < Math.min(a[1], b[1]) - 0.5
}

export function markerOverlaps(left: MarkerKind, right: MarkerKind, blockWidth: number): boolean {
  return overlaps(markerSpan(left, blockWidth), markerSpan(right, blockWidth))
}

export function markerHitOverlaps(left: MarkerKind, right: MarkerKind, blockWidth: number): boolean {
  return overlaps(markerHitSpan(left, blockWidth), markerHitSpan(right, blockWidth))
}

/** 装饰层渲染按钮时的内联几何：宽度高度与点击区都用这里的值，避免 CSS 与规则漂移。 */
export function markerBoxStyle(kind: MarkerKind, compact = false): { width: number; height: number; hit: string } {
  const { width, height, hit } = markerGeometryOf(kind, compact)
  return { width, height, hit: `${-hit[0]}px ${-hit[1]}px ${-hit[2]}px ${-hit[3]}px` }
}

/** 标记盒在视口坐标里的位置：垂直贴在块自己那一行上，水平按锚点落在块左/右边缘之外。 */
export function markerPlacement(kind: MarkerKind, rect: { left: number; right: number }, lineCenter: number, compact = false): { top: number; left: number } {
  const geometry = markerGeometryOf(kind, compact)
  return {
    top: lineCenter - geometry.height / 2,
    left: (geometry.anchor === 'right' ? rect.right : rect.left) + geometry.offset,
  }
}

/**
 * 嵌入卡（`R09-BLOCK-24`）的几何。卡片本体是 **CSS 在流里画的**（`.moqi-block-embed` 的
 * 两个伪元素 = 头部与正文区），这样长标题 / 长正文的换行由浏览器撑高，不需要量高再回写。
 * 这里只放**卡片自己的承重数值**与**卡头三个覆盖元素的落点**：
 * 装饰层要在卡头里画图标块、标题两行、「来源 ↗」胶囊——伪元素点不了，且三段文字要三种样式，
 * 它们必须是真元素。
 *
 * `padX` / `padY` / `head` 与 `app.css` 里 `.moqi-block-embed` 的内边距、`::before` 的高度是同一组数字，
 * 验收项 `R09-BLOCK-24` 会读计算样式对一遍（CSS 与规则不许漂移）。
 * `pillReserve` 不是胶囊的实际宽度——胶囊按原型 `.eb-go` **内容宽**（右锚 + `translateX(-100%)`），
 * 这个数只用来给标题让位（`meta.width` 的预留）。
 */
export const EMBED_CARD_GEOMETRY = { padX: 14, padY: 12, head: 34, iconBox: 34, iconGap: 11, pillReserve: 96, pillHeight: 26 }

/** 卡头三个覆盖元素（图标块 / 标题两行 / 来源胶囊）的落点：卡头是块顶部 `padY + head` 那一段。 */
export function embedCardChromePlacement(rect: { top: number; left: number; right: number }): {
  icon: { top: number; left: number }
  pill: { top: number; left: number }
  meta: { top: number; left: number; width: number }
} {
  const g = EMBED_CARD_GEOMETRY
  return {
    icon: { top: rect.top + g.padY, left: rect.left + g.padX },
    // 胶囊**右缘贴着卡片右内边**（`translateX(-100%)` 在 CSS 里向左贴），宽度由内容撑——照原型。
    pill: { top: rect.top + g.padY + (g.head - g.pillHeight) / 2, left: rect.right - g.padX },
    // 标题两行占「图标右侧 → 胶囊左侧」的整段（原型 `.eb-meta` 的 `flex:1`）：
    // 标题超长由 CSS 省略号处理，不再在 JS 里按字符数硬截（那是卡头两行共用一份样式的旧兜底）。
    meta: {
      top: rect.top + g.padY,
      left: rect.left + g.padX + g.iconBox + g.iconGap,
      width: Math.max(0, rect.right - rect.left - g.padX * 2 - g.iconBox - g.iconGap * 2 - g.pillReserve),
    },
  }
}

/**
 * 块**自己那一行**的垂直中心。
 *
 * 原型里 `.b-handle{top:50%}` 取的就是块的中心——因为原型的块都没有子块，中心即自己这一行。
 * 真实数据里父块的盒子会连子块一起变高（标题带 3 个子块时盒子高一百多像素），
 * 用盒子中心会让把手和折叠箭头浮在整棵子树的中间，甚至落到子块那一行上。
 * 所以这里只取「上内边距 + 一行行高的一半」，单行块的结果与盒子中心完全一致。
 */
export function ownLineCenter(lineHeight: number, paddingTop: number, rect: { top: number; height: number }): number {
  const own = Number.isFinite(lineHeight) ? paddingTop + lineHeight / 2 : rect.height / 2
  return rect.top + Math.min(own, rect.height / 2)
}

/**
 * 指针决定「当前悬停哪个块」（docs/04 §7 / docs/09 §五）。
 *
 * 归属用显式标记判定，不做坐标命中、不猜 DOM 结构：
 * - 指针直接落在块上 → 那个块；
 * - 指针落在**属于当前悬停块**的附属行上（`[data-marker-for]`：把手等块标记、AI 块的标签行与操作行）
 *   → 保持该块的悬停。否则鼠标一移到块自己的浮层上悬停态就断，浮层先消失（AI 操作条因此永远点不到）；
 * - 其余 → 没有悬停块。
 */
export function hoveredIdFromPointer(blockId: string | null, attachedBlockId: string | null, currentId: string | null): string | null {
  if (blockId) return blockId
  if (attachedBlockId && attachedBlockId === currentId) return currentId
  return null
}
