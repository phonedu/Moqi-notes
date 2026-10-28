import assert from 'node:assert/strict'
import test from 'node:test'
import { decideNameRowCross, decideNameRowEdge } from '@moqi/editor'

/**
 * 名字行的两个**判据**（纯函数，动作与注册见 `src/editor/nameLine.ts`）。
 *
 * 2026-10-05 随名字行收口（T5）从 `editorKeys.test.ts` 迁来这里——模块换了家，判据一字未改
 * （这次搬家是纯搬家：行为零变化，由 `pnpm accept` 的 `PAGENAME-*` 四十来项锁住）。
 */

test('BLOCK-LINE-8 名字行与第一个子块那处接缝：只认「整行边界」（R04-NAME-12）', () => {
  const base = { atFirstChildStart: false, atNameRowEnd: false, atNameRowEmpty: false, composing: false }
  // 往上一行（Backspace / ←）：只在第一个子块行首
  assert.equal(decideNameRowCross({ ...base, backward: true, atFirstChildStart: true }), true)
  assert.equal(decideNameRowCross({ ...base, backward: true, atNameRowEnd: true }), false, '名字行末尾按 ← 不上翻（那是行内移动）')
  // D-097：空名字行上的 Backspace / ← 是**页面边界**——接管（吃掉事件、原地不动），
  // 不让给 Lexical 默认（默认会删行盒持有者、把光标 normalize 进正文，观感如按了 Enter）。
  assert.equal(decideNameRowCross({ ...base, backward: true, atNameRowEmpty: true }), true)
  assert.equal(decideNameRowCross({ ...base, backward: true, atNameRowEmpty: true, composing: true }), false)
  // 往下一行（Delete / →）：只在名字行末尾
  assert.equal(decideNameRowCross({ ...base, backward: false, atNameRowEnd: true }), true)
  assert.equal(decideNameRowCross({ ...base, backward: false, atFirstChildStart: true }), false, '块首按 → 是行内移动')
  // 块中间、输入法组合态：让给浏览器 / Lexical 的原生行为
  assert.equal(decideNameRowCross({ ...base, backward: true }), false)
  assert.equal(decideNameRowCross({ ...base, backward: false }), false)
  assert.equal(decideNameRowCross({ ...base, backward: true, atFirstChildStart: true, composing: true }), false)
  assert.equal(decideNameRowCross({ ...base, backward: false, atNameRowEnd: true, composing: true }), false)
})

test('BLOCK-LINE-9 名字行的 Home / End：光标在这一行时才接管（锚点会让 Lexical 把行尾算到锚点之后）', () => {
  assert.equal(decideNameRowEdge({ onNameRow: true, composing: false }), true)
  assert.equal(decideNameRowEdge({ onNameRow: false, composing: false }), false, '不在名字行：Home / End 走原生')
  assert.equal(decideNameRowEdge({ onNameRow: true, composing: true }), false, '输入法组合态不抢键')
})
