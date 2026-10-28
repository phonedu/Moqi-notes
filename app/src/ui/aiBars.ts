/**
 * AI 块的常驻标记与操作行的规则（docs/09 §6.11、原型 `.ai-block`）。
 *
 * AI 块在编辑器里是**真实的正文块**（Lexical 托管），所以行内容渲染在块之外，
 * 位置由这里的纯规则算出来：块用 CSS 在顶部与底端预留出行高，行就贴在**内容盒**的上/下边缘外侧，
 * 视觉上落在块自己的虚线框里。两条行都常驻，不依赖 hover —— 悬浮方案曾让操作条一移过去就消失。
 */
export type AiBarVariant = 'generating' | 'done'

/** 块元素上量到的输入（`data-ai-*` 由 editor/blockNode.ts 的 decorateAi 写入）。 */
export type AiBarSource = {
  id: string
  status: string
  /** 操作标签文案，如「总结」。 */
  op: string
  /** 来源标签文案，如「来源 1 块」。 */
  src: string
  rect: { top: number; left: number; width: number; height: number }
  padding: { top: number; right: number; bottom: number; left: number }
}

export type AiBar = {
  id: string
  variant: AiBarVariant
  op: string
  src: string
  /** 块的内容盒（视口坐标）：标签行贴在它上沿，操作行贴在它下沿。 */
  box: { top: number; left: number; width: number; height: number }
}

/**
 * 两种行：生成中只有标签 + 停止；完成后有四个操作。
 * **已接受的块没有行**——它在界面上与普通块完全一样（`decorateAi` 不写 `data-ai-*`，见 docs/09 §6.11 R09-AIB-5）。
 */
export function aiBarVariant(status: string): AiBarVariant {
  if (status === 'generating') return 'generating'
  return 'done'
}

/** 折叠在祖先里或尚未布局的块量不出盒子（宽高为 0），这些块不出现任何行。 */
export function aiBarsFrom(sources: AiBarSource[]): AiBar[] {
  const bars: AiBar[] = []
  for (const source of sources) {
    const { rect, padding } = source
    if (!(rect.width > 0) || !(rect.height > 0)) continue
    bars.push({
      id: source.id,
      variant: aiBarVariant(source.status),
      op: source.op,
      src: source.src,
      box: {
        top: rect.top + padding.top,
        left: rect.left + padding.left,
        width: Math.max(rect.width - padding.left - padding.right, 0),
        height: Math.max(rect.height - padding.top - padding.bottom, 0),
      },
    })
  }
  return bars
}
