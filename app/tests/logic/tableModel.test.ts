import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cellOf, deleteColumn, deleteRow, insertColumn, insertRow, parseTable, serializeTable, setCell, setColumnAlign,
} from '@moqi/editor'

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
