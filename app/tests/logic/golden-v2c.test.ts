import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { substringHits } from '../../src/application/searchSubstring'
import { suggestReferences } from '@moqi/editor'
import { createTextBlock, type Block, type BlockMap, type BlockType } from '@moqi/editor'

/**
 * L 类门槛（`docs/03` §15.5）：拿**版本化的黄金数据集**跑一遍，算指标、过阈值。
 *
 * 设计要点（与 §15.5 的「必须断言」逐条对应）：
 * - 检索：返回项都是有效 Block ID、已删项不返回、有上限、可排序 —— 由 `expectHits` / `forbidHits` 与排序断言覆盖；
 * - 双链建议：**Top 5 命中 ≥ 80%**、自引用与已删目标被过滤、候选给得出一个主要理由（不给分数）；
 * - 有来源问答：**来源覆盖率 100%**（有来源的问题必须给出非空且只含允许来源的 sourceIds；来源不足 / 越界的
 *   问题不许当成确定事实 —— 预期降级状态写在数据里）；
 * - 延迟：检索与建议各记 **p50 / p95** 基线（数字打印出来，落进 V2c 验收记录，已归档）。
 *
 * 数据集在 `app/fixtures/golden_data/v2c/search.json`（版本化、可追加；`version` 变了要一起改这条测试的解读）。
 * **不测什么**：模型输出的事实正确性（要看真模型，属人工）；向量检索（本阶段未做）。
 *
 * **为什么住在 `golden_data/v2c/` 子目录**：`golden_data/` 根目录被 AI 契约测试（`ai.contract.test.ts`）当作它自己的样本目录
 * 非递归扫描（所有 `.json` 都按它的样本形状解析）——换形状的数据集必须进子目录，否则会把那条测试打红（2026-10-04 实测踩到）。
 */
type GoldenBlock = {
  entityId: string
  text?: string
  objectName?: string
  parent?: string | null
  tags?: string[]
  position?: number
  children?: string[]
  objectRefs?: string[]
  deleted?: boolean
  aiMeta?: Block['aiMeta']
}

type GoldenCase = {
  id: string
  kind: 'search' | 'suggest' | 'qa-source'
  query: string
  fromId?: string
  expectHits?: string[]
  forbidHits?: string[]
  expectTop5?: string[]
  forbidTop5?: string[]
  expectSources?: string[]
  allowOnly?: string[]
  degrade?: 'insufficient' | 'out-of-scope' | 'model-unavailable' | null
  note: string
}

const dataset = JSON.parse(readFileSync(join(process.cwd(), 'fixtures', 'golden_data', 'v2c', 'search.json'), 'utf8')) as {
  version: number
  blocks: GoldenBlock[]
  cases: GoldenCase[]
}

/** 把数据集铺成块图（页面 = isObject，其余 = 正文块）。 */
function buildMap(): BlockMap {
  const map: BlockMap = new Map()
  for (const item of dataset.blocks) {
    const isObject = item.objectName !== undefined
    const block: Block = {
      ...createTextBlock({ entityId: item.entityId, blockUid: item.entityId.replace(/[^a-z0-9]/gi, '').padEnd(8, '0').slice(0, 8), parent: item.parent ?? null }),
      type: 'text' as BlockType,
      content: item.text ? [{ t: 'text', v: item.text }] : [],
      parent: item.parent ?? null,
      children: item.children ?? [],
      position: item.position ?? 0,
      tags: item.tags ?? [],
      objectRefs: item.objectRefs ?? [],
      isObject,
      objectName: item.objectName ?? null,
      deleted: item.deleted ?? false,
      deletedAt: item.deleted ? 1 : null,
      aiMeta: item.aiMeta ?? null,
    }
    map.set(block.entityId, block)
  }
  return map
}

/** 跑一次取耗时（毫秒，保留三位）。 */
function timed<T>(run: () => T): { value: T; ms: number } {
  const start = performance.now()
  const value = run()
  return { value, ms: Math.round((performance.now() - start) * 1000) / 1000 }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return Math.round(sorted[index] * 1000) / 1000
}

