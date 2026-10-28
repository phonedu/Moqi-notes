import { useEffect, useRef, useState } from 'react'
import type { LexicalEditor } from '@moqi/editor'
import type { RefKind } from '@moqi/editor'
import { parseRefQuery, type RefCandidate, type RefTrigger } from '@moqi/editor'
import { useBlockAnchor } from './blockAnchor'
import { useReferenceMenu } from '@moqi/editor'
import { menuRows, type MenuRow } from '@moqi/editor'
import type { Suggestion } from '@moqi/editor'

/**
 * 菜单里的一行：精确候选在前、建议在后，**键盘按同一个序列走**（↑↓ 不跳组、↵ 都能插入）。
 * `group` 只决定「建议」那条分组条画在哪一行——行本身连续，键盘序列不分段。
 *
 * **同一个页面只出一行**（去重），但理由要留住（台账 D-015，2026-10-04）：空查询时精确候选
 * 不筛词、列出整库页面，而建议永远给页面 ⇒ 建议会被精确候选全部吞掉，用户打 `[[` 时看到的
 * 是一串没理由的字母序页面。现在落在精确候选里的那个页面**连理由一起显示**（理由在前、提示在后）。
 * 例外一条：**「标题命中」这条理由在精确候选行上不重复显示**——用户打的字本来就匹配了页名，
 * 再说一遍是噪音（它只在「纯建议行」上有信息量：解释了这一行为什么被推荐）。
 */
/**
 * V2a T13 `[[` object link / `((` Block link menu.
 *
 * 触发词可以落在块内**任意位置**：打字触发时它在块尾，工具条「选中文字 → 转页面链接」时它在文字中间。
 * 判定只要求「光标之前的行内文字以 触发词+查询词 结尾」，并把触发词下标（offset）一起交给领域替换。
 * 关闭（Esc / 点别处 / 删掉触发词）不产生任何事务，触发词保持普通文字。
 */
export function ReferenceMenuPlugin({ enabled, findTargets, suggestFor, onInsert, convertIntent, clearConvertIntent }: {
  enabled: boolean
  /**
   * 「选中文字 → 转链接」的意图：返回 true 表示**这个块**这次触发来自工具条按钮。
   * 与打字触发的区别（docs/09 §6.9）：查询词不参与筛选（列出全部候选），
   * 且链接文字用**用户选中的原文**，而不是目标页名——选中的是普通词时也能用。
   *
   * 候选状态在每次编辑器更新都会重算（输入 / 同步 / 光标），所以意图**不能读一次就清**：
   * 它要一直有效到「插入完成」或「菜单关闭」，由 clearConvertIntent 收尾。
   */
  convertIntent?: (blockId: string) => boolean
  /** 收尾：插入完成或菜单关闭时清掉意图。 */
  clearConvertIntent?: () => void
  findTargets: (kind: RefKind, query: string, fromId: string) => RefCandidate[]
  /** V2c：规则版建议（domain/suggest.ts 的纯函数）——界面只负责画与选。 */
  suggestFor: (kind: RefKind, query: string, fromId: string) => Suggestion[]
  onInsert: (editor: LexicalEditor, blockId: string, kind: RefKind, trigger: RefTrigger, query: string, targetId: string, displayText: string, offset: number) => void
}) {
  const { editor, state, index, setIndex, choose } = useReferenceMenu({
    enabled,
    findTargets,
    suggestFor,
    convertIntent,
    clearConvertIntent,
    onInsert: (currentEditor, current, row) => {
      onInsert(currentEditor, current.blockId, current.kind, current.trigger, current.typed, row.targetId, current.displayText ?? parseRefQuery(current.typed).display ?? row.label, current.offset)
    },
  })
  // 位置与可见性都是**派生**的：由块自己算，不缓存在 state 里（docs/09 §6.9 R09-BEDIT-9）。
  const anchor = useBlockAnchor(editor, state?.blockId ?? null, enabled && state !== null)

  if (!enabled || !state || anchor === null || !anchor.inView) return null
  const rows = menuRows(state)
  const suggestionStart = rows.findIndex((row) => row.group === 'suggest')
  return (
    <div className="slash-menu" role="listbox" aria-label={state.kind === 'object' ? '对象双链' : '块双链'} style={{ top: anchor.top, left: anchor.left }}>
      <div className="slash-menu-title">{state.kind === 'object' ? '链接到对象' : '链接到 Block'}</div>
      {rows.length === 0 ? <div className="slash-menu-empty">无匹配结果</div> : rows.map((row, rowIndex) => (
        <div key={row.targetId}>
          {/* 建议组的分组条：它下面是**按规则推荐**的，不是搜索命中——分开画，别让用户以为是一回事（`R09-BEDIT-5b`）。 */}
          {rowIndex === suggestionStart ? (
            <div className="slash-menu-group">建议<span className="sub">按规则推荐 · 每条只给一个理由</span></div>
          ) : null}
          <button
            type="button"
            role="option"
            aria-selected={rowIndex === index}
            className={`slash-menu-item ${rowIndex === index ? 'is-active' : ''}`}
            onMouseEnter={() => setIndex(rowIndex)}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => choose(rowIndex)}
          >
            <span className="slash-menu-label">{row.label}</span>
            <span className="slash-menu-hint">{row.reason ? (row.hint ? `${row.reason} · ${row.hint}` : row.reason) : row.hint}</span>
          </button>
        </div>
      ))}
    </div>
  )
}
