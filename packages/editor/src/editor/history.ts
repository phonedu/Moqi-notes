import { REDO_COMMAND, UNDO_COMMAND, type LexicalEditor } from 'lexical'

/**
 * Lexical 侧的历史一步（模块化 M2-2）：⌘Z 路由在 `ui/useEditorShortcuts.ts`，
 * 「真的把命令派发给 Lexical」这一下住 `editor/`，UI 不再直接 import 命令常量。
 *
 * 返回值 = Lexical 历史是否吃下这一步（成功 true / 没得撤 false），
 * 调用方据此决定是否回退到领域历史。
 */
export type EditorHistoryHandle = Pick<LexicalEditor, 'dispatchCommand'>

export function stepLexicalHistory(editor: EditorHistoryHandle | null, redo: boolean): boolean {
  return Boolean(editor?.dispatchCommand(redo ? REDO_COMMAND : UNDO_COMMAND, undefined))
}
