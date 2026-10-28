import assert from 'node:assert/strict'
import test from 'node:test'
import { acceptsBlockKeys, selectionKindOf } from '../../src/ui/selectionModel'

/**
 * 「现在选的是什么」的语义（T7 收口）：文字选区 > 块选中 > 无；块级按键的接管判据。
 * 消费点：编辑器外壳的块级键盘（⌘C / ⌘X / ⌫，`R09-KEY-21/22`）；0.6.0 触控会加第三种来源。
 */

test('SELECT-12 选择语义：文字选区 > 块选中 > 无（平台惯例：有文字选区时 ⌘C/⌘X 是文字的事）', () => {
  assert.equal(selectionKindOf({ textSelected: true, blockCount: 2 }), 'text', '两者同时成立时文字优先')
  assert.equal(selectionKindOf({ textSelected: true, blockCount: 0 }), 'text')
  assert.equal(selectionKindOf({ textSelected: false, blockCount: 3 }), 'blocks', '跨块范围也算块选中')
  assert.equal(selectionKindOf({ textSelected: false, blockCount: 1 }), 'blocks')
  assert.equal(selectionKindOf({ textSelected: false, blockCount: 0 }), 'none')
})

test('SELECT-12 块级按键的接管判据：只有纯块选中、且不在表单控件里、且非输入法组合态', () => {
  const base = { kind: 'blocks' as const, inFormField: false, composing: false }
  assert.equal(acceptsBlockKeys(base), true)
  assert.equal(acceptsBlockKeys({ ...base, kind: 'text' }), false, '文字选区：让给内核与平台')
  assert.equal(acceptsBlockKeys({ ...base, kind: 'none' }), false, '没选什么：不接管')
  assert.equal(acceptsBlockKeys({ ...base, inFormField: true }), false, '焦点在输入框：⌘C 是输入内容自己的事')
  assert.equal(acceptsBlockKeys({ ...base, composing: true }), false, '输入法组合态：不抢键')
})
