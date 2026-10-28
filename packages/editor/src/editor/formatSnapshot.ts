/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { $getSelection, $isRangeSelection } from 'lexical'
import type { EditorState, LexicalEditor, TextFormatType } from './editorTypes'
import { blockFormats } from './blockFormat'
import { EDITOR_FORMATS, formatsOf } from './formatState'

/** 编辑器当前的格式快照：选区/光标格式 + 选中块的整块格式（docs/09 §6.9 的作用域表）。 */
export function readFormatSnapshot(editor: LexicalEditor, selectedIds: string[]): { selection: TextFormatType[]; blocks: TextFormatType[] } {
  let selection: TextFormatType[] = []
  editor.getEditorState().read(() => {
    const current = $getSelection()
    if ($isRangeSelection(current)) selection = formatsOf(current)
  })
  return {
    selection,
    blocks: selectedIds.length > 0 ? blockFormats(editor, selectedIds, EDITOR_FORMATS) as TextFormatType[] : [],
  }
}
