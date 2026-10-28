import type { MouseEvent as ReactMouseEvent } from 'react'
import { Icon } from '@moqi/editor'

type EditorTopbarProps = {
  compact: boolean
  saveError: boolean
  canEnterEdit: boolean
  blockTypeLabel: string
  onBackToLibrary: () => void
  onEnterEdit: () => void
  onOpenBlockType: (event: ReactMouseEvent<HTMLButtonElement>) => void
  onOpenInsert: (event: ReactMouseEvent<HTMLButtonElement>) => void
  onOpenFind: () => void
  onOpenOutline: (event: ReactMouseEvent<HTMLButtonElement>) => void
  onOpenAi: () => void
  /** M5 可选能力：AI 关闭时 ✦ 不出现（缺省开，独立使用不受影响）。 */
  showAi?: boolean
  onOpenMore: (event: ReactMouseEvent<HTMLButtonElement>) => void
}

/**
 * 编辑列顶部一排（模块化 M1.5a）：compact 的 ← / ✎，桌面 Aa / ＋ / 🔍 / 大纲，右侧 ✦ / ⋯。
 *
 * 只负责入口外观与事件转发；菜单状态、命令与落盘仍由外壳/EditorSurface 持有。
 */
export function EditorTopbar({
  compact, saveError, canEnterEdit, blockTypeLabel,
  onBackToLibrary, onEnterEdit, onOpenBlockType, onOpenInsert, onOpenFind, onOpenOutline, onOpenAi, onOpenMore, showAi,
}: EditorTopbarProps) {
  const aiVisible = showAi !== false
  return (
    <div className="topbar">
      {compact ? (
        <button type="button" className="tb-btn" aria-label="返回页面库" title="返回页面库" onClick={onBackToLibrary}>
          <Icon name="arrow-left" size={20} decorative />
        </button>
      ) : null}
      {canEnterEdit ? (
        <button type="button" className="tb-btn" aria-label="编辑" title="编辑" onClick={onEnterEdit}>
          <Icon name="pen-line" size={20} decorative />
        </button>
      ) : null}
      <span className="sp" />
      {saveError ? <span className="tb-save" data-st="error" title="本地保存失败">保存失败</span> : null}
      {!compact ? (
        <>
          <button type="button" className="tb-btn" aria-label={`块类型：${blockTypeLabel}`} title="块类型（Aa）" onClick={onOpenBlockType}>
            <span className="format-aa">Aa</span>
          </button>
          <button type="button" className="tb-btn" aria-label="插入新块" title="插入新块" onClick={onOpenInsert}>
            <Icon name="plus" size={17} decorative />
          </button>
          <button type="button" className="tb-btn" aria-label="页内查找（⌘F）" title="页内查找（⌘F）" onClick={onOpenFind}>
            <Icon name="search" size={17} decorative />
          </button>
          <button type="button" className="tb-btn" aria-label="页面大纲" title="页面大纲" onClick={onOpenOutline}>
            <Icon name="list-tree" size={17} decorative />
          </button>
        </>
      ) : null}
      {showAi !== false ? (
        <button type="button" className="tb-btn" aria-label="AI 助手" title="AI 助手：总结 / 提取行动 / 自由提问" onClick={onOpenAi}>
          <Icon name="sparkles" size={compact ? 20 : 17} decorative />
        </button>
      ) : null}
      <button type="button" className="tb-btn" aria-label="更多" title="更多" onClick={onOpenMore}>
        <Icon name="more-vertical" size={compact ? 20 : 17} decorative />
      </button>
    </div>
  )
}
