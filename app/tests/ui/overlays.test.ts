import assert from 'node:assert/strict'
import test from 'node:test'
import { escapeTarget } from '../../src/ui/useOverlays'

const base = { menuOpen: false, dialogOpen: false, focusMode: false, panels: { ai: false, ref: false, brief: false }, touchEditing: false, hasSelection: false }

test('R09-KEY-13 浮层最先退：菜单 / 弹窗开着时 Esc 交给它们自己，不动面板与选区', () => {
  assert.equal(escapeTarget({ ...base, dialogOpen: true, panels: { ...base.panels, ai: true }, hasSelection: true }), 'dialog')
  assert.equal(escapeTarget({ ...base, menuOpen: true, panels: { ...base.panels, ai: true }, hasSelection: true }), 'menu')
})

test('R09-KEY-13 面板顺序：AI → 引用 → 摘要（属性面板已随 2026-10-06 用户裁决取消）', () => {
  const all = { ai: true, ref: true, brief: true }
  assert.equal(escapeTarget({ ...base, panels: all }), 'aiPanel')
  assert.equal(escapeTarget({ ...base, panels: { ...all, ai: false } }), 'refPanel')
  assert.equal(escapeTarget({ ...base, panels: { ai: false, ref: false, brief: true } }), 'brief')
})

test('R09-KEY-13 面板之后才是选区，最后才退专注模式', () => {
  assert.equal(escapeTarget({ ...base, panels: { ...base.panels, brief: true }, hasSelection: true }), 'brief')
  assert.equal(escapeTarget({ ...base, hasSelection: true }), 'selection')
  assert.equal(escapeTarget({ ...base, focusMode: true, hasSelection: true }), 'selection')
  assert.equal(escapeTarget({ ...base, focusMode: true }), 'focus')
  assert.equal(escapeTarget(base), 'none')
})

test('R09-KEY-13 触控编辑态（`10` §6.3）：排在选区之前——一次 Esc 退出整个编辑态（含块选中）', () => {
  assert.equal(escapeTarget({ ...base, touchEditing: true, hasSelection: true }), 'touchEdit')
  assert.equal(escapeTarget({ ...base, panels: { ...base.panels, ai: true }, touchEditing: true }), 'aiPanel', '面板在它上面，仍先退面板')
  assert.equal(escapeTarget({ ...base, dialogOpen: true, touchEditing: true }), 'dialog', '浮层最优先')
})

test('R09-KEY-13 专注模式下侧栏与面板不可见：不能由它们消费 Esc', () => {
  assert.equal(escapeTarget({ ...base, focusMode: true, panels: { ai: true, ref: true, brief: true } }), 'focus')
})
