import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { EDITOR_THEME } from '@moqi/editor'

/**
 * 行内格式的类名契约（docs/09 §6.10）：Lexical 一个文本节点只渲染一个标签，
 * 多出来的格式（斜体、删除线、与加粗同时存在的高亮等）只能靠主题类表达。
 * 主题里写了类名、CSS 里没有对应规则，就会出现「格式加上了但屏幕上没变化」。
 */
const css = readFileSync(new URL('../../src/ui/app.css', import.meta.url), 'utf8')

test('FMT-THEME-1 编辑器主题把行内格式映射到 docs/09 §6.10 的类名', () => {
  assert.deepEqual(EDITOR_THEME.text, {
    bold: 'tx-b',
    italic: 'tx-i',
    underline: 'tx-u',
    strikethrough: 'tx-s',
    code: 'tx-c',
    highlight: 'tx-h',
  })
})

test('主题里的每个类名在 app.css 里都有规则（否则格式加了也看不见）', () => {
  const classes = Object.values(EDITOR_THEME.text ?? {}) as string[]
  assert.equal(classes.length, 6)
  for (const className of classes) {
    assert.ok(css.includes(`.${className} `) || css.includes(`.${className}{`) || css.includes(`.${className},`), `app.css 缺少 .${className} 的样式`)
  }
})

test('格式类名带上了规范要求的样式（加粗 700 / 斜体 italic / 删除线 line-through / 代码等宽 / 高亮荧光黄）', () => {
  const rule = (selector: string): string => {
    const at = css.indexOf(selector)
    assert.notEqual(at, -1, `app.css 找不到 ${selector}`)
    return css.slice(at, css.indexOf('}', at))
  }
  assert.match(rule('.tx-b'), /font-weight:\s*700/)
  assert.match(rule('.tx-i'), /font-style:\s*italic/)
  assert.match(rule('.tx-s'), /text-decoration(-line)?:\s*(line-through|underline line-through)/)
  assert.match(rule('.tx-c'), /font-family:\s*var\(--mono\)/)
  assert.match(rule('.tx-h'), /background:/)
})
