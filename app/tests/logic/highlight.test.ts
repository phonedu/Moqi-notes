import assert from 'node:assert/strict'
import test from 'node:test'

import { isHighlightLang, tokenize } from '@moqi/editor'

/**
 * 轻量语法着色（代码块）：纯函数只认四类记号（注释 / 字符串 / 数字 / 关键字），
 * 认不出的语言整段原文。这里钉三件事：**无损拼回**（渲染侧靠它保证不丢字）、
 * 四类记号各取一例、未知语言不猜。
 */

const join = (tokens: { text: string }[]) => tokens.map((token) => token.text).join('')

test('无损：任何输入都能拼回原文（多语言抽样）', () => {
  const samples: [string, string][] = [
    ['typescript', 'const a = `x${1}` // 注释\nfunction f() { return "s" }'],
    ['python', 'def f(x):\n    # 注释\n    return "s" + 12'],
    ['rust', 'fn main() { let s = "hi"; /* 块 */ 3.14 }'],
    ['sql', "SELECT * FROM t -- 注释\nWHERE a = 'x'"],
    ['mermaid', 'graph TD\n%% 注释\nA --> B'],
  ]
  for (const [lang, code] of samples) {
    assert.equal(join(tokenize(code, lang)), code, `${lang} 拼回不一致`)
  }
})

test('四类记号：注释 / 字符串 / 数字 / 关键字各就各位', () => {
  const tokens = tokenize('const n = 42 // hi', 'javascript')
  assert.deepEqual(tokens.map((token) => token.kind), ['keyword', 'plain', 'number', 'plain', 'comment'])
  assert.equal(tokens[0].text, 'const')
  assert.equal(tokens[2].text, '42')
  assert.equal(tokens[4].text, '// hi')
})

test('字符串不跨行（未闭合的引号只吃到行尾，后面的代码还能着色）', () => {
  const tokens = tokenize('"open\nconst x = 1', 'javascript')
  assert.equal(tokens[0].kind, 'string')
  assert.equal(tokens[0].text, '"open')
  assert.ok(tokens.some((token) => token.kind === 'keyword' && token.text === 'const'))
})

test('未知语言 / 空语言：整段原文，不猜', () => {
  assert.deepEqual(tokenize('a = 1', 'brainfuck'), [{ text: 'a = 1', kind: 'plain' }])
  assert.deepEqual(tokenize('a = 1', null), [{ text: 'a = 1', kind: 'plain' }])
  assert.deepEqual(tokenize('', 'javascript'), [])
  assert.equal(isHighlightLang('python'), true)
  assert.equal(isHighlightLang('brainfuck'), false)
  assert.equal(isHighlightLang(null), false)
})
