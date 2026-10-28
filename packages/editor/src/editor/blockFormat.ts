import type { LexicalEditor } from 'lexical'
import { $findBlockNode } from './blockNode'
import type { EditorTextFormat } from './formatState'

/**
 * 整块行内格式：作用于块内全部文本节点，结果通过常规内容同步写回领域。
 *
 * 2026-10-24 模块化 M2-1：从 `ui/BlockTools.tsx` 搬到 `editor/`；UI 只拿块 id 和六格式联合，
 * 不再直接 import Lexical 的 `LexicalEditor` / `TextFormatType`。
 */
export function toggleBlockFormat(editor: LexicalEditor, blockIds: string[], format: EditorTextFormat): void {
  editor.update(() => {
    for (const blockId of blockIds) {
      const node = $findBlockNode(blockId)
      if (!node) continue
      for (const child of node.getChildren()) {
        if (typeof (child as { toggleFormat?: unknown }).toggleFormat === 'function') {
          (child as unknown as { toggleFormat: (format: EditorTextFormat) => void }).toggleFormat(format)
        }
      }
    }
  }, { discrete: true })
}

/** 读取选中块当前的整块格式，用于工具栏按下态。 */
export function blockFormats(editor: LexicalEditor, blockIds: string[], formats: EditorTextFormat[]): EditorTextFormat[] {
  const active: EditorTextFormat[] = []
  editor.getEditorState().read(() => {
    for (const format of formats) {
      for (const blockId of blockIds) {
        const node = $findBlockNode(blockId)
        if (!node) continue
        for (const child of node.getChildren()) {
          const has = (child as unknown as { hasFormat?: (format: EditorTextFormat) => boolean }).hasFormat
          if (typeof has === 'function' && has.call(child, format)) { active.push(format); break }
        }
        if (active.includes(format)) break
      }
    }
  })
  return active
}
