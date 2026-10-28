import assert from 'node:assert/strict'
import test from 'node:test'
import { textSelectionRectOf, toolbarPlacement } from '../../src/ui/blockAnchor'

/**
 * 工具栏落点（`R09-BEDIT-1/9`）：文字工具条与块浮动工具条共用同一份数学（T7 后续收口）。
 * 两档的差异是**语义差异**（窄选区居中 / 整行块左对齐），两边的既有行为都钉在这里。
 */
const rect = (top: number, left: number, width = 200, height = 24) => ({ top, left, right: left + width, bottom: top + height, width, height })

test('toolbarPlacement · text 档：居中在选区上方 44px', () => {
  const spot = toolbarPlacement('text', rect(300, 600), { width: 424, viewportWidth: 1280 })
  assert.equal(spot.top, 300 - 44)
  assert.equal(spot.left, 600 + 100 - 212, '按选区中心居中')
})

test('toolbarPlacement · text 档：顶上放不下就翻到下方（bottom + 12）', () => {
  const spot = toolbarPlacement('text', rect(40, 600), { width: 424, viewportWidth: 1280 })
  assert.equal(spot.top, 40 + 24 + 12)
})

test('toolbarPlacement · text 档：左右各 8px 钳进视口', () => {
  assert.equal(toolbarPlacement('text', rect(300, 0), { width: 424, viewportWidth: 1280 }).left, 8)
  assert.equal(toolbarPlacement('text', rect(300, 1200), { width: 424, viewportWidth: 1280 }).left, 1280 - 424 - 8)
})

test('textSelectionRectOf · 三条「工具栏不该出」的守卫（选区缺失 / 收拢 / 在根外 / 退化矩形）', () => {
  const root = { contains: (node: unknown) => node === 'inside' } as unknown as HTMLElement
  const selectionWith = (range: unknown, over: Record<string, unknown> = {}) => ({ rangeCount: 1, isCollapsed: false, getRangeAt: () => range, ...over }) as unknown as Selection
  const goodRange = { startContainer: 'inside', endContainer: 'inside', getBoundingClientRect: () => ({ top: 100, left: 50, right: 70, bottom: 120, width: 20, height: 20 }) }
  assert.equal(textSelectionRectOf(null, selectionWith(goodRange)), null, '没有编辑器根')
  assert.equal(textSelectionRectOf(root, null), null, '没有选区')
  assert.equal(textSelectionRectOf(root, selectionWith(goodRange, { isCollapsed: true })), null, '收拢的选区')
  assert.equal(textSelectionRectOf(root, selectionWith({ ...goodRange, startContainer: 'outside' })), null, '选区在编辑器根外')
  assert.equal(textSelectionRectOf(root, selectionWith({ ...goodRange, getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }) })), null, '退化矩形')
  assert.deepEqual(textSelectionRectOf(root, selectionWith(goodRange)), { top: 100, left: 50, right: 70, bottom: 120, width: 20, height: 20 })
})

test('toolbarPlacement · blocks 档：左缘对齐块、钳 top ≥ 8、**不翻转**', () => {
  const near = toolbarPlacement('blocks', rect(20, 100), { width: 560, viewportWidth: 1280 })
  assert.equal(near.top, 8, '贴顶的块：钳住、不掉到下方（会盖住正在编辑的行）')
  assert.equal(near.left, 100, '左缘对齐块，不居中')
  const wide = toolbarPlacement('blocks', rect(500, 1200), { width: 560, viewportWidth: 1280 })
  assert.equal(wide.top, 500 - 44)
  assert.equal(wide.left, 1280 - 560, '只按浮条宽度从右侧钳回（没有额外的 8px 边距——既有行为）')
})
