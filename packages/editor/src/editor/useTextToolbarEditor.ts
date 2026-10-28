import { useEffect, type MutableRefObject } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $getSelection, $isRangeSelection } from 'lexical'

/**
 * 文本选中工具栏的编辑器侧（模块化 M2）：根节点、更新 / 选区 / 滚动 / 尺寸监听，
 * 以及「替换当前选区」这一条写入。UI 只负责画与量。
 */
export function useTextToolbarEditor({
  enabled, rootRef, measure,
}: {
  enabled: boolean
  rootRef: MutableRefObject<HTMLElement | null>
  measure: () => void
}) {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    if (!enabled) return
    rootRef.current = editor.getRootElement()
    const onSelectionChange = () => measure()
    const unregister = editor.registerUpdateListener(() => measure())
    document.addEventListener('selectionchange', onSelectionChange)
    window.addEventListener('scroll', onSelectionChange, true)
    window.addEventListener('resize', onSelectionChange)
    // 重新进入编辑器视图时，下一帧按当前选区（通常是折叠状态）复位一次。
    const resetTimer = setTimeout(() => measure(), 0)
    return () => {
      clearTimeout(resetTimer)
      unregister()
      document.removeEventListener('selectionchange', onSelectionChange)
      window.removeEventListener('scroll', onSelectionChange, true)
      window.removeEventListener('resize', onSelectionChange)
    }
  }, [editor, enabled, measure, rootRef])

  /** 用文字替换当前选区（删除 / 剪切共用）。 */
  return (text: string) => {
    editor.update(() => {
      const selection = $getSelection()
      if (!$isRangeSelection(selection)) return
      selection.insertText(text)
    }, { discrete: true })
  }
}
