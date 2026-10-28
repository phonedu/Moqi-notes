import type { ComponentProps, ReactNode } from 'react'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'

export interface EditorBodyProps {
  onChange: ComponentProps<typeof OnChangePlugin>['onChange']
  setContentElement: (element: HTMLDivElement | null) => void
  onExitSelection: () => void
  /** 正文根节点的类名；缺省用墨契编辑器的 `.editor-content`。 */
  contentClassName?: string
  placeholder?: string
  /** 正文尾部的宿主内容（墨契里是反向链接区）。 */
  children?: ReactNode
}

/**
 * 编辑正文的 Lexical 宿主（模块化 M1.5b）。
 *
 * `ui/EditorSurface.tsx` 只负责编辑列布局，不再直接 import Lexical；正文插件
 * （RichText / OnChange / History）和可编辑 DOM 一起住 `editor/`。换成别的内核时，
 * 这里就是正文宿主的替换点。
 */
export function EditorBody({ onChange, setContentElement, onExitSelection, contentClassName, placeholder, children }: EditorBodyProps) {
  return (
    <>
      <RichTextPlugin
        contentEditable={<ContentEditable className={contentClassName ?? 'editor-content'} aria-label="页面编辑器" ref={setContentElement} onMouseDown={onExitSelection} />}
        placeholder={<div className="editor-placeholder">{placeholder ?? '开始写作…'}</div>}
        ErrorBoundary={LexicalErrorBoundary}
      />
      {/* 输入同步（OnChangePlugin）与编辑器内撤销（HistoryPlugin）必须常驻。 */}
      <OnChangePlugin onChange={onChange} ignoreSelectionChange />
      <HistoryPlugin />
      {children}
    </>
  )
}
