/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
/**
 * 行内格式的三层作用域（用户 2026-09-27 定案，docs/09 §6.9）。
 *
 * | 入口 | 管什么 |
 * |---|---|
 * | 顶部常驻格式栏 + 格式快捷键（⌘B / ⌘I / ⌘⇧S / ⌘⇧H） | **接下来输入的字的格式**：点一下开启，光标处与之后敲的字都带上；
 *   再点一下（或再按一次快捷键）取消。有文字选区时同样作用在该选区上（与文字工具栏同目标） |
 * | 块工具栏（把手选中后浮出的「加粗整块」等） | **整个块的格式** |
 * | 文本选中工具栏（选中文字后浮出） | **选中文字的格式** |
 *
 * 这三条都不是自己发明的语义：Lexical 的 `RangeSelection.formatText` 就是「折叠光标 = 设置待输入格式、
 * 有选区 = 作用在选区、并让之后的输入延续这个格式」（见 `$formatText` / `$updateTextFormat`），
 * 所以顶部格式栏与快捷键**不需要**任何额外分支——直接调用它，折叠与选区两种情况天然都对外。
 *
 * 教训（2026-09-27 第 4 轮）：此前给「没有选区」补了一条「作用于光标块」的回退，等于把顶部格式栏
 * 变成了第二个块工具栏，和用户的心智模型冲突。
 *
 * 2026-10-24 模块化 M2-1：从 `ui/formatState.ts` 搬进 `editor/`，`TextFormatType` 收成编辑器自己的
 * 六格式联合；UI 不再直接 import Lexical 的类型。
 */
export type EditorTextFormat = 'bold' | 'italic' | 'underline' | 'strikethrough' | 'code' | 'highlight'

export const EDITOR_FORMATS: EditorTextFormat[] = ['bold', 'italic', 'underline', 'strikethrough', 'code', 'highlight']

/** 选区（含折叠光标上的「待输入格式」）里开着哪些格式——三层工具栏的按下态都读这一份。 */
export function formatsOf(
  selection: { hasFormat: (format: EditorTextFormat) => boolean } | null,
  formats: EditorTextFormat[] = EDITOR_FORMATS,
): EditorTextFormat[] {
  if (!selection) return []
  return formats.filter((format) => selection.hasFormat(format))
}
