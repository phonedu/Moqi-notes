/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * 拖拽落点指示线（单一所有者）：一条独立于块的整横线，落在目标间隙的正中。
 *
 * 为什么要真元素而不是块上的 CSS：块伪元素全被占（列表标记 / 选择圈 / 引用轨），
 * box-shadow 方案（inset 也好 outset 也好）都贴着块的圆角轮廓画——三态拼起来
 * 读作一个「左括号」而不是线（用户 2026-10-26 两轮反馈）。整横线 + 左右翘头
 * 不与任何块轮廓重合，落点读得懂。
 *
 * 线挂在 `.doc-col`（滚动容器）里用**内容坐标**定位——fixed 追滚动必抖
 * （「AI 块上下抖动」同族教训）。before/after = 水平线；into = 左缘竖轨
 * （与横线形态迥异、语义是「放入其内」）。调用点（桌面 BlockTools / 触控
 * touchEditorLayer）只报「目标块 + 位置」，画与清都归这里。
 */

const LINE_ID = 'moqi-drop-line'

function lineElement(): HTMLElement {
  let line = document.getElementById(LINE_ID)
  if (!line) {
    line = document.createElement('div')
    line.id = LINE_ID
    line.className = 'drop-line'
    line.setAttribute('aria-hidden', 'true')
    document.querySelector('.doc-col')?.appendChild(line)
  }
  return line
}

/** 清线（抬起 / 非法落点 / 拖拽结束都走它）。 */
export function clearDropLine(): void {
  document.getElementById(LINE_ID)?.remove()
}

export type DropLinePosition = 'before' | 'after' | 'into'

/** 在目标块的间隙（before/after）或左缘（into）摆线。非法目标（null）等同清线。 */
export function showDropLine(target: HTMLElement | null, position: DropLinePosition): void {
  const line = target ? lineElement() : null
  if (!line || !target) { clearDropLine(); return }
  const scroller = target.closest<HTMLElement>('.doc-col')
  if (!scroller) { clearDropLine(); return }
  const blockRect = target.getBoundingClientRect()
  const scrollRect = scroller.getBoundingClientRect()
  // 内容坐标：视口坐标 − 容器视口原点 + 容器 scrollTop（水平方向不滚，直接用）
  const topBase = blockRect.top - scrollRect.top + scroller.scrollTop
  const leftBase = blockRect.left - scrollRect.left
  if (position === 'into') {
    line.classList.add('is-into')
    line.style.top = `${topBase}px`
    line.style.height = `${blockRect.height}px`
    line.style.left = `${leftBase - 5}px`
    line.style.width = ''
  } else {
    line.classList.remove('is-into')
    line.style.height = ''
    const gapTop = parseFloat(getComputedStyle(target).marginTop) || 0
    const gapBottom = parseFloat(getComputedStyle(target).marginBottom) || 0
    line.style.top = position === 'before'
      ? `${topBase - gapTop / 2}px`
      : `${topBase + blockRect.height + gapBottom / 2}px`
    // 线的横向范围 = 块的内容宽（不盖把手沟槽），左右各出 8px 翘头
    line.style.left = `${leftBase + 34}px`
    line.style.width = `${blockRect.width - 34 - 10 + 16}px`
  }
}
