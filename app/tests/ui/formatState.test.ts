import assert from 'node:assert/strict'
import test from 'node:test'
import { EDITOR_FORMATS, formatsOf } from '@moqi/editor'

/** 用假选区模拟 Lexical 的选择：`hasFormat` 就是它的公开读取口（折叠光标上读的是「待输入格式」）。 */
function selection(active: string[]) {
  return { hasFormat: (format: string) => active.includes(format) }
}

test('按下态读取：选区（含折叠光标上的待输入格式）里开着的格式', () => {
  assert.deepEqual(formatsOf(selection(['bold', 'highlight'])), ['bold', 'highlight'])
  // 折叠光标上待输入的格式同样能读出来——顶部格式栏就是靠它显示「接下来输入的字是加粗」
  assert.deepEqual(formatsOf(selection(['bold'])), ['bold'])
  assert.deepEqual(formatsOf(selection([])), [])
  assert.deepEqual(formatsOf(null), [])
})

test('按下态顺序固定，与规范里的五位格式顺序一致', () => {
  assert.deepEqual(formatsOf(selection(['highlight', 'code', 'bold'])), ['bold', 'code', 'highlight'])
})

test('三层工具栏共用的格式集合固定为六种（加粗 / 斜体 / 下划线 / 删除线 / 行内代码 / 高亮；下划线 2026-10-06 补）', () => {
  assert.deepEqual(EDITOR_FORMATS, ['bold', 'italic', 'underline', 'strikethrough', 'code', 'highlight'])
})
