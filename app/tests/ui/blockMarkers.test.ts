import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MARKER_GEOMETRY,
  hoveredIdFromPointer,
  listOrdinal,
  markerBoxStyle,
  markerHitOverlaps,
  markerHitSize,
  markerHitSpan,
  markerOverlaps,
  markerPlacement,
  ownLineCenter,
  markerSpan,
  markersForBlock,
  type MarkerInput,
  type MarkerKind,
} from '@moqi/editor'

const KINDS: MarkerKind[] = ['handle', 'plus', 'collapse', 'check']
/** 左侧标记（左锚点）：它们共享块左边缘的同一段空间。 */
const LEFT_KINDS: MarkerKind[] = ['collapse', 'handle', 'check']
/** 测试用的块宽：正文块实际宽度远大于这个值，这里取一个保守下限。 */
const BLOCK_WIDTH = 320

function input(patch: Partial<MarkerInput> = {}): MarkerInput {
  return { type: 'text', isObject: false, hasChildBlocks: false, collapsed: false, hovered: false, selected: false, ...patch }
}

test('W2 触屏档：标记集只留折叠箭头 + 待办圈（把手 / ＋ 是 hover 桌面件不上手机）；折叠箭头几何走 30px 沟槽', () => {
  assert.deepEqual(markersForBlock(input({ type: 'text', hasChildBlocks: true, hovered: true, compact: true })), ['collapse'])
  assert.deepEqual(markersForBlock(input({ type: 'todo', hovered: true, compact: true })), ['check'])
  assert.deepEqual(markersForBlock(input({ type: 'text', hasChildBlocks: false, hovered: true, selected: true, compact: true })), [])
  assert.deepEqual(markersForBlock(input({ type: 'text', hasChildBlocks: true, collapsed: true, compact: true })), ['collapse'])
  // 几何：视觉盒落沟槽（-26..-4），命中宽 30（`10` §1.2 的唯一例外项：受 30px 沟槽限宽）
  assert.deepEqual(markerSpan('collapse', BLOCK_WIDTH, true), [-26, -4])
  const hit = markerHitSpan('collapse', BLOCK_WIDTH, true)
  assert.equal(hit[1] - hit[0], 30)
  assert.deepEqual(markerPlacement('collapse', { left: 34, right: 354 }, 100, true).left, 8)
})
test('空页面：页面对象块（容器）不出现任何块级标记', () => {
  // 空页面的真实结构是「页面对象块 + 一个空文本子块」，容器过去被当成普通块而出现折叠控件。
  assert.deepEqual(markersForBlock(input({ isObject: true, hasChildBlocks: true })), [])
  assert.deepEqual(markersForBlock(input({ isObject: true, hasChildBlocks: true, hovered: true, selected: true })), [])
})

test('折叠箭头属于**所有有子块的块**（不限标题，`R09-BLOCK-7` 2026-10-10 裁决），且必须真的有子块', () => {
  // 有子块 + hover（或收起态）= 出箭头；类型不参与判定。
  for (const type of ['heading1', 'heading2', 'text', 'bullet', 'numbered', 'todo', 'quote', 'code'] as const) {
    assert.ok(markersForBlock(input({ type, hasChildBlocks: true, hovered: true })).includes('collapse'), `${type} 有子块就该有折叠箭头`)
  }
  // 没有子块：谁都不出箭头（标题也一样）。
  for (const type of ['heading1', 'text', 'bullet'] as const) {
    assert.ok(!markersForBlock(input({ type, hovered: true })).includes('collapse'), `${type} 没有子块不该有折叠箭头`)
  }
  assert.deepEqual(markersForBlock(input({ type: 'heading1', hasChildBlocks: true, hovered: true })), ['collapse', 'handle', 'plus'])
  assert.deepEqual(markersForBlock(input({ type: 'bullet', hasChildBlocks: true, hovered: true })), ['collapse', 'handle', 'plus'])
  // 收起状态下箭头必须常驻，否则收起后无法展开（非标题块同样）。
  assert.ok(markersForBlock(input({ type: 'heading2', hasChildBlocks: true, collapsed: true })).includes('collapse'))
  assert.ok(markersForBlock(input({ type: 'text', hasChildBlocks: true, collapsed: true })).includes('collapse'))
})

