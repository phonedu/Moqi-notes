/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { RefKind } from '../domain/block'
import type { RefCandidate, RefTrigger } from '../domain/refOps'
import type { Suggestion } from '../domain/suggest'

export type RefMenuState = {
  blockId: string
  /** 链接文字：null = 用候选的页名（打字触发）；有值 = 用这段原文（工具条「转链接」）。 */
  displayText: string | null
  typed: string
  offset: number
  kind: RefKind
  trigger: RefTrigger
  query: string
  results: RefCandidate[]
  suggestions: Suggestion[]
}

export type MenuRow = { targetId: string; label: string; hint?: string; reason?: string; group: 'exact' | 'suggest' }

/**
 * 菜单里的行：精确候选在前、建议在后，键盘按同一序列走。
 * 同一页面只出一行；「标题命中」理由在精确候选行上不重复显示（台账 D-015）。
 */
export function menuRows(state: RefMenuState): MenuRow[] {
  const reasons = new Map(
    state.suggestions
      .filter((item) => item.reason !== 'title')
      .map((item) => [item.pageId, item.reasonText]),
  )
  const exact: MenuRow[] = state.results.map((candidate) => ({
    targetId: candidate.targetId,
    label: candidate.label,
    hint: candidate.hint,
    reason: reasons.get(candidate.targetId),
    group: 'exact',
  }))
  const taken = new Set(exact.map((row) => row.targetId))
  const suggested: MenuRow[] = state.suggestions
    .filter((item) => !taken.has(item.pageId))
    .map((item) => ({ targetId: item.pageId, label: item.name, reason: item.reasonText, group: 'suggest' }))
  return [...exact, ...suggested]
}
