import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { TextFormatType } from '@moqi/editor'
import { useTextToolbarEditor } from '@moqi/editor'
import { Icon, type IconName } from '@moqi/editor'
import { clipboardPort } from '../composition'
import { AI_UI_OPS } from './aiMenu'
import { Popover, anchorOf, type AnchorRect } from './Popover'
import { textSelectionRectOf, toolbarPlacement } from './blockAnchor'
import type { AiAction } from '@moqi/editor'

type ToolbarState = { rect: { top: number; left: number; right: number; bottom: number; width: number; height: number } }

const FORMAT_BUTTONS: { format: TextFormatType; icon: IconName; label: string }[] = [
  { format: 'bold', icon: 'bold', label: '加粗选中文字（⌘B）' },
  { format: 'italic', icon: 'italic', label: '斜体选中文字（⌘I）' },
  { format: 'underline', icon: 'underline', label: '下划线（⌘U）' },
  { format: 'strikethrough', icon: 'strike', label: '删除线（⌘⇧S）' },
  { format: 'code', icon: 'inline-code', label: '行内代码' },
  { format: 'highlight', icon: 'highlight', label: '高亮（⌘⇧H）' },
]

/**
 * 文本选中工具栏（docs/09 §6.10）：块内拖选/双击选词后浮在选区上方，
 * 提供行内格式、[[ 链接转换、复制/剪切/删除与 AI 指令。
 * 定位规则：left = 选区中心 − 半宽（钳制在视口内），top = 选区上沿 − 44px，空间不足翻到下方。
 */
