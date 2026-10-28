import { useRef, type MutableRefObject } from 'react'
import type { LexicalEditor, TextFormatType } from '@moqi/editor'
import type { DomainStore } from '../application/store'
import { textContent, type BlockType } from '@moqi/editor'
import { convertSelectionToLinkInEditor, toggleInlineFormatInEditor } from '@moqi/editor'
import type { SlashItem } from './SlashMenu'
import type { InsertKind } from './menuItems'

export type InlineActionDeps = {
  store: DomainStore
  editorRef: MutableRefObject<LexicalEditor | null>
  persist: (changedIds: Iterable<string>) => void
  syncEditorChanges: (editor: LexicalEditor, editorState?: ReturnType<LexicalEditor['getEditorState']>) => void
  caretRangeInBlock: (editor: LexicalEditor) => { blockId: string; offset: number; length: number; text: string } | null
  convertCurrentBlock: (editor: LexicalEditor, blockId: string, type: BlockType, nextText?: string, options?: { checked?: boolean }) => void
  replaceBlockText: (editor: LexicalEditor | null, blockId: string, text: string, options?: { selectEnd?: boolean; mirror?: boolean }) => void
  pickInsert: (editor: LexicalEditor, kind: InsertKind) => void
  openDialog: (dialog: { kind: 'externalLink'; blockId: string; offset: number; length: number; text: string }) => void
}

/** 斜杠命令、行内格式、`[[` 链接意图（模块化 M1.6）。 */
export function useEditorInlineActions(deps: InlineActionDeps) {
  const { store, editorRef, persist, syncEditorChanges, caretRangeInBlock, convertCurrentBlock, replaceBlockText, pickInsert, openDialog } = deps
  /**
   * 「选中文字 → 转页面链接」的一次性意图：值 = 要转换的块 id。
   * 工具条插入 `[[`+选中文字之后、候选菜单取用之前有效；菜单读到它就**不拿这段文字去筛选**
   * （列出全部候选，选中普通词也能挑目标页），并把这段原文当成链接文字（见 ReferenceMenu 的 convertIntent）。
   */
  const linkConvertBlockRef = useRef<string | null>(null)

  // ---------- 编辑器内动作 ----------
  function handleSlashCommand(editor: LexicalEditor, blockId: string, item: SlashItem, triggerText: string) {
    const block = store.get(blockId)
    if (!block) return
    // 斜杠菜单的触发词（`/标题`）要丢掉，触发词之前的正文必须留下。
    // **触发词不一定在块尾**（光标在块中间时它不是后缀）——老写法用末尾正则只认后缀，
  // 块中间的 `/外部` 清不掉、会留在正文里（ 实测）。改成按区间切：
    // 后缀命中就按后缀；否则按「光标偏移 − 触发词长度」算起点（越界时退回块尾）。
    const full = textContent(block)
    const caret = caretRangeInBlock(editor)
    const suffixIndex = full.endsWith(triggerText) ? full.length - triggerText.length : -1
    const triggerStart = suffixIndex >= 0
      ? suffixIndex
      : Math.max(0, (caret && caret.blockId === blockId ? caret.offset : full.length) - triggerText.length)
    const cleaned = full.slice(0, triggerStart) + full.slice(triggerStart + triggerText.length)
    // 外部链接（`R09-ELINK-1` 的家）：把触发词那一段让给链接——用户打的正文一个字不动。
    if (item.kind === 'external-link') {
      syncEditorChanges(editor, editor.getEditorState())
      replaceBlockText(editor, blockId, cleaned)
      openDialog({ kind: 'externalLink', blockId, offset: triggerStart, length: 0, text: '' })
      return
    }
    if (item.kind === 'type') { convertCurrentBlock(editor, blockId, item.type, cleaned); return }
    if (item.kind === 'insert') {
      replaceBlockText(editor, blockId, cleaned)
      // 与 ＋插入 ▾ 同一个落点（`R09-FMT-5`「同一数据源渲染」）：图片 / 附件 / 嵌入从这里也走得通。
      pickInsert(editor, item.insert)
      return
    }
    if (item.kind === 'format') {
      // 与常驻格式栏同一个作用域（docs/09 §6.9）：丢掉触发词后光标落到文末，
      // 这个格式就是「接下来输入的字」的格式——斜杠菜单是格式栏能力的就地紧凑版。
      replaceBlockText(editor, blockId, cleaned)
      toggleInlineFormat(item.format)
      return
    }
    // 剩余的 syntax 项只有 `[[`：重新插入它，ReferenceMenu 会就地打开候选，选中后整体替换为双链。
    replaceBlockText(editor, blockId, `${cleaned}[[`)
  }

  /**
   * 行内格式的统一入口（常驻格式栏 + ⌘B/⌘I/⌘⇧S/⌘⇧H）：**作用于选区**——
   * 折叠光标时就是「接下来输入的字」的格式（Lexical 原生的 `formatText` 语义），
   * 有选区时作用在选区并延续到之后的输入。块级格式走块工具栏的「整块」（toggleBlockFormat），
  * 两者不要混在一条路上（用户 定的三层作用域，见 src/editor/formatState.ts）。
   */
  function toggleInlineFormat(format: TextFormatType) {
    const editor = editorRef.current
    if (!editor) return
    toggleInlineFormatInEditor(editor, format)
  }

  /**
   * 行内语法 `[[`（常驻格式栏与文本选中工具栏共用）：把选区换成 `[[` + 选中文字，
   * 随后 ReferenceMenu 就地打开候选；选定目标后「触发词 + 查询词」整段变成 inline-ref。
   *
   * **领域先行**：先在领域里改内容（`insertRefTrigger` 纯函数），再按领域内容重建编辑器这一块。
   * 早先是编辑器先行、等 220ms 防抖同步领域，但候选菜单的替换以**领域内容**为准
   * （`insertInlineRef` 按内容定位删除区间），一旦两边不同步就会出现「原文被复制了一份」。
   */
  function convertSelectionToLink() {
    const editor = editorRef.current
    if (!editor) return
    const blockId = convertSelectionToLinkInEditor(editor, store, linkConvertBlockRef)
    if (blockId) persist([blockId])
  }

  /** 候选菜单读意图（纯读，不清）：候选状态每次更新都会重算，读了就清只有第一次算得到。 */
  function isLinkConvert(blockId: string): boolean {
    return linkConvertBlockRef.current === blockId
  }

  /** 收尾：插入完成或菜单关闭时清掉意图。 */
  function clearLinkConvert() {
    linkConvertBlockRef.current = null
  }
  return { handleSlashCommand, toggleInlineFormat, convertSelectionToLink, isLinkConvert, clearLinkConvert }
}
