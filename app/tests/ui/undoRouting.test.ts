import assert from 'node:assert/strict'
import test from 'node:test'
import { ownerOfUpdate, routeRedo, routeUndo } from '../../src/ui/undoRouting'

test('UNDO-ROUTE-1 结构更新归领域，纯输入归 Lexical（docs/04 §5）', () => {
  // 结构 / 类型 / 缩进 / 折叠 / 勾选 / 引用 / 移动 / 插入都带 moqi- 前缀标签
  for (const tag of ['moqi-enter', 'moqi-type', 'moqi-outline', 'moqi-collapse', 'moqi-check', 'moqi-ref', 'moqi-move', 'moqi-insert']) {
    assert.equal(ownerOfUpdate(['historic', tag]), 'domain', `${tag} 必须归领域`)
  }
  // 字符输入不带标签；Lexical 自己的撤销重放只带 historic
  assert.equal(ownerOfUpdate([]), 'typing')
  assert.equal(ownerOfUpdate(['historic']), 'typing')
  // 整篇重载不属于任何一边（重载后的归属由调用方设回领域）
  assert.equal(ownerOfUpdate(['historic', 'moqi-load']), null)
})

test('⌘Z 送给最后那次改动真正的记录者', () => {
  // 刚做过结构操作 → 领域撤销
  assert.equal(routeUndo({ owner: 'domain' }), 'domain')
  // 刚敲完字 → 先让 Lexical 撤（字符级），撤不动才退回领域
  assert.equal(routeUndo({ owner: 'typing' }), 'lexical-then-domain')
})

test('⇧⌘Z 用同一套归属规则', () => {
  assert.equal(routeRedo({ owner: 'domain' }), 'domain')
  assert.equal(routeRedo({ owner: 'typing' }), 'lexical-then-domain')
})

test('UNDO-ROUTE-2 不再依赖 CAN_UNDO / CAN_REDO 查询命令（Lexical 0.51 旧版 HistoryPlugin 不应答它们）', () => {
  // 归属只由 owner 决定：查询命令返回什么都没关系。
  // 曾经的写法 `lexicalCanUndo ? 'lexical' : 'domain'` 会让 ⌘Z 永远走领域，
  // 输入文字后按 ⌘Z 撤不掉字、反倒撤掉更早的结构动作（2026-09-28 用户实测）。
  assert.equal(routeUndo.length, 1, 'routeUndo 只接受 owner 一个入参')
  assert.equal(routeRedo.length, 1, 'routeRedo 只接受 owner 一个入参')
})

test('撤销 / 重做之后归属交还给输入，下一次按键先撤字', async () => {
  const { OWNER_AFTER_HISTORY } = await import('../../src/ui/undoRouting')
  assert.equal(OWNER_AFTER_HISTORY, 'typing')
})
