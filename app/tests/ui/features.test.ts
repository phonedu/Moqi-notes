import assert from 'node:assert/strict'
import test from 'node:test'
import { ALL_FEATURES_OFF, ALL_FEATURES_ON, resolveFeatures } from '@moqi/editor'
import { AVAILABLE_INSERT_ITEMS, INSERT_ITEMS, MEDIA_INSERT_KINDS, insertItemsForMedia } from '../../src/ui/menuItems'
import { filterItems, slashItems } from '../../src/ui/SlashMenu'

/**
 * M5 可选能力（`编辑器模块化（已归档）`）：判据只住在包（`editor/features.ts`）与单一数据源
 * （`menuItems.ts`），各入口（＋插入 ▾ / 斜杠 / 移动面板 / 飞条 / 顶栏 ✦ / 搜索问 AI）消费同一份。
 * 这里钉住三件事：缺省全关、显式覆盖、媒体项从所有插入入口一起消失。
 */

test('features 判据：缺省全关；显式给的开；ALL_FEATURES_ON 是全开常量', () => {
  assert.deepEqual(resolveFeatures(), ALL_FEATURES_OFF)
  assert.deepEqual(resolveFeatures({}), ALL_FEATURES_OFF)
  assert.deepEqual(resolveFeatures({ ai: true }), { ai: true, media: false, backlinks: false, properties: false })
  assert.deepEqual(ALL_FEATURES_ON, { ai: true, media: true, backlinks: true, properties: true })
})

test('媒体项判据：media 关闭时图片 / 附件 / 嵌入从插入清单消失，其余不动', () => {
  const off = insertItemsForMedia(INSERT_ITEMS, false)
  assert.deepEqual(off.map((item) => item.kind).filter((kind) => MEDIA_INSERT_KINDS.has(kind)), [])
  assert.ok(off.length > 0, '待办 / 引用 / 代码等非媒体项保留')
  assert.deepEqual(insertItemsForMedia(INSERT_ITEMS, true), INSERT_ITEMS)
  // 斜杠菜单与 ＋插入 ▾ 同源（AVAILABLE_INSERT_ITEMS）——同一判据过滤
  const offAvailable = insertItemsForMedia(AVAILABLE_INSERT_ITEMS, false)
  assert.deepEqual(offAvailable.map((item) => item.kind).filter((kind) => MEDIA_INSERT_KINDS.has(kind)), [])
})

test('斜杠菜单：media 关闭时「插入」组不出图片块 / 附件块 / 嵌入块，行内与格式项照旧', () => {
  const off = filterItems('', false)
  const labels = off.map((item) => item.label)
  assert.ok(!labels.includes('图片块') && !labels.includes('附件块') && !labels.includes('嵌入块'))
  assert.ok(labels.includes('待办') && labels.includes('加粗') && labels.includes('页面链接'))
  // 开着时三项都在（与 slashItems 全量一致）
  const on = filterItems('', true)
  assert.equal(on.length, slashItems.length)
  assert.ok(on.some((item) => item.label === '图片块'))
})
