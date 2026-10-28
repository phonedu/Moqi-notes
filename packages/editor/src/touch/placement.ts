/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/***
 * 工具栏落点数学（M7 从壳 `ui/blockAnchor` 抽进包）：`textSelectionRectOf`（文字选区取窄矩形，
 * 三条不出守卫：缺失 / 收拢 / 两端不在根内 / 退化矩形）与 `toolbarPlacement`（文字条与块条
 * 两种锚点语义的落点——**有意不同，不许顺手对齐**：text 居中钳边 + 顶放不下翻下；
 * blocks 左缘对齐 + 恒贴上方不翻）。壳的 `blockAnchor` 转出口保持旧调用点不动。
 */
export type Rect = { top: number; left: number; right: number; bottom: number; width: number; height: number }

export function textSelectionRectOf(root: HTMLElement | null, selection: Selection | null): Rect | null {
  if (!root || !selection || selection.rangeCount === 0 || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const rect = range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null
  return { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }
}

/**
 * 工具栏浮条的落点（`R09-BEDIT-1/9`）——**两个工具栏共用这一份数学**（文字工具条与块浮动工具条
 * 原来各写一遍；0.6.0 触控的「键盘上方格式栏」照这张表加第三档）。
 *
 * 两个锚点来源的语义不同，落点规则也就不同（**有意不同，不许顺手对齐**）：
 * - `text`（`TextToolbar`）：锚点是**文字选区的窄区间**——水平按选区中心居中，两侧各留 8px 钳进视口；
 *   垂直默认贴选区上方 44px，**顶上放不下（锚点 top < 64）就翻到下方**（`bottom + 12`）。
 * - `blocks`（`BlockFlybar`）：锚点是**整行宽的块**——水平左缘对齐块（只按浮条宽度从右侧钳回，
 *   没有右侧 8px 边距）；垂直同样贴上方 44px 但**不翻转**（从上面掉下来会盖住正在编辑的那一行），
 *   只钳 `top ≥ 8`。
 */
export type ToolbarAnchorKind = 'text' | 'blocks'

export function toolbarPlacement(
  kind: ToolbarAnchorKind,
  anchor: Rect,
  options: { width: number; viewportWidth: number },
): { top: number; left: number } {
  if (kind === 'text') {
    const left = Math.max(8, Math.min(anchor.left + anchor.width / 2 - options.width / 2, options.viewportWidth - options.width - 8))
    const flip = anchor.top < 64
    return { top: flip ? anchor.bottom + 12 : anchor.top - 44, left }
  }
  const left = Math.max(8, Math.min(anchor.left, options.viewportWidth - options.width))
  return { top: Math.max(8, anchor.top - 44), left }
}