export function TextToolbarPlugin({ enabled, formats, onToggleFormat, onConvertLink, onLinkDialog, onAi, onOpenAiPanel, onNotify }: {
  enabled: boolean
  /** 当前选中文字的格式（与常驻格式栏共用同一份快照，见 src/editor/formatState.ts）。 */
  formats: TextFormatType[]
  onToggleFormat: (format: TextFormatType) => void
  /**  按钮：把选区转成页面链接（插入触发词 + 一次性意图，见 EditorShell.convertSelectionToLink）。 */
  onConvertLink: () => void
  /** `外部链接` 按钮：开同一对话框（`R09-ELINK-1`；有选区时文字预填）。 */
  onLinkDialog: () => void
  onAi?: (action: AiAction) => void
  onOpenAiPanel?: () => void
  onNotify: (message: string) => void
}) {
  const [state, setState] = useState<ToolbarState | null>(null)
  const [aiAnchor, setAiAnchor] = useState<AnchorRect | null>(null)
  const rootRef = useRef<HTMLElement | null>(null)

  const measure = useCallback(() => {
    if (!enabled) { setState(null); return }
    // 文字侧锚点矩形（含三条「不该出」的守卫）收在定位服务里：`blockAnchor.textSelectionRectOf`。
    const rect = textSelectionRectOf(rootRef.current, typeof window === 'undefined' ? null : window.getSelection())
    setState(rect ? { rect } : null)
  }, [enabled])

  const replaceSelection = useTextToolbarEditor({ enabled, rootRef, measure })

  /** 格式写入走调用方的统一入口（常驻格式栏同一个），这里只负责收起工具栏。 */
  const applyFormat = (format: TextFormatType) => {
    onToggleFormat(format)
    measure()
  }

  const selectedText = (): string => {
    if (typeof window === 'undefined') return ''
    return window.getSelection()?.toString() ?? ''
  }

  const copySelection = async () => {
    const text = selectedText()
    if (!text) return
    try { await clipboardPort.writeText(text) } catch { onNotify('复制失败：剪贴板不可用') }
  }

  const cutSelection = async () => {
    const text = selectedText()
    if (!text) return
    try { await clipboardPort.writeText(text) } catch { /* 剪贴板不可用时仍执行剪切，只提示失败 */ }
    replaceSelection('')
    setState(null)
    /* B 批：剪贴成功不弹通知（剪贴板自证） */
  }

  const deleteSelection = () => {
    replaceSelection('')
    setState(null)
  }

  const convertLink = () => {
    // 插入 `[[`+选中文字并记下一次性意图：候选菜单列出全部页面，选中的原文原样成为链接文字。
    onConvertLink()
    setState(null)
  }

  // Esc 逐层退出：AI 指令下拉打开时先由它自己消费，再按一次才收起工具栏（docs/09 §九）。
  useEffect(() => {
    if (!enabled || !state || aiAnchor) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setState(null)
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [enabled, state, aiAnchor])

  if (!enabled || !state) return null

  const width = 424
  const viewportWidth = typeof window === 'undefined' ? 1200 : window.innerWidth
  // 落点数学收在定位服务里（`blockAnchor.toolbarPlacement` 的 `text` 档，与块浮条同一份）。
  const { top, left } = toolbarPlacement('text', state.rect, { width, viewportWidth })
  const arrow = Math.max(14, Math.min(state.rect.left + state.rect.width / 2 - left, width - 14))

  return (
    <>
      <div className="txtbar" role="toolbar" aria-label="文本选中工具栏" style={{ top, left, width, ['--ax' as string]: `${arrow}px` }}>
        {FORMAT_BUTTONS.map((button) => (
          <button
            key={button.format}
            type="button"
            className={formats.includes(button.format) ? 'is-on' : ''}
            aria-label={button.label}
            aria-pressed={formats.includes(button.format)}
            title={button.label}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => applyFormat(button.format)}
          >
            <Icon name={button.icon} size={17} decorative />
          </button>
        ))}
        <span className="div" />
        <button type="button" aria-label="转为页面链接" title="选区文字转为 [[页面链接]]，随后选择目标页面" onMouseDown={(event) => event.preventDefault()} onClick={convertLink}>
          <Icon name="brackets" size={17} decorative />
        </button>
        <button type="button" aria-label="插入外部链接" title="选区文字转为外部链接（⌘L 同一对话框，文字预填）" onMouseDown={(event) => event.preventDefault()} onClick={() => { setState(null); onLinkDialog() }}>
          <Icon name="external-link" size={17} decorative />
        </button>
        <span className="div" />
        <button type="button" aria-label="复制" title="复制" onMouseDown={(event) => event.preventDefault()} onClick={() => void copySelection()}>
          <Icon name="copy" size={17} decorative />
        </button>
        <button type="button" aria-label="剪切" title="剪切" onMouseDown={(event) => event.preventDefault()} onClick={() => void cutSelection()}>
          <Icon name="scissors" size={17} decorative />
        </button>
        <button type="button" className="is-danger" aria-label="删除" title="删除选中文字" onMouseDown={(event) => event.preventDefault()} onClick={deleteSelection}>
          <Icon name="trash" size={17} decorative />
        </button>
        {onAi ? <span className="div" /> : null}
        {onAi ? (
        <button
          type="button"
          aria-label="AI 指令"
          title="AI 指令（作用于选中文字）"
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event: ReactMouseEvent<HTMLButtonElement>) => setAiAnchor((current) => current ? null : anchorOf(event.currentTarget))}
        >
          <Icon name="sparkles" size={17} decorative />AI<Icon name="chevron-down" size={13} decorative />
        </button>
        ) : null}
      </div>
      {aiAnchor && onAi ? (
        <Popover anchor={aiAnchor} width={196} label="AI 指令" onClose={() => setAiAnchor(null)}>
          {AI_UI_OPS.map((item) => (
            <button
              key={item.op}
              type="button"
              disabled={!item.action}
              title={item.hint}
              onClick={() => {
                setAiAnchor(null)
                if (item.action) { setState(null); onAi?.(item.action) }
              }}
            >
              <span className="mi"><Icon name={item.icon} size={16} decorative /></span>
              <span>{item.label}</span>
              {/* B 批（`R09-STATE-5` / “隐藏优于灰着”）：未实现项的「后续版本」死分支已删（由 `accept:R09-SCOPE-17` 看护） */}
            </button>
          ))}
          <hr />
          <button type="button" onClick={() => { setAiAnchor(null); setState(null); onOpenAiPanel?.() }}>
            <span className="mi"><Icon name="list-tree" size={16} decorative /></span>
            <span>打开 AI 助手</span>
          </button>
        </Popover>
      ) : null}
    </>
  )
}
