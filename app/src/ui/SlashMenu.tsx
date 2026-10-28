import { useEffect, useRef, useState } from 'react'
import { useBlockAnchor } from './blockAnchor'
import { useSlashMenu } from '@moqi/editor'
import type { LexicalEditor, TextFormatType } from '@moqi/editor'
import { Icon, type IconName } from '@moqi/editor'
import { AVAILABLE_INSERT_ITEMS, BLOCK_TYPE_ITEMS, MEDIA_INSERT_KINDS, type InsertKind } from './menuItems'
import type { BlockType } from '@moqi/editor'

export type SlashGroup = '转换为' | '插入' | '行内'

export type SlashItem =
  | { id: string; group: SlashGroup; label: string; hint: string; icon: IconName; kind: 'type'; type: BlockType }
  | { id: string; group: SlashGroup; label: string; hint: string; icon: IconName; kind: 'insert'; insert: InsertKind }
  | { id: string; group: SlashGroup; label: string; hint: string; icon: IconName; kind: 'format'; format: TextFormatType }
  | { id: string; group: SlashGroup; label: string; hint: string; icon: IconName; kind: 'syntax'; syntax: '[[' }
  | { id: string; group: SlashGroup; label: string; hint: string; icon: IconName; kind: 'external-link' }

/**
 * 斜杠菜单数据集（docs/09 §6.9）：「转换为」直接来自 `BLOCK_TYPE_ITEMS`（同 Aa ▾），
 * 「插入」来自 `AVAILABLE_INSERT_ITEMS`（同 ＋插入 ▾），只有「行内」是本文件独有的紧凑写法。
 */
export const slashItems: SlashItem[] = [
  ...BLOCK_TYPE_ITEMS.map((item): SlashItem => ({
    id: `t-${item.type}`,
    group: '转换为',
    label: item.label,
    hint: item.hint,
    icon: item.icon,
    kind: 'type',
    type: item.type,
  })),
  ...AVAILABLE_INSERT_ITEMS.map((item): SlashItem => ({
    id: `i-${item.kind}`,
    group: '插入',
    label: item.label,
    hint: item.hint,
    icon: item.icon,
    kind: 'insert',
    insert: item.kind,
  })),
  { id: 'f-b', group: '行内', label: '加粗', hint: '⌘B', icon: 'bold', kind: 'format', format: 'bold' },
  { id: 'f-i', group: '行内', label: '斜体', hint: '⌘I', icon: 'italic', kind: 'format', format: 'italic' },
  { id: 'f-u', group: '行内', label: '下划线', hint: '⌘U', icon: 'underline', kind: 'format', format: 'underline' },
  { id: 'f-s', group: '行内', label: '删除线', hint: '⌘⇧S', icon: 'strike', kind: 'format', format: 'strikethrough' },
  { id: 'f-c', group: '行内', label: '行内代码', hint: '', icon: 'inline-code', kind: 'format', format: 'code' },
  { id: 'f-h', group: '行内', label: '高亮', hint: '⌘⇧H', icon: 'highlight', kind: 'format', format: 'highlight' },
  { id: 's-link', group: '行内', label: '页面链接', hint: '[[', icon: 'brackets', kind: 'syntax', syntax: '[[' },
  // `R09-ELINK-1`：外部链接的**家**（⌘L / 常驻格式栏「链接」是镜像，都开同一个对话框）。
  { id: 's-ext', group: '行内', label: '外部链接', hint: '⌘L', icon: 'link', kind: 'external-link' },
]

/**
 * `/` 斜杠菜单（docs/09 §6.9）：光标所在块文字以 `/` 结尾（块首或空格后）时唤出，
 * 按查询词过滤三分区条目。Esc 关闭后本块内不再弹出；查询含空格或删除触发符即关闭。
 */
export function SlashMenuPlugin({ enabled, media = true, onCommand }: {
  enabled: boolean
  /** M5 可选能力：媒体关闭时「插入」组不出图片 / 附件 / 嵌入。 */
  media?: boolean
  onCommand: (editor: LexicalEditor, blockId: string, item: SlashItem, triggerText: string) => void
}) {
  const { editor, state, index, setIndex, choose } = useSlashMenu({
    enabled,
    count: (query) => filterItems(query, media).length,
    onChoose: (currentEditor, blockId, itemIndex, query) => {
      const item = filterItems(query, media)[itemIndex]
      if (item) onCommand(currentEditor, blockId, item, `/${query}`)
    },
  })
  const matches = state ? filterItems(state.query, media) : []
  // 位置与可见性都是**派生**的：由块自己算，不缓存在 state 里（docs/09 §6.9 R09-BEDIT-9）。
  const anchor = useBlockAnchor(editor, state?.blockId ?? null, enabled && state !== null)

  if (!enabled || !state || anchor === null || !anchor.inView) return null

  let flatIndex = -1
  return (
    <div className="slash-menu" role="listbox" aria-label="斜杠菜单" style={{ top: anchor.top, left: anchor.left }}>
      {matches.length === 0 ? <div className="slash-menu-empty">没有匹配的块类型或指令</div> : null}
      {(['转换为', '插入', '行内'] as SlashGroup[]).map((group) => {
        const items = matches.filter((item) => item.group === group)
        if (items.length === 0) return null
        return (
          <div key={group}>
            <div className="slash-menu-title">{group}</div>
            {items.map((item) => {
              flatIndex += 1
              const itemIndex = flatIndex
              const active = itemIndex === index
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`slash-menu-item ${active ? 'is-active' : ''}`}
                  onMouseEnter={() => setIndex(itemIndex)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(itemIndex)}
                >
                  <span className="slash-menu-icon"><Icon name={item.icon} size={16} decorative /></span>
                  <span className="slash-menu-label">{item.label}</span>
                  <span className="slash-menu-hint">{item.hint}</span>
                </button>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

/** M5：`media` 关闭时媒体插入项（图片 / 附件 / 嵌入）不进候选——与 ＋插入 ▾ 同一判据（`menuItems.ts`）。 */
function baseItems(media: boolean): SlashItem[] {
  return media ? slashItems : slashItems.filter((item) => !(item.kind === 'insert' && MEDIA_INSERT_KINDS.has(item.insert)))
}

export function filterItems(query: string, media = true): SlashItem[] {
  const needle = query.trim().toLowerCase()
  const base = baseItems(media)
  if (!needle) return base
  return base.filter((item) => item.label.toLowerCase().includes(needle) || item.hint.toLowerCase().includes(needle) || item.id.includes(needle))
}
