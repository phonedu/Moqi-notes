import type { MutableRefObject } from 'react'
import type { LexicalEditor } from '@moqi/editor'
import type { DomainStore } from '../application/store'
import type { RefKind } from '@moqi/editor'
import { owningPageId } from '@moqi/editor'
import type { RefTrigger } from '@moqi/editor'
import { applyExternalLinkInEditor, focusBlockInEditor, insertReferenceInEditor } from '@moqi/editor'
import { loadBlocksIntoEditor } from '@moqi/editor'
import { inTauriShell } from './windowChrome'
import type { ViewKind } from './types'

export type LinkCommandDeps = {
  store: DomainStore
  editorRef: MutableRefObject<LexicalEditor | null>
  activePageId: string | null
  persist: (changedIds: Iterable<string>) => void
  syncEditorChanges: (editor: LexicalEditor, editorState?: ReturnType<LexicalEditor['getEditorState']>) => void
  caretRangeInBlock: (editor: LexicalEditor) => { blockId: string; offset: number; length: number; text: string } | null
  notify: (message: string, actionLabel?: string, onAction?: () => void) => void
  openDialog: (dialog: { kind: 'externalLink'; blockId: string; offset: number; length: number; text: string }) => void
  setView: (view: ViewKind) => void
  setActivePageId: (id: string) => void
  exitSelection: () => void
}

/**
 * 链接与跳转命令（模块化 M1.6）：外部链接对话框 / 写入、行内引用插入、跨页跳转与闪烁。
 *
 * 这些命令跨「块内字符区间」与「页面装载」两层，单独成 hook；判据仍复用已有的
 * `$contentOffset` / `owningPageId`，不在这里重算。
 */
export function useEditorLinkCommands(deps: LinkCommandDeps) {
  const { store, editorRef, activePageId, persist, syncEditorChanges, caretRangeInBlock, notify, openDialog, setView, setActivePageId, exitSelection } = deps

  /**
   * 打开「插入外部链接」对话框（`R09-ELINK-1`）：三个入口（斜杠菜单 · ⌘L · 常驻格式栏「链接」）
   * 走同一个函数；有文字选区时「文字」行预填选区内容。落点（块 + 字符区间）在**这一刻**定下来
   * 存进对话框状态——对话框是模态的，选区不会再变；取消 = 直接关掉，不留痕。
   *
   * 先 `syncEditorChanges`：领域可能还在 220ms 防抖里，而写入按**领域内容**定位区间
   * （与 `insertReference` 同一条教训：不先同步，刚打的字算不进偏移）。
   */
  function openExternalLinkDialog() {
    const editor = editorRef.current
    if (!editor) return
    syncEditorChanges(editor, editor.getEditorState())
    const current = caretRangeInBlock(editor)
    if (!current) return
    openDialog({ kind: 'externalLink', ...current })
  }

  /**
   * **外部链接的唯一命令入口**（`04` `R04-PASTE-1`：对话框、⌘L、格式栏、粘贴纯 URL 都走它，
   * 不许旁路拼片段）。一次事务写一个 `link` 片段；写完就地重建这一块的编辑器内容，光标停在链接之后。
   */
  function applyExternalLink(facts: { blockId: string; offset: number; length: number }, text: string, url: string) {
    if (!store.insertExternalLink(facts.blockId, { text, url, offset: facts.offset, length: facts.length })) return
    const block = store.get(facts.blockId)
    const editor = editorRef.current
    if (!block || !editor) return
    applyExternalLinkInEditor(editor, block, url)
    persist(new Set([block.entityId]))
  }

  /**
   * 点击外部链接 → 调系统浏览器（`R09-ELINK-3`）：不内嵌 webview；打不开就**如实提示**，
   * 不改数据、不静默。桌面外壳的系统打开要接 Tauri 插件（与「系统另存为」同一轮，登记在
   * 13-数据安全设计（已归档）），那一轮落地前这里如实说明。
   */
  function openExternalUrl(url: string): void {
    if (inTauriShell()) {
      notify('打不开这个链接 · 地址已保留在链接里')
      return
    }
    let opened: Window | null = null
    try { opened = window.open(url, '_blank', 'noopener,noreferrer') } catch { opened = null }
    if (!opened) notify('打不开这个链接（当前环境拦住了新窗口）· 地址已保留在链接里')
  }
  function insertReference(editor: LexicalEditor, blockId: string, kind: RefKind, trigger: RefTrigger, query: string, targetId: string, displayText: string, offset?: number) {
    // 先把编辑器里刚敲的触发词与查询词同步进领域：insertInlineRef 按**领域内容**定位要删的那一段，
    // 若领域还在防抖队列里（打字后立刻选候选），删除区间对不上就会静默 no-op——用户看到的就是「选了没反应」。
    syncEditorChanges(editor, editor.getEditorState())
    const affected = store.insertRef(blockId, kind, targetId, { trigger, query, displayText, offset })
    if (!affected) return
    const block = store.get(blockId)
    if (!block) return
    insertReferenceInEditor(editor, block)
    persist(new Set(affected))
  }

  function jumpToBlock(blockId: string) {
    const editor = editorRef.current
    if (!editor) return
    // 跨页跳转：编辑器只装载当前页子树，目标属于别的页面时必须先切页装载（docs/09 §五：链接/块引用点击直接跳转）。
    const ownerPageId = owningPageId(store.read(), blockId)
    if (ownerPageId && ownerPageId !== activePageId) {
      setView('editor')
      setActivePageId(ownerPageId)
      exitSelection()
      loadBlocksIntoEditor(editor, store.subtree(ownerPageId))
      // 等 Lexical 提交这次重载后再定位与闪烁。
      setTimeout(() => focusAndFlash(editor, blockId), 0)
      return
    }
    focusAndFlash(editor, blockId)
  }

  function focusAndFlash(editor: LexicalEditor, blockId: string) {
    focusBlockInEditor(editor, blockId, store, persist)
  }


  return { openExternalLinkDialog, applyExternalLink, openExternalUrl, insertReference, jumpToBlock, focusAndFlash }
}
