import { useCallback, useEffect, useRef } from 'react'

/**
 * 注册型 effect 的稳定回调（docs/04 §7）：effect 只注册一次，回调每次渲染更新。
 * 2026-09-28「标题点不进去」的根因就是注册型 effect 依赖了内联箭头。
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const ref = useRef(fn)
  useEffect(() => { ref.current = fn })
  return useCallback((...args: A) => ref.current(...args), [])
}
