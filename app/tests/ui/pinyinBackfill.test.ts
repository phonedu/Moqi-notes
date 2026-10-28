import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Block } from '@moqi/editor'
import { backfillPinyinSlices, nextSliceSize, PINYIN_FIRST_SLICE } from '../../src/ui/usePinyinBackfill'

/**
 * `D-042` 的修复判据（行为行 `PERF-PINYIN-1`，`11` §3.23）：
 * 回填按时间预算分片、片间让出空闲——单次主线程占用被压在预算内。
 */
test('PERF-PINYIN-1：分片判据——无读数保守起步 / 有读数按预算反推 / 永不超剩余量', () => {
  assert.equal(nextSliceSize(100, 0, 0, 8), PINYIN_FIRST_SLICE, '没有读数时用保守起步')
  assert.equal(nextSliceSize(10, 0, 0, 8), 10, '剩余量小于起步值时取剩余量')
  assert.equal(nextSliceSize(100, 100, 10, 8), 1, '单块就要 10ms（超预算）→ 至少 1 块，不许返回 0')
  assert.equal(nextSliceSize(100, 8, 100, 8), 100, '单块 0.08ms → 一片可以吃满剩余')
  assert.equal(nextSliceSize(0, 5, 5, 8), 0, '没有剩余 → 0')
})

test('PERF-PINYIN-1：驱动——全量恰好一次、保持原序、片间让出、按读数放大片长', async () => {
  const blocks = Array.from({ length: 100 }, (_, index) => ({ entityId: `b${index}` })) as unknown as Block[]
  const seen: string[] = []
  let yields = 0
  let clock = 0
  const steps = await backfillPinyinSlices({
    blocks,
    refresh: async (chunk) => { seen.push(...chunk.keys()) },
    now: () => (clock += 4), // 每片固定“花 4ms”：预算 8ms → 下一片按反推变大
    yieldIdle: async () => { yields += 1 },
  })

  assert.equal(seen.length, 100, '每一块都处理到')
  assert.equal(new Set(seen).size, 100, '没有重复')
  assert.deepEqual(seen, blocks.map((block) => block.entityId), '顺序照原序')
  assert.equal(yields, steps.length - 1, '除了最后一片，每片之间都让出一次')
  assert.ok(steps[1].size >= steps[0].size, '按上一片读数放大')
  assert.equal(steps.reduce((sum, step) => sum + step.size, 0), 100)
})