test('待办复选框常驻，不依赖 hover；其他类型没有复选框', () => {
  assert.ok(markersForBlock(input({ type: 'todo' })).includes('check'))
  assert.deepEqual(markersForBlock(input({ type: 'todo' })), ['check'])
  assert.ok(!markersForBlock(input({ type: 'text', hovered: true })).includes('check'))
})

test('把手 hover 或选中时出现；行尾 ＋ 只在 hover 时出现', () => {
  assert.deepEqual(markersForBlock(input()), [])
  assert.deepEqual(markersForBlock(input({ selected: true })), ['handle'])
  assert.deepEqual(markersForBlock(input({ hovered: true })), ['handle', 'plus'])
})

test('看得见的标记互不重叠，把手不会和折叠箭头叠在同一排', () => {
  for (const a of LEFT_KINDS) {
    for (const b of LEFT_KINDS) {
      if (a === b) continue
      assert.equal(markerOverlaps(a, b, BLOCK_WIDTH), false, `${a} 与 ${b} 的视觉盒不能重叠`)
    }
  }
  for (const kind of KINDS) {
    if (kind === 'plus') continue
    assert.equal(markerOverlaps(kind, 'plus', BLOCK_WIDTH), false, `${kind} 与行尾 ＋ 的视觉盒不能重叠`)
  }
  // 具体数值锁定：把手 −22..0，折叠箭头在它左边 −44..−22，复选框在块左内边距里 10..26。
  assert.deepEqual(markerSpan('handle', BLOCK_WIDTH), [-22, 0])
  assert.deepEqual(markerSpan('collapse', BLOCK_WIDTH), [-44, -22])
  assert.deepEqual(markerSpan('check', BLOCK_WIDTH), [10, 26])
})

test('相邻标记的点击区不互相覆盖，否则把手会吃掉折叠箭头的命中', () => {
  for (const a of LEFT_KINDS) {
    for (const b of LEFT_KINDS) {
      if (a === b) continue
      assert.equal(markerHitOverlaps(a, b, BLOCK_WIDTH), false, `${a} 与 ${b} 的点击区不能重叠`)
    }
  }
  for (const kind of KINDS) {
    if (kind === 'plus') continue
    assert.equal(markerHitOverlaps(kind, 'plus', BLOCK_WIDTH), false, `${kind} 与行尾 ＋ 的点击区不能重叠`)
  }
})

test('点击目标按 docs/04 §7 放大到桌面可用尺寸', () => {
  for (const kind of KINDS) {
    const { width, height } = markerHitSize(kind)
    assert.ok(height >= 32, `${kind} 的点击区高度 ${height} 不足 32px`)
    // 复选框左右是块左内边距与把手，只能往右扩：24×32（视觉仍是原型的 16px 方框）。
    if (kind === 'check') assert.equal(width, 24)
    else assert.ok(width >= 32, `${kind} 的点击区宽度 ${width} 不足 32px`)
  }
  assert.deepEqual(markerHitSize('check'), { width: 24, height: 32 })
})

test('装饰层的内联几何与规则表一致（CSS 与规则不漂移）', () => {
  for (const kind of KINDS) {
    const box = markerBoxStyle(kind)
    assert.equal(box.width, MARKER_GEOMETRY[kind].width)
    assert.equal(box.height, MARKER_GEOMETRY[kind].height)
    const [top, right, bottom, left] = MARKER_GEOMETRY[kind].hit
    assert.equal(box.hit, `${-top}px ${-right}px ${-bottom}px ${-left}px`)
  }
  assert.deepEqual(markerHitSpan('handle', BLOCK_WIDTH), [-22, 10])
  assert.deepEqual(markerHitSpan('collapse', BLOCK_WIDTH), [-54, -22])
  assert.deepEqual(markerHitSpan('check', BLOCK_WIDTH), [10, 34])
  assert.deepEqual(markerHitSpan('plus', BLOCK_WIDTH), [BLOCK_WIDTH - 35, BLOCK_WIDTH])
})

