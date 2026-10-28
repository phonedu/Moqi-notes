/**
 * 拼音回填的分片调度（`D-042` 的修复；0.6 性能批 ⓒ 第 ② 条「启动期同步计算审计」的第一件）。
 *
 * **它解决什么**：老库 / 新库首次启动时，前端要把全部存活块的拼音算进索引（拼音由前端算、
 * Rust 不碰，见 `03` §15）。原实现按**固定 300 块一片**：一片里的 `pinyin-pro` 转换是**同步**
 * 的一大坨——5000 块量级在真机上单片 1–3.7s（`D-042` 实测：启动后 10 秒内 12 条长任务），
 * 撞上打字就是一次 ≈5s 的停顿。
 *
 * **怎么修**：按**时间预算**切片（上一片花了多久 → 反推这一片取多少），片间**让出空闲**
 * （`requestIdleCallback`，带 timeout 兜底；不可用回退 `setTimeout(0)`）——总时长可能略长，
 * 但单次主线程占用被压在预算内，输入与渲染优先。
 *
 * 判据（纯函数）与驱动分开：`nextSliceSize` 可单测，驱动注入 `refresh` / `yieldIdle` 便于测。
 * 行为行 `PERF-PINYIN-1`（`11` §3.23）。
 *
 * 本文件同时是**拼音模块的装载点**（性能批 ⓒ ①）：`pinyin-pro`（≈300 KB）在主包外，
 * 这里给出 `prefetchPinyinModule`（首帧后空闲预取）与 `yieldToIdle`（分片让路共用）。
 */
import { useEffect, useRef } from 'react'
import type { Block } from '@moqi/editor'

/** 每片的时间预算（ms）：单次主线程占用不超它。8ms ≈ 半帧，留出输入与渲染的余量。 */
export const PINYIN_SLICE_BUDGET_MS = 8

/** 首片大小：单块成本未知时的保守起步（之后按上一片反推）。 */
export const PINYIN_FIRST_SLICE = 24

/**
 * 纯判据：下一片取多少块。
 * - 没有上一片的读数 → 保守起步（`PINYIN_FIRST_SLICE`）；
 * - 有读数 → `预算 ÷ 单块成本`（至少 1 块，避免算不完）；
 * - 永远不超过剩余量。
 */
export function nextSliceSize(remaining: number, lastSliceMs: number, lastSliceSize: number, budgetMs: number): number {
  if (remaining <= 0) return 0
  if (lastSliceMs <= 0 || lastSliceSize <= 0) return Math.min(PINYIN_FIRST_SLICE, remaining)
  const perBlockMs = lastSliceMs / lastSliceSize
  const guess = perBlockMs > 0 ? Math.floor(budgetMs / perBlockMs) : remaining
  return Math.max(1, Math.min(remaining, guess))
}

/** 让出空闲：优先 `requestIdleCallback`（带 timeout 兜底），不可用回退宏任务。 */
export function yieldToIdle(): Promise<void> {
  const idle = (globalThis as { requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number }).requestIdleCallback
  if (typeof idle === 'function') {
    return new Promise((resolve) => { idle(() => resolve(), { timeout: 200 }) })
  }
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

/**
 * 首帧后趁空闲把拼音模块取回来（性能批 ⓒ ①：它拖着的 `pinyin-pro` ≈300 KB 已在主包外）。
 * 不预取的话，「首次保存 / 第一条拼音查询」才现取——下载 ＋ 解析会落在写路径上打一个急刹。
 * 取回来是**同一份模块实例**：之后 `refreshPinyin` / 搜索走的就是它。
 */
export function prefetchPinyinModule(): void {
  void yieldToIdle().then(() => import('../application/pinyinSearch')).catch(() => undefined)
}

export type BackfillStep = {
  /** 已处理到的位置（供进度显示/调试） */
  offset: number
  /** 本片大小 */
  size: number
  /** 本片耗时（ms） */
  ms: number
}

/**
 * 驱动：把 `blocks` 按时间预算分片交给 `refresh`，片间 `yieldIdle`。
 * 返回逐片读数；可注入 `now` / `yieldIdle` 便于测试。
 */
export async function backfillPinyinSlices(options: {
  blocks: Block[]
  refresh: (chunk: Map<string, Block>) => Promise<unknown>
  budgetMs?: number
  now?: () => number
  yieldIdle?: () => Promise<void>
}): Promise<BackfillStep[]> {
  const budgetMs = options.budgetMs ?? PINYIN_SLICE_BUDGET_MS
  const now = options.now ?? (() => performance.now())
  const yieldIdle = options.yieldIdle ?? yieldToIdle
  const steps: BackfillStep[] = []
  let offset = 0
  let lastMs = 0
  let lastSize = 0
  while (offset < options.blocks.length) {
    const size = nextSliceSize(options.blocks.length - offset, lastMs, lastSize, budgetMs)
    const slice = options.blocks.slice(offset, offset + size)
    const started = now()
    await options.refresh(new Map(slice.map((block) => [block.entityId, block])))
    const ms = now() - started
    steps.push({ offset, size, ms })
    offset += size
    lastMs = ms
    lastSize = size
    if (offset < options.blocks.length) await yieldIdle()
  }
  return steps
}

/**
 * 外壳用的挂载点：索引状态说「覆盖率不足」时跑一次回填（只跑一次，ref 守住；
 * 补完覆盖率自然相等，不会重复跑无用的活）。
 */
export function usePinyinBackfill(options: {
  needsBackfill: boolean
  blocks: () => Block[]
  refresh: (chunk: Map<string, Block>) => Promise<unknown>
}): void {
  const startedRef = useRef(false)
  const { needsBackfill, blocks, refresh } = options
  useEffect(() => {
    if (startedRef.current || !needsBackfill) return
    startedRef.current = true
    const live = blocks().filter((block) => !block.deleted)
    void backfillPinyinSlices({ blocks: live, refresh }).catch(() => undefined)
    // 只跑一次（`startedRef` 守住）——覆盖率与块的后续变化不该重跑回填。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsBackfill])
}
