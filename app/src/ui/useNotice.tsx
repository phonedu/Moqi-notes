import { useCallback, useEffect, useRef, useState } from 'react'
import { InlineNotice, type Notice } from './InlineNotice'

/**
 * 就地提示带的机制（θ10 · `R09-STATE-1b`）：状态 + 发号 + 计时，一处拥有。
 *
 * 为什么住钩子、不住 `EditorShell`：外壳的**大小棘轮**只许变短（`check:size`），
 * 提示机制是纯界面管道，放这里既省外壳的行，也保证"全应用只有一个发号口"。
 *
 * 时长：**统一 6s 退场**（带动作的 6s = 「撤销」要读完才点得到；失败 / 不可用的 6s = 横幅不在视线
 * 焦点上，比原浮层的 2.6s 多留一倍余量）。下一次提示会把上一条顶掉。**不常驻**的理由：提示是「事件」，
 * 持久状态另有其位（保存态住顶栏、禁用原因写成行内说明、属性失败走 `.pe-problem`）——常驻横幅会
 * 一直占着正文上方一行、还会在问题修好后继续误导（`accept:R09-SET-5` 就是被这条抓出来过的）。
 */
export function useNotice() {
  const [notice, setNotice] = useState<Notice | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const notify = useCallback((message: string, actionLabel?: string, onAction?: () => void) => {
    setNotice({ message, actionLabel, onAction })
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setNotice(null), 6000)
  }, [])

  const clear = useCallback(() => setNotice(null), [])

  /** 一处宿主：`hidden` 用于"这个面正被别的面盖着"（比如设置弹窗开着时视图里那几份让位）。 */
  const band = (hidden = false) => <InlineNotice notice={hidden ? null : notice} onDone={clear} />

  return { notify, band }
}
