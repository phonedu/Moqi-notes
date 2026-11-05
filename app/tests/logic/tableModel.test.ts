import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cellOf, deleteColumn, deleteRow, insertColumn, insertRow, mergeCells, parseTable, serializeTable, setCell,
  setColumnAlign, setColumnWidth, unmergeCells,
} from '@moqi/editor'
import { parseMarkdownDocument } from '@moqi/editor'

/**
 * 富表格的模型层：Markdown 管道表 ⇄ 网格。
 * 这里钉四件事：解析（含对齐 / 无外管道 / 转义竖线）、规范序列化、行列增删与对齐操作、
 * 以及**「解析→序列化→再解析」稳定**（编辑后的文本仍能被自己读懂）。
 */

const SAMPLE = ['| 名字 | 数量 |', '| :--- | ---: |', '| 苹果 | 3 |', '| 梨 | 12 |'].join('\n')

test('解析：表头 / 数据行 / 对齐', () => {
  const model = parseTable(SAMPLE)
  assert.ok(model)
  assert.deepEqual(model!.header, ['名字', '数量'])
  assert.deepEqual(model!.rows, [['苹果', '3'], ['梨', '12']])
  assert.deepEqual(model!.align, ['left', 'right'])
})

test('解析：无外层管道的写法也认；转义竖线在单元格里还原', () => {
  // 单元格里写 `\|` = 一个字面竖线（GFM 的转义口径）
  const model = parseTable('a | b\n--- | ---\nx \\| y | z')
  assert.ok(model)
  assert.deepEqual(model!.header, ['a', 'b'])
  assert.deepEqual(model!.rows, [['x | y', 'z']])
})

test('解析：缺分隔行 / 列数不匹配 → null（不是表格）', () => {
  assert.equal(parseTable('| a | b |\n| c | d |'), null)
  assert.equal(parseTable('| a | b |\n| --- |'), null)
  assert.equal(parseTable(''), null)
})

test('序列化：规范形态，且「解析→序列化→再解析」稳定', () => {
  const model = parseTable(SAMPLE)!
  const text = serializeTable(model)
  assert.equal(text, SAMPLE)
  assert.deepEqual(parseTable(text), model)
})

test('单元格与行列：改值 / 插删行列 / 对齐（越界与最后一列有守卫）', () => {
  let model = parseTable(SAMPLE)!
  model = setCell(model, 0, 0, '品名')
  assert.equal(cellOf(model, 0, 0), '品名')
  model = setCell(model, 2, 1, '20')
  assert.equal(cellOf(model, 2, 1), '20')

  model = insertRow(model, 1)
  assert.equal(model.rows.length, 3)
  assert.deepEqual(model.rows[1], ['', ''])

  model = insertColumn(model, 1)
  assert.equal(model.header.length, 3)
  assert.equal(model.rows.every((cells) => cells.length === 3), true)

  model = deleteColumn(model, 1)
  assert.equal(model.header.length, 2)

  model = deleteRow(model, 0)
  assert.equal(model.rows.length, 2)

  const single = parseTable('| a |\n| --- |')!
  assert.equal(deleteColumn(single, 0).header.length, 1, '最后一列不允许删')

  model = setColumnAlign(model, 1, 'center')
  assert.equal(model.align[1], 'center')
  assert.match(serializeTable(model), /\| :---: \|/)
})

test('合并与列宽：走旁注往返（表格本体仍是标准 GFM 表）', () => {
  let model = parseTable(SAMPLE)!
  model = mergeCells(model, 0, 0, 0, 1)
  assert.deepEqual(model.merges, [{ row: 0, col: 0, rowSpan: 1, colSpan: 2 }])
  model = setColumnWidth(model, 0, 120)

  const text = serializeTable(model)
  assert.match(text, /^%% moqi-table: /m, '旁注行在表外')
  assert.match(text.split('\n')[0], /^\| 名字 \| 数量 \|$/, '表格本体不变')

  const back = parseTable(text)!
  assert.deepEqual(back.merges, model.merges)
  assert.deepEqual(back.widths, [120, 0])
  assert.deepEqual(back.rows, model.rows)

  // 拆掉合并后旁注宽度仍在
  const unmerged = unmergeCells(back, 0, 1)
  assert.deepEqual(unmerged.merges, [])
  assert.match(serializeTable(unmerged), /moqi-table/)
})

test('合并块随行列增删平移 / 长高 / 收缩', () => {
  // 数据两行（表头下的 row 1..2）第一列合并
  let model = mergeCells(parseTable(SAMPLE)!, 1, 0, 2, 0)
  assert.deepEqual(model.merges, [{ row: 1, col: 0, rowSpan: 2, colSpan: 1 }])

  // 插在合并块内部（表行 2）→ 长高，起点不变
  model = insertRow(model, 1)
  assert.deepEqual(model.merges, [{ row: 1, col: 0, rowSpan: 3, colSpan: 1 }])

  // 插在合并块之前（表行 1）→ 起点下移
  model = insertRow(model, 0)
  assert.deepEqual(model.merges, [{ row: 2, col: 0, rowSpan: 3, colSpan: 1 }])

  // 删掉合并块内部一行（表行 3）→ 收缩
  model = deleteRow(model, 2)
  assert.deepEqual(model.merges, [{ row: 2, col: 0, rowSpan: 2, colSpan: 1 }])

  // 删掉合并起点那一行 → 起点上移、高度减一
  model = deleteRow(model, 1)
  assert.deepEqual(model.merges, [{ row: 1, col: 0, rowSpan: 1, colSpan: 1 }])

  // 单格合并退化为「没有合并」
  const single = mergeCells(parseTable(SAMPLE)!, 0, 0, 0, 0)
  assert.deepEqual(single.merges, [])

  // 删掉合并所在列 → 合并消失
  const merged = mergeCells(parseTable(SAMPLE)!, 1, 0, 2, 0)
  assert.deepEqual(deleteColumn(merged, 0).merges, [])
})

test('没有合并/列宽时序列化不带旁注（语料逐字节通道不受影响）', () => {
  const text = serializeTable(parseTable(SAMPLE)!)
  assert.equal(text, SAMPLE)
  assert.doesNotMatch(text, /moqi-table/)
})

test('导入：表格后的旁注行收进同一个 table 块（否则往返会被拆成独立块）', () => {
  const doc = parseMarkdownDocument([
    '| a | b |', '| --- | --- |', '| 1 | 2 |',
    '%% moqi-table: {"merges":[[0,0,1,2]],"widths":[120,0]} %%',
    '', '正文段落',
  ].join('\n'))
  const table = doc.roots.find((draft) => draft.type === 'table')
  assert.ok(table, '表格块在')
  assert.match(table!.text, /moqi-table/)
  assert.ok(doc.roots.some((draft) => draft.type === 'text' && draft.text === '正文段落'), '旁注不吃掉后面的正文')
})