test('位置由块矩形推出：垂直贴在自己那一行，水平按锚点贴在块外侧', () => {
  const rect = { top: 100, left: 300, right: 980, height: 40 }
  // 单行块：5px 上内边距 + 30px 行高的一半 = 盒子中心（与原型 top:50% 等价）。
  const line = ownLineCenter(30, 5, rect)
  assert.equal(line, 120)
  assert.deepEqual(markerPlacement('handle', rect, line), { top: 104, left: 278 })
  assert.deepEqual(markerPlacement('collapse', rect, line), { top: 104, left: 256 })
  assert.deepEqual(markerPlacement('check', rect, line), { top: 112, left: 310 })
  assert.deepEqual(markerPlacement('plus', rect, line), { top: 104, left: 950 })
})

test('父块的标记贴在自己那一行，不跟着子树盒子的中心跑', () => {
  // 标题带 3 个子块：盒子高 160，行高 34 → 自己那一行的中心在最上面，不是盒子的中心。
  const tall = { top: 200, height: 160 }
  const line = ownLineCenter(34, 5, tall)
  assert.equal(line, 200 + 22)
  assert.equal(line < tall.top + tall.height / 2, true, '不能落在子树中间')
  // 空块（只有 <br>，行高算不出来）退回盒子中心，不会算到块外面去。
  assert.equal(ownLineCenter(Number.NaN, 5, tall), 280)
  // 行高异常大于盒子时也不能越出块边界。
  assert.equal(ownLineCenter(400, 5, { top: 0, height: 40 }), 20)
})

test('悬停归属：指针落在块自己的附属行上时不算离开块', () => {
  // 直接落在块上：跟随指针。
  assert.equal(hoveredIdFromPointer('b1', null, 'b2'), 'b1')
  assert.equal(hoveredIdFromPointer('b1', 'b9', 'b2'), 'b1', '块本身优先于附属行')
  // 落在**当前悬停块**的把手 / AI 行上：保持该块（否则浮层会在鼠标移入时先消失）。
  assert.equal(hoveredIdFromPointer(null, 'b1', 'b1'), 'b1')
  // 落在别的块的附属行上：不是悬停（避免隔空点亮）。
  assert.equal(hoveredIdFromPointer(null, 'b2', 'b1'), null)
  // 落在正文空白 / 面板上：没有悬停块。
  assert.equal(hoveredIdFromPointer(null, null, 'b1'), null)
  assert.equal(hoveredIdFromPointer(null, 'b1', null), null)
})

test('R09-BLOCK-30 编号序号：同级相邻同类型的连续段各自从 1 开始，别的类型打断就归零', () => {
  const run = ['numbered', 'numbered', 'numbered'] as const
  assert.equal(listOrdinal([...run], 0, 'numbered'), 1)
  assert.equal(listOrdinal([...run], 2, 'numbered'), 3)
 // 普通文字 / 其它块类型打断：后一段重新从 1 开始（用户 问的就是这条）
  assert.equal(listOrdinal(['numbered', 'numbered', 'text', 'numbered'], 3, 'numbered'), 1)
  assert.equal(listOrdinal(['numbered', 'bullet', 'numbered', 'numbered'], 3, 'numbered'), 2)
  // 缩进层级各算各的：子项的兄弟列表里只有子项，所以子层从 1 开始（不与父级共用序号）
  assert.equal(listOrdinal(['numbered'], 0, 'numbered'), 1)
  // 不是编号列表：没有序号
  assert.equal(listOrdinal(['bullet', 'bullet'], 1, 'bullet'), null)
  assert.equal(listOrdinal(['numbered'], 0, 'text'), null)
  assert.equal(listOrdinal(['numbered'], 5, 'numbered'), null, '越界不猜')
})
