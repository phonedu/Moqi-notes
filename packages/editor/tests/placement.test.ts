import assert from 'node:assert/strict'
import test from 'node:test'
import { textSelectionRectOf, toolbarPlacement, type Rect } from '../src/touch/placement'

/** 工具栏落点数学（M7 入包件）：守卫三则 + 两种锚点语义（有意不同，不许顺手对齐）。 */

const root = () => {
  const el = { contains: () => true } as unknown as HTMLElement
  return el
}

const sel = (collapsed: boolean, rect: Partial<DOMRect>): Selection => {
  const r = { width: 8, height: 8, top: 0, left: 0, right: 8, bottom: 8, ...rect } as DOMRect
  return {
    rangeCount: 1, isCollapsed: collapsed,
    getRangeAt: () => ({ getBoundingClientRect: () => r, startContainer: {}, endContainer: {} }),
  } as unknown as Selection
}

test('textSelectionRectOf：缺失 / 收拢 / 退化矩形一律不出（null）', () => {
  assert.equal(textSelectionRectOf(null, sel(false, {})), null)
  assert.equal(textSelectionRectOf(root(), null), null)
  assert.equal(textSelectionRectOf(root(), sel(true, {})), null)
  assert.equal(textSelectionRectOf(root(), sel(false, { width: 0, height: 0 })), null)
})

test('textSelectionRectOf：正常选区返回视口窄矩形', () => {
  const r = textSelectionRectOf(root(), sel(false, { top: 40, left: 10, right: 110, width: 100, height: 20, bottom: 60 }))
  assert.ok(r)
  assert.equal(r.width, 100)
  assert.equal(r.top, 40)
})

test('toolbarPlacement：text 居中钳边、顶放不下翻下方；blocks 左缘对齐恒贴上方', () => {
  const anchor: Rect = { top: 100, left: 50, right: 150, bottom: 140, width: 100, height: 40 }
  const text = toolbarPlacement('text', anchor, { width: 200, viewportWidth: 360 })
  // 中心 100 − 200/2 = 0 → 钳到 8；top = 100 − 44
  assert.equal(text.left, 8)
  assert.equal(text.top, 56)
  const flip = toolbarPlacement('text', { ...anchor, top: 30, bottom: 70 }, { width: 200, viewportWidth: 360 })
  assert.equal(flip.top, 82, '翻到下方 = bottom + 12')
  const blocks = toolbarPlacement('blocks', anchor, { width: 200, viewportWidth: 360 })
  assert.equal(blocks.left, 50, 'blocks 左缘对齐（只钳右不居中）')
  assert.equal(blocks.top, 56, 'blocks 恒贴上方不翻')
})
