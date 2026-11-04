/** 选中 / 悬停块飞入的工具条（格式六键 + AI + 删除 + 更多）：从 BlockTools 拆出（0.7 波 2 前置，体量门腾量）。 */
import { useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import type { EditorTextFormat } from '@moqi/editor'
import { Icon, type AiAction } from '@moqi/editor'
import { BLOCK_FORMAT_ITEMS } from './menuItems'
import { Popover, anchorOf, type AnchorRect } from './Popover'
import { toolbarPlacement, toolbarKeyDown } from './blockAnchor'
import { AI_UI_OPS } from './aiMenu'

export function BlockFlybar({ rect, count, activeFormats, onToggleFormat, onConvert, onIndent, onOutdent, onAi, onDelete, onOpenAiPanel, onOpenBlockMenu, onEscape }: {
  rect: AnchorRect
  count: number
  activeFormats: string[]
  onToggleFormat: (format: EditorTextFormat) => void
  onConvert: (event: ReactMouseEvent<HTMLButtonElement>) => void
  onIndent: () => void
  onOutdent: () => void
  onAi?: (action: AiAction) => void
  onDelete: () => void
  onOpenAiPanel?: () => void
  onOpenBlockMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void
  onEscape: () => void
}) {
  const { top, left } = toolbarPlacement('blocks', rect, { width: 560, viewportWidth: typeof window === 'undefined' ? 1200 : window.innerWidth })
  const style: CSSProperties = { top, left }
  // AI 是**下拉**（`R09-BEDIT-5`）：六项按 `AI_UI_OPS` 单一数据源渲染；未实现项的死分支已删（B 批：现无数据命中，由 `accept:R09-SCOPE-17` 看护）。
  const [aiAnchor, setAiAnchor] = useState<AnchorRect | null>(null)
  return (
    <>
      <div
        className="flybar"
        role="toolbar"
        aria-label="块工具栏"
        aria-orientation="horizontal"
        tabIndex={-1}
        style={style}
        onKeyDown={(event) => toolbarKeyDown(event, onEscape)}
        title="⌘/Ctrl+点把手多选 · 拖拽把手移动 · Esc 取消选中"
      >
        {count > 1 ? <span className="fb-count">已选 {count} 块</span> : null}
        {BLOCK_FORMAT_ITEMS.map((item) => (
          <button
            key={item.format}
            type="button"
            className={activeFormats.includes(item.format) ? 'is-on' : ''}
            aria-label={item.label}
            aria-pressed={activeFormats.includes(item.format)}
            title={item.label}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onToggleFormat(item.format)}
          >
            <Icon name={item.icon} size={17} decorative />
          </button>
        ))}
        <span className="div" />
        <button type="button" aria-label="转换块类型" title="转换为块类型（同常驻格式栏的 `Aa ▾`，同一数据源）" onClick={onConvert}><Icon name="heading" size={17} decorative /></button>
        <button type="button" aria-label="缩进" title="缩进（Tab）" onClick={onIndent}><Icon name="indent" size={17} decorative /></button>
        <button type="button" aria-label="反缩进" title="减少缩进（⇧Tab）" onClick={onOutdent}><Icon name="outdent" size={17} decorative /></button>
        <span className="div" />
        <button type="button" aria-label="更多块操作" title="更多块操作（右键块体 / 把手同样打开）" onClick={onOpenBlockMenu}><Icon name="more-vertical" size={17} decorative /></button>
        {onAi ? (
        <button
          type="button"
          aria-label="AI 指令"
          title="AI 指令（作用于选中块）"
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => setAiAnchor((current) => (current ? null : anchorOf(event.currentTarget)))}
        >
          <Icon name="sparkles" size={17} decorative />AI<Icon name="chevron-down" size={13} decorative />
        </button>
        ) : null}
        <span className="div" />
        <button type="button" className="is-danger" aria-label="删除" title="删除选中块（⌘Z 可撤销）" onClick={onDelete}><Icon name="trash" size={17} decorative /></button>
      </div>
      {aiAnchor && onAi ? (
        <Popover anchor={aiAnchor} width={196} label="AI 指令" onClose={() => setAiAnchor(null)}>
          {AI_UI_OPS.map((item) => (
            <button
              key={item.op}
              type="button"
              disabled={!item.action}
              title={item.hint}
              onClick={() => { setAiAnchor(null); if (item.action) onAi?.(item.action) }}
            >
              <span className="mi"><Icon name={item.icon} size={16} decorative /></span>
              <span>{item.label}</span>
              {/* B 批（`R09-STATE-5` / “隐藏优于灰着”）：未实现项的「后续版本」死分支已删（V2c 六项已全实现，现无数据命中）；
                  将来真出现未实现项时，按 `R09-SCOPE-17` 补标注——执行者是 `accept:R09-SCOPE-17` 那三条断言。 */}
            </button>
          ))}
          <hr />
          <button type="button" onClick={() => { setAiAnchor(null); onOpenAiPanel?.() }}>
            <span className="mi"><Icon name="list-tree" size={16} decorative /></span>
            <span>打开 AI 助手</span>
          </button>
        </Popover>
      ) : null}
    </>
  )
}

/**
 * AI 块的常驻标记与操作行（docs/09 §6.11、原型 `.ai-block`）。
 *
 * 块**顶部**是状态与来源标签（`AI 生成` / `AI 生成中` + 操作标签 + 来源标签 + 生成中的 ■停止 与三点），
 * 块**底端**是操作条（✓采用 / ↻重新生成 / ✕丢弃 / 💬继续追问，虚线分隔）。
 * 两条行都由块自己用 CSS 预留出空间（顶部行高 / 底端操作条高度），行贴在块的**内容盒**外沿，
 * 视觉上落在块自己的虚线框里，与原型把 `.lab` / `.ai-ops` 放进块内一致。
 *
 * 常驻不依赖 hover：悬浮方案里操作条长在块外，鼠标一移过去就触发容器的 mouseleave，
 * 操作条先消失——四个操作在真实窗口里根本点不到。
 *
 * 行内容渲染在 Lexical 托管的块之外，块本身仍是普通正文块（可以点进去编辑）。
 */
