import { usePeekEditor } from '@moqi/editor'
import { Icon } from '@moqi/editor'

export type PeekContent = {
  title: string
  /** 状态行：状态 · 标签 · 更新时间。 */
  status: string
  summary: string
  isBlock: boolean
  /**
   * `R09-ALIAS-2`：链接的显示文字与目标当前页名不同时，多一行「实际指向：<真实页名>」
   * （标题行仍是被引页的标题）。显示文字与页名相同、或目标不是页面时为 undefined。
   */
  alias?: string
}

const CARD_WIDTH = 288
const ESTIMATED_HEIGHT = 176

/**
 * 链接 / 块引用速览卡（docs/09 §五）：悬停 500ms 浮出轻量预览，移出 150ms 自动关闭。
 * 点击目标本身仍然直接跳转——速览卡是悬停增强，不改变点击语义，也不承担编辑功能。
 *
 * 同一族还有一件事（`R09-ALIAS-2`/`R09-ALIAS-3`）：别名链接的**原生 title** = 完整语法
 * `[[真实页名|显示文字]]`。节点类只存 `v` + `targetId`（数据不动），页名只有应用层知道，
 * 所以由这里的 `resolveTitle` 在每个编辑器更新后把 title 同步到 DOM 上（只在变了才写）。
 */
export function PeekPlugin({ enabled, resolve, onJump, resolveTitle }: {
  enabled: boolean
  resolve: (targetId: string, displayText: string) => PeekContent | null
  onJump: (targetId: string) => void
  /** 完整语法 `[[真实页名|显示文字]]` / `((块名))`；返回 null 表示这个目标没有 title。 */
  resolveTitle: (targetId: string, displayText: string) => string | null
}) {
  const { target, hide, keepOpen, closeSoon } = usePeekEditor<PeekContent>({ enabled, resolve, resolveTitle })
  if (!enabled || !target) return null

  const viewportWidth = typeof window === 'undefined' ? 1200 : window.innerWidth
  const viewportHeight = typeof window === 'undefined' ? 900 : window.innerHeight
  const left = Math.max(12, Math.min(target.rect.left, viewportWidth - CARD_WIDTH - 12))
  const below = target.rect.bottom + 8
  const flip = below + ESTIMATED_HEIGHT > viewportHeight - 12
  const top = flip ? Math.max(12, target.rect.top - ESTIMATED_HEIGHT - 8) : below

  return (
    <div
      className="peek"
      role="tooltip"
      aria-label={`${target.content.title} 速览`}
      style={{ top, left, maxHeight: 200 }}
      onMouseEnter={keepOpen}
      onMouseLeave={closeSoon}
    >
      <div className="pk-t">{target.content.isBlock ? '¶ ' : '📄 '}{target.content.title}</div>
      <div className="pk-s">{target.content.status}</div>
      <div className="pk-b">{target.content.summary}</div>
      {target.content.alias ? <div className="pk-s pk-alias">实际指向：{target.content.alias}</div> : null}
      <button type="button" className="pk-go" onClick={() => { hide(); onJump(target.targetId) }}>
        前往 <Icon name="chevron-right" size={12} decorative />
      </button>
    </div>
  )
}
