import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_TABLE_MARKDOWN, createTextBlock, isTablePayload, mergeCells, normalizeBlock,
  setColumnWidth, tablePayloadAfterEdit, tablePayloadFromText, tablePayloadToModel,
  tablePayloadToText,
} from '@moqi/editor'

/**
 * 表格 data-first 试点（试验件）：payload 是网格态，`source` 保留导入原文。
 * 这里钉四件事：原文逐字节、编辑后清 source、JSON 可往返、坏 payload 不入口。
 */

const SAMPLE = ['| 名字 | 数量 |', '| :--- | ---: |', '| 苹果 | 3 |', '| 梨 | 12 |'].join('\n')

test('原文逐字节：source 在，导出就是导入的那份', () => {
  for (const text of [DEFAULT_TABLE_MARKDOWN, SAMPLE, '|a|b|\n|---|---|\n|1|2|']) {
    const payload = tablePayloadFromText(text)
    assert.ok(payload, text)
    assert.equal(tablePayloadToText(payload), text)
  }
})

test('不是合法管道表 → null（文本照旧）', () => {
  assert.equal(tablePayloadFromText('| a | b |\n| c | d |'), null)
  assert.equal(tablePayloadFromText(''), null)
})

test('结构编辑清掉 source：合并/列宽写进规范投影，再解析回来还在', () => {
  const payload = tablePayloadFromText(SAMPLE)
  assert.ok(payload)
  const merged = mergeCells(tablePayloadToModel(payload), 1, 0, 1, 1)
  const edited = tablePayloadAfterEdit(setColumnWidth(merged, 0, 120))
  assert.equal(edited.source, undefined, '编辑后不再保留原文')
  const text = tablePayloadToText(edited)
  assert.match(text, /moqi-table/)
  const back = tablePayloadFromText(text)
  assert.ok(back)
  assert.deepEqual(back.merges, edited.merges)
  assert.deepEqual(back.widths, edited.widths)
})

test('JSON 往返后仍是合法 payload', () => {
  const payload = tablePayloadFromText(SAMPLE)
  assert.ok(payload)
  const round = JSON.parse(JSON.stringify(payload)) as unknown
  assert.equal(isTablePayload(round), true)
  assert.deepEqual(tablePayloadToModel(round as typeof payload), tablePayloadToModel(payload))
})

test('坏 payload 不入口：版本 / 表头 / 行 / 对齐 / 合并 / 列宽 / source', () => {
  const good = tablePayloadFromText(SAMPLE)
  assert.ok(good)
  const cases: unknown[] = [
    null,
    {},
    { ...good, version: 2 },
    { ...good, header: [] },
    { ...good, align: ['justify'] },
    { ...good, merges: [{ row: '0', col: 0, rowSpan: 1, colSpan: 1 }] },
    { ...good, widths: [Number.NaN] },
    { ...good, source: 42 },
  ]
  for (const value of cases) assert.equal(isTablePayload(value), false, JSON.stringify(value))
})

test('短行 / 短对齐在转网格时补齐，不越界', () => {
  const payload = tablePayloadFromText('| a | b | c |\n| --- | --- | --- |\n| 1 |')
  assert.ok(payload)
  const model = tablePayloadToModel({ ...payload, rows: [['1']], align: [], widths: [] })
  assert.deepEqual(model.rows, [['1', '', '']])
  assert.deepEqual(model.align, [null, null, null])
  assert.deepEqual(model.widths, [0, 0, 0])
})

const MERGED = `${SAMPLE}\n%% moqi-table: {"merges":[[1,0,1,2]]} %%`

test('载入迁移：旧表格块按正文补 payload（含旁注）', () => {
  const legacy = createTextBlock({ entityId: 't1', blockUid: 'bu1', text: MERGED })
  legacy.type = 'table'
  const normalized = normalizeBlock(legacy)
  assert.ok(normalized.table)
  assert.equal(tablePayloadToText(normalized.table), MERGED)
  assert.deepEqual(normalized.table.merges, [{ row: 1, col: 0, rowSpan: 1, colSpan: 2 }])
})

test('载入迁移：payload 与正文不一致 → 以正文为准', () => {
  const block = createTextBlock({ entityId: 't2', blockUid: 'bu2', text: SAMPLE })
  block.type = 'table'
  block.table = tablePayloadFromText('| x |\n| --- |\n| 1 |')
  const normalized = normalizeBlock(block)
  assert.ok(normalized.table)
  assert.equal(tablePayloadToText(normalized.table), SAMPLE)
  assert.deepEqual(normalized.table.header, ['名字', '数量'])
})

test('载入迁移：非表格块上的 payload 清掉', () => {
  const block = createTextBlock({ entityId: 't3', blockUid: 'bu3', text: '正文' })
  const payload = tablePayloadFromText(SAMPLE)
  assert.ok(payload)
  block.table = payload
  normalizeBlock(block)
  assert.equal(block.table, null)
})
