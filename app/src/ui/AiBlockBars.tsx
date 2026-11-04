/** AI 块的两条行（标签行 + 操作行）：从 BlockTools 拆出（0.7 波 2 前置，体量门腾量）。
 *  只管测量与贴位；状态推进（停止 / 采纳 / 重新生成 / 追问）一律走回调——AI 逻辑不在这里。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@moqi/editor'
import { aiBarsFrom, type AiBar, type AiBarSource } from './aiBars'
import { anchorFrameOf, blockElementById, toolbarKeyDown } from './blockAnchor'

export function AiBlockBars({ scopeRef, contentRef, enabled, onStop, onAccept, onRegenerate, onDiscard, onFollow, onEscape }: {
  scopeRef: React.RefObject<HTMLElement | null>
  contentRef: React.RefObject<HTMLElement | null>
  enabled: boolean
  onStop: (blockId: string) => void
  onAccept: (blockId: string) => void
  onRegenerate: (blockId: string) => void
  onDiscard: (blockId: string) => void
  onFollow: (blockId: string) => void
  onEscape: () => void
}) {
  const [bars, setBars] = useState<AiBar[]>([])
  const signatureRef = useRef('')
  const frameRef = useRef<number | null>(null)

  /** 一次测量：读出编辑器里每个 AI 块的状态与盒子，算出两条行该贴在哪。 */
  const measure = useCallback(() => {
    const content = contentRef.current
    if (!content) return
    // 行画在**滚动容器的内容坐标**里（`position: absolute` 挂在 `.doc-col` 上），不是视口坐标：
  // 视口坐标 + `position: fixed` 时，快速滚动会让它们落后一帧再弹回原位（用户实测 
    // 「移动页面太快，AI 块上下抖动、移动然后回到原位」——合成器滚动不等主线程，这是必然结果）。
    // 内容坐标由浏览器自己带着滚。**可见带的判断仍用视口坐标**：块滚到顶栏底下就不画行。
    // 坐标系与可见带都由定位服务回答（'content' = 内容坐标 + 正文滚动容器那条可见带）：
    // 原来这里自己抄了一份换算，AI 行那边又抄了一份（T7 收口，见 ui/blockAnchor.ts）。
    const frame = anchorFrameOf(content, 'content')
    const sources: AiBarSource[] = []
    for (const element of content.querySelectorAll<HTMLElement>('.moqi-block[data-ai-status][data-entity-id]')) {
      const id = element.dataset.entityId
      if (!id) continue
      const rect = element.getBoundingClientRect()
      if (!frame.inView(rect)) continue
      const style = getComputedStyle(element)
      sources.push({
        id,
        status: element.dataset.aiStatus ?? '',
        op: element.dataset.aiOp ?? '',
        src: element.dataset.aiSrc ?? '',
        rect: frame.rect(rect),
        padding: {
          top: parseFloat(style.paddingTop) || 0,
          right: parseFloat(style.paddingRight) || 0,
          bottom: parseFloat(style.paddingBottom) || 0,
          left: parseFloat(style.paddingLeft) || 0,
        },
      })
    }
    const next = aiBarsFrom(sources)
    /**
     * 操作条会因为正文列变窄而换行，块底端预留的高度按**实测行高**写回块上
   * （`--ai-ops-h`，CSS 兜底 53px）。两条稳定性规则（，用户报「AI 块文字滚动时上下抖动」）：
     * - **只在值真的变了才写**：这段代码跑在滚动重测的每一帧上，每帧写一次自定义属性会让浏览器
     *   在滚动过程中反复重排（整块文字随之上下抖）；
     * - **读不到操作行时保留上一次的值**，不要退回 CSS 兜底：实测行高 54px 与兜底 53px 会来回跳，
     *   每帧一跳就是 1px 的抖动，正是用户看到的现象。行宽不变时行高本来就不变。
     */
    const scope = scopeRef.current
    if (scope) {
      for (const bar of next) {
        const element = blockElementById(content, bar.id)
        if (!element) continue
        const row = scope.querySelector<HTMLElement>(`.ai-block-bar[data-marker-for="${bar.id}"] > .ai-ops`)
        const height = row ? row.getBoundingClientRect().height : 0
        const measured = height > 0 ? `${Math.ceil(height + 14)}px` : element.style.getPropertyValue('--ai-ops-h')
        if (measured && element.style.getPropertyValue('--ai-ops-h') !== measured) {
          element.style.setProperty('--ai-ops-h', measured)
        }
      }
    }
    const signature = next
      .map((bar) => `${bar.id}:${bar.variant}:${Math.round(bar.box.top)}:${Math.round(bar.box.left)}:${Math.round(bar.box.width)}:${Math.round(bar.box.height)}`)
      .join('|')
    if (signature === signatureRef.current) return
    signatureRef.current = signature
    setBars(next)
  }, [contentRef, scopeRef])

  const schedule = useCallback(() => {
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      measure()
    })
  }, [measure])

  // 行的位置来自布局：内容变动（流式写入、光标换行、采用/丢弃）、滚动、窗口尺寸都要重新测量。
  useEffect(() => {
    const scope = scopeRef.current
    const content = contentRef.current
    if (!scope || !content || !enabled) return
    const observer = new MutationObserver(() => schedule())
    observer.observe(content, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-ai-status'] })
    // 同标记层：滚动元素是正文列的父级 `.editor-body`，只有 window 捕获阶段收得到（见上一处的说明）。
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    schedule()
    return () => {
      observer.disconnect()
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
      if (frameRef.current !== null) { cancelAnimationFrame(frameRef.current); frameRef.current = null }
    }
  }, [enabled, scopeRef, contentRef, schedule])

  if (!enabled) return null

  return (
    <>
      {bars.map((bar) => (
        <div
          className="ai-block-bar"
          key={bar.id}
          data-marker-for={bar.id}
          data-ai-variant={bar.variant}
          style={{ top: bar.box.top, left: bar.box.left, width: bar.box.width, height: bar.box.height }}
        >
          <div className="ai-lab">
            <Icon name="sparkles" size={12} decorative />
            {bar.variant === 'generating' ? 'AI 生成中' : 'AI 生成'}
            <span className="op-tag">{bar.op}</span>
            <span className="src-tag" title="来源关联保留至采用 / 丢弃">{bar.src}</span>
            {bar.variant === 'generating' ? (
              <>
                <button type="button" className="ai-stop" onClick={() => onStop(bar.id)}>■ 停止</button>
                <span className="ai-dots" aria-hidden="true"><i /><i /><i /></span>
              </>
            ) : null}
          </div>
          {bar.variant === 'done' ? (
            <div
              className="ai-ops"
              role="toolbar"
              aria-label="AI 块操作"
              aria-orientation="horizontal"
              onKeyDown={(event) => toolbarKeyDown(event, onEscape)}
            >
              <button type="button" className="ok" onMouseDown={(event) => event.preventDefault()} onClick={() => onAccept(bar.id)}>✓ 采用<span className="sub">合并为普通块</span></button>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => onRegenerate(bar.id)}>↻ 重新生成</button>
              <button type="button" className="no" onMouseDown={(event) => event.preventDefault()} onClick={() => onDiscard(bar.id)}>✕ 丢弃</button>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => onFollow(bar.id)}>💬 继续追问</button>
            </div>
          ) : null}
        </div>
      ))}
    </>
  )
}