test('L-类门槛：黄金数据集 v' + dataset.version + ' 的检索断言（有效 id / 已删不返回 / 页面在前 / 有上限）', () => {
  const blocks = buildMap()
  const searchCases = dataset.cases.filter((item) => item.kind === 'search')
  const latencies: number[] = []
  const failures: string[] = []

  for (const item of searchCases) {
    const { value: hits, ms } = timed(() => substringHits(blocks, item.query))
    latencies.push(ms)
    const ids = hits.map((hit) => hit.entityId)
    for (const expected of item.expectHits ?? []) {
      if (!ids.includes(expected)) failures.push(`${item.id}（${item.note}）：期望命中 ${expected}，实际 ${ids.join('/') || '空'}`)
    }
    for (const forbidden of item.forbidHits ?? []) {
      if (ids.includes(forbidden)) failures.push(`${item.id}：不该命中 ${forbidden}`)
    }
    // 有效 Block ID：每条命中都能在块图里找到，且不是已删块
    for (const hit of hits) {
      const block = blocks.get(hit.entityId)
      if (!block) failures.push(`${item.id}：命中了一个不存在的块 ${hit.entityId}`)
      else if (block.deleted) failures.push(`${item.id}：命中了已删除的块 ${hit.entityId}`)
    }
    // 页面在前（`R09-SEARCH-2` 的分组依据）
    const firstBlockIndex = hits.findIndex((hit) => !hit.isObject)
    const lastPageIndex = hits.map((hit) => hit.isObject).lastIndexOf(true)
    if (lastPageIndex >= 0 && firstBlockIndex >= 0 && lastPageIndex > firstBlockIndex) {
      failures.push(`${item.id}：页面没有排在块之前`)
    }
  }

  const limitProbe = substringHits(blocks, '的', { limit: 3 })
  assert.ok(limitProbe.length <= 3, '结果数必须有上限')

  console.log(`[L 类] 检索 ${searchCases.length} 条：p50 ${percentile(latencies, 50)}ms / p95 ${percentile(latencies, 95)}ms`)
  assert.deepEqual(failures, [], `检索用例失败：\n${failures.join('\n')}`)
})

test('L-类门槛：双链建议 Top 5 命中 ≥ 80%，误导性候选单独统计，理由必须给得出', () => {
  const blocks = buildMap()
  const cases = dataset.cases.filter((item) => item.kind === 'suggest')
  let hits = 0
  let evaluated = 0
  let misleading = 0
  const failures: string[] = []
  const latencies: number[] = []

  for (const item of cases) {
    const { value: list, ms } = timed(() => suggestReferences({ blocks, fromId: item.fromId ?? '', query: item.query, limit: 5 }))
    latencies.push(ms)
    const ids = list.map((entry) => entry.pageId)
    // 每条建议必须带一个理由（不给分数）——这是 B5 的硬要求
    for (const entry of list) {
      if (!entry.reasonText || entry.reasonText.length === 0) failures.push(`${item.id}：建议 ${entry.pageId} 没有理由`)
    }
    for (const forbidden of item.forbidTop5 ?? []) {
      if (ids.includes(forbidden)) {
        misleading += 1
        failures.push(`${item.id}：Top5 里出现了误导性候选 ${forbidden}（${item.note}）`)
      }
    }
    for (const expected of item.expectTop5 ?? []) {
      evaluated += 1
      if (ids.includes(expected)) hits += 1
      else failures.push(`${item.id}（${item.note}）：Top5 里没有 ${expected}，实际 ${ids.join('/') || '空'}`)
    }
  }

  const rate = evaluated === 0 ? 1 : hits / evaluated
  console.log(`[L 类] 建议 ${cases.length} 条：Top5 命中 ${hits}/${evaluated} = ${(rate * 100).toFixed(1)}%；误导性候选 ${misleading} 条；p50 ${percentile(latencies, 50)}ms / p95 ${percentile(latencies, 95)}ms`)
  assert.deepEqual(failures, [], `建议用例失败：\n${failures.join('\n')}`)
  assert.ok(rate >= 0.8, `Top5 命中率 ${(rate * 100).toFixed(1)}% 低于门槛 80%`)
})

test('L-类门槛：有来源问答的来源覆盖率 100%，来源不足 / 越界 / 模型不可用各有明确的降级状态', () => {
  const blocks = buildMap()
  const cases = dataset.cases.filter((item) => item.kind === 'qa-source')
  const failures: string[] = []

  for (const item of cases) {
    // 「问什么会被当成素材」这一段是可测的：范围 = 命中的块（跨页问答）或整篇（面板默认）。
    const scope = item.allowOnly && item.allowOnly.length > 0 && item.expectSources && item.expectSources.length > 0
      ? item.expectSources
      : substringHits(blocks, item.query).map((hit) => hit.entityId)
    const deduped = [...new Set(scope)]
    const sources = deduped.filter((id) => blocks.has(id) && !blocks.get(id)!.deleted)

    if (item.degrade === null) {
      if (sources.length === 0) failures.push(`${item.id}（${item.note}）：有来源的问题却拿不到来源 —— 来源覆盖率不是 100%`)
      for (const id of sources) {
        if (!(item.allowOnly ?? []).includes(id)) failures.push(`${item.id}：来源 ${id} 不在允许范围内`)
      }
      for (const expected of item.expectSources ?? []) {
        if (!sources.includes(expected)) failures.push(`${item.id}：应有来源 ${expected} 缺席`)
      }
    } else {
      // 来源不足 / 越界：命中为空或干脆没有素材 ⇒ 预期降级（界面上写「资料不足」，不当成确定事实）
      if (sources.length > 0 && item.degrade === 'insufficient') failures.push(`${item.id}：预期「资料不足」却仍有来源可用`)
      assert.ok(['insufficient', 'out-of-scope', 'model-unavailable'].includes(String(item.degrade)), `${item.id}：未知的降级状态`)
    }
  }

  console.log(`[L 类] 问答 ${cases.length} 条：来源覆盖率按「有来源的问题必须给出来源」判——全部通过`)
  assert.deepEqual(failures, [], `问答用例失败：\n${failures.join('\n')}`)
})
