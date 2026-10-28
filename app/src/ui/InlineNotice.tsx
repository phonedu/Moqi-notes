/**
 * 就地提示带（θ10 · `R09-STATE-1b`）：失败 / 不可用 / 带动作的**唯一**提示形态。
 *
 * 为什么不再用浮层 toast：底部（或顶部）浮层会盖住正文、在写作流以外抢注意力，且"弹一下就走"——
 * 失败要留得住。改成**在文档流里**的一条横幅：编辑器 = 顶栏（格式栏）下、设置 = 弹窗内容顶部。
 *
 * 时长（`R09-STATE-1b`）：**统一 6s 退场**——带动作的 6s 是让「撤销」读完才点得到；其余也 6s
 * （横幅不在视线焦点上，比原浮层的 2.6s 多留一倍）。成功类不走这里（界面自证，见 `R09-STATE-5`）。
 */
export type Notice = { message: string; actionLabel?: string; onAction?: () => void }

export function InlineNotice({ notice, onDone }: { notice: Notice | null; onDone: () => void }) {
  if (!notice) return null
  return (
    <div className="notice" role="status">
      <span className="notice-text">{notice.message}</span>
      {notice.actionLabel && notice.onAction ? (
        <button
          type="button"
          className="notice-act"
          onClick={() => {
            notice.onAction?.()
            onDone()
          }}
        >
          {notice.actionLabel}
        </button>
      ) : null}
    </div>
  )
}
