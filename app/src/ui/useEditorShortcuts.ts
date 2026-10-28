import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import { stepLexicalHistory, type EditorHistoryHandle } from '@moqi/editor'
import type { DomainStore } from '../application/store'
import { acceptsBlockKeys, selectionKindOf } from './selectionModel'
import { hasTextSelection } from './shellSupport'
import { OWNER_AFTER_HISTORY, routeRedo, routeUndo, type UndoOwner } from './undoRouting'
import { escapeTarget } from './useOverlays'
import type { DialogState, MenuState } from './useOverlays'
import type { LibraryCard, ViewKind } from './types'
import type { UiPrefs } from './uiPrefs'

/**
 * 快捷键（外壳拆分第五刀，2026-10-09 从 `EditorShell` 抽出）。**两个 effect，两种注册契约**：
 *
 * - `useEditorShortcuts`：主 keydown（⌘\ / ⌘⇧\ / ⌘⇧↑↓ / ⌫ / ⌘C⌘X / ⌘L / ⌘N / ⌘B / ⌘K / ⌘F / Esc / ⌘/ / `?` / ⌘⇧F）——
 *   **依赖清单原样保留**（prefs / dialog / menu / 面板开合 / 选中 / 视图 / 页面列 …），随这些状态重装；
 *   被调用的那些函数不进依赖（原注释：它们每次渲染都会重建，绑当前渲染的闭包即可）。
 * - `useUndoRouting`：⌘Z / ⇧⌘Z 的归属路由——**只注册一次**（`[]`），keydown 里用到的一切都走 ref / store 的现读
 *   （`store` 是稳定实例）。这条契约是刻意的，搬的时候一字未动。
 */
type ShortcutDeps = {
  prefs: UiPrefs
  dialog: DialogState | null
  menu: MenuState | null
  aiPanelOpen: boolean
  refPanelOpen: boolean
  briefOpen: boolean
  selectedIds: string[]
  focusMode: boolean
  view: ViewKind
  activePageId: string | null
  libraryCards: LibraryCard[]
  narrow: boolean
  drawerOpen: boolean
  sidebarShown: boolean
  toggleSidebar: () => void
  togglePageList: () => void
  moveBlocksStep: (direction: 1 | -1) => void
  deleteSelection: () => void
  copySelectionToClipboard: (scope: 'plain') => void | Promise<void>
  cutSelection: () => void | Promise<void>
  openExternalLinkDialog: () => void
  createPage: () => void
  openPage: (pageId: string) => void
  exitSelection: () => void
  setFocusMode: (value: boolean) => void
  /** ⌘, 开合设置弹窗（`R09-SET-18` / 行为行 `SET-OPEN-1`：已开着再按 = 关闭）。 */
  toggleSettings: () => void
  setAiPanelOpen: (value: boolean) => void
  setRefPanelOpen: (value: boolean) => void
  setBriefOpen: (value: boolean) => void
  /** 触控编辑态（`10` §6.3）：Esc 层级输入与出口。 */
  touchEditing: boolean
  exitTouchEdit: () => void
  notify: (message: string, actionLabel?: string, onAction?: () => void) => void
  openDialog: (dialog: DialogState) => void
  closeDialog: () => void
}

export function useEditorShortcuts(deps: ShortcutDeps): void {
  const {
    prefs, dialog, menu, aiPanelOpen, refPanelOpen, briefOpen, selectedIds, focusMode, view, activePageId, libraryCards,
    narrow: _narrow, drawerOpen: _drawerOpen, sidebarShown,
    toggleSidebar, togglePageList, moveBlocksStep, deleteSelection, copySelectionToClipboard, cutSelection,
    openExternalLinkDialog, createPage, openPage, exitSelection, setFocusMode, setAiPanelOpen, setRefPanelOpen, toggleSettings,
    setBriefOpen, touchEditing, exitTouchEdit, notify, openDialog, closeDialog,
  } = deps

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const inEditable = Boolean(target?.closest('.editor-content, input, textarea, select'))
      // 表单控件单独判：块级 ⌘C / ⌘X 不能用 `inEditable` 当守卫——**块选中态下焦点本来就还在
      // 正文容器上**（块标记画在 `.doc-col` 里、点了不改焦点），用它会把自己拦掉（2026-10-05 实测）。
      const inFormField = Boolean(target?.closest('input, textarea, select'))
      // 当前选择（文字选区 > 块选中 > 无）：判据只在 ui/selectionModel.ts 一份，块级键盘共用它。
      const selectionKind = selectionKindOf({ textSelected: hasTextSelection(), blockCount: selectedIds.length })
      const blockKeys = acceptsBlockKeys({ kind: selectionKind, inFormField, composing: false })
      const mod = event.ctrlKey || event.metaKey

      if (mod && !event.shiftKey && event.code === 'Backslash') {
        event.preventDefault()
        // 专注模式下侧栏本就不可见，⌘\ 无效（docs/09 §6.7）。
        if (focusMode) return
        toggleSidebar()
        /* B 批（`R09-STATE-5`）：侧栏折叠 / 展开成功不弹通知（可见面自证） */
        return
      }
      // ⌘⇧\ 折叠 / 展开编辑器左侧的页面列表：两栏都折叠就是放大写作（docs/09 §八）。
      // 用 event.code 判定，Shift+反斜杠在部分键盘布局上 key 是 '|'。
      if (mod && event.shiftKey && event.code === 'Backslash') {
        event.preventDefault()
        if (focusMode) return
        togglePageList()
        /* B 批（`R09-STATE-5`）：页面列表显示 / 折叠成功不弹通知（版面自证） */
        return
      }
      // ⌘⇧↑ / ⌘⇧↓：块上移 / 下移（`R09-KEY-20`）。焦点在正文里时由编辑器的 KEY_DOWN_COMMAND 先接
      // （见 `EditorPlugins`，与 ⌘↑ 折叠同一条路），这里接**块选中态**（焦点在把手 / 工具栏上）那一路。
      if (mod && event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        if (inEditable) return
        event.preventDefault()
        moveBlocksStep(event.key === 'ArrowUp' ? -1 : 1)
        return
      }
      // 块选中态：⌫ / Delete 删除选中的块（`R09-KEY-22`）；文字编辑态下 selectedIds 本来就是空的，
      // 这个分支不会抢编辑器的「删选区 / 合并」语义。
      if (!mod && !event.shiftKey && !event.altKey && (event.key === 'Backspace' || event.key === 'Delete') && blockKeys) {
        event.preventDefault()
        deleteSelection()
        return
      }
      // 块选中态：⌘C / ⌘X 把选中的块送进系统剪贴板（`R09-KEY-21`）。给两种情形让路：
      // 有**文字选区**（那是文字的复制 / 剪切，走内核与平台自己的路径）、焦点在输入框里
      // （搜索框 / 输入框，那里 ⌘C 是输入内容自己的事）。
      if (mod && !event.shiftKey && !event.altKey && (event.key.toLowerCase() === 'c' || event.key.toLowerCase() === 'x') && blockKeys) {
        event.preventDefault()
        if (event.key.toLowerCase() === 'c') void copySelectionToClipboard('plain')
        else void cutSelection()
        return
      }
      // ⌘L 插入外部链接（`R09-KEY-23`；编辑器内）：与斜杠菜单「行内 · 外部链接」、格式栏「链接」同一入口。
      if (mod && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'l' && view === 'editor' && activePageId) {
        event.preventDefault()
        openExternalLinkDialog()
        return
      }
      // ⌘N 新建页面（docs/09 §十）：在正文里也生效，和大多数笔记软件一致。
      if (mod && !event.shiftKey && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        createPage()
        return
      }
      if (mod && !event.shiftKey && event.key.toLowerCase() === 'b' && !inEditable) {
        event.preventDefault()
        toggleSidebar()
        // B 批（`R09-STATE-5`）：陈旧迁移说明 + 用法说明 ⇒ 删；原字面保留供查：notify('编辑器内 ⌘B 是加粗；侧栏快捷键已改为 ⌘\\')
        return
      }
      if (mod && event.key === ',') {
        // R09-SET-18 / `SET-OPEN-1`：⌘, 开合设置弹窗（设置不再是视图，是居中模态；再按 = 关闭）。
        event.preventDefault()
        toggleSettings()
        return
      }
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        // R09-SEARCH-1/4：⌘K 打开全局搜索，**再按一次收起**（与 ⌘/ 速查同一套切换语义）。
        if (dialog?.kind === 'search') { closeDialog(); return }
        openDialog({ kind: 'search' })
        return
      }
      if (mod && !event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        if (dialog?.kind === 'find') { closeDialog(); return }
        if (view !== 'editor') {
          // 非编辑器视图：先自动进入编辑器再打开页内查找（docs/09 §6.3.1）。
          const target = activePageId ?? libraryCards[0]?.id
          if (!target) { notify('还没有页面，先新建一个页面'); return }
          openPage(target)
        }
        openDialog({ kind: 'find' })
        return
      }
      if (event.key === 'Escape') {
        // 该退哪一层是规则（`R09-KEY-13` 的顺序），住在 `ui/useOverlays.ts` 的 `escapeTarget` 里；
        // 这里只负责执行。返回 `menu` / `dialog` / `none` 时什么都不做——浮层自己接 Esc。
        const target = escapeTarget({
          menuOpen: menu !== null,
          dialogOpen: dialog !== null,
          focusMode,
          panels: { ai: aiPanelOpen, ref: refPanelOpen, brief: briefOpen },
          touchEditing,
          hasSelection: selectedIds.length > 0,
        })
        if (target === 'menu' || target === 'dialog' || target === 'none') return
        if (target === 'aiPanel') { setAiPanelOpen(false); return }
        if (target === 'refPanel') { setRefPanelOpen(false); return }
        if (target === 'brief') { setBriefOpen(false); return }
        if (target === 'touchEdit') { exitTouchEdit(); return }
        if (target === 'selection') { exitSelection(); return }
        if (target === 'focus') { setFocusMode(false); return }
        return
      }
      // 快捷键速查面板：⌘/（正文里也能用，用户实测口径）+ 编辑器外的 `?`（docs/09 §六 R09-KEY-12）。
      // 正文里单按 `?` 必须留给正文打字，所以编辑器内只认 ⌘/。
      if (mod && !event.shiftKey && event.key === '/') {
        event.preventDefault()
        if (dialog?.kind === 'keyboard') { closeDialog(); return }
        openDialog({ kind: 'keyboard' })
        return
      }
      if (event.key === '?' || event.key === '？') {
        if (inEditable) return
        event.preventDefault()
        openDialog({ kind: 'keyboard' })
        return
      }
      // 专注模式 ⌘⇧F（docs/09 §6.7、R09-KEY-19）：**必须是组合键**——正文里单按 `f` 是打字，
      // 而专注模式恰恰只在写作时想用；旧的裸 `f` 又被 `!inEditable` 拦住，等于按不出来（用户实测 2026-09-29）。
      if (mod && event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        if (view !== 'editor') {
          const target = activePageId ?? libraryCards[0]?.id
          if (!target) { notify('还没有页面，先新建一个页面'); return }
          openPage(target)
        }
        setFocusMode(true)
        return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [prefs, dialog, menu, aiPanelOpen, refPanelOpen, briefOpen, selectedIds, focusMode, view, activePageId, libraryCards, _narrow, _drawerOpen, sidebarShown]) // eslint-disable-line react-hooks/exhaustive-deps -- openPage 每次渲染都会重建，把事件处理器绑定到当前渲染的闭包即可
}

export function useUndoRouting({ editorRef, store, reloadFromStore, undoOwnerRef }: {
  editorRef: MutableRefObject<EditorHistoryHandle | null>
  store: DomainStore
  reloadFromStore: () => void
  /** ⌘Z 归属（输入 vs 结构）：壳里别处（打字路径）也会写它，所以住外壳、传进来。 */
  undoOwnerRef: MutableRefObject<UndoOwner>
}): { historyStep: (redo: boolean, inEditor?: boolean) => void } {
  const historyRef = useRef<((redo: boolean) => void) | null>(null)
  // 每次提交后刷新（不是渲染期赋值：那条在 hook 里会被 react-hooks 的"渲染期不许碰 ref"拦下；
  // keydown 是用户事件、总在提交之后，语义与原来一致）。
  useEffect(() => {
    historyRef.current = (redo: boolean) => {
      if (redo) store.redo()
      else store.undo()
      reloadFromStore()
    }
  })
  /**
   * 历史上一步（撤销 / 重做）的**唯一实现**：⌘Z / ⇧⌘Z 与移动端主条的 `↩` / `↪` 共用。
   * 归属只看「最后那次改动是谁记的」（见 `ui/undoRouting.ts`：不问 `CAN_UNDO` / `CAN_REDO`——
   * Lexical 0.51 的旧版 `HistoryPlugin` 不注册这两个查询命令，问了永远得到 false）。
   * `inEditor` 缺省 true = 工具栏按钮的语境（焦点在按钮上，但仍属于编辑器面）。
   */
  const historyStep = useCallback((redo: boolean, inEditor = true) => {
      const lexicalEditor = editorRef.current
      const route = !inEditor ? 'domain' : (redo ? routeRedo({ owner: undoOwnerRef.current }) : routeUndo({ owner: undoOwnerRef.current }))
      if (route === 'domain') {
        const domainHasEntries = redo ? store.canRedo() : store.canUndo()
        if (domainHasEntries) {
          historyRef.current?.(redo)
          undoOwnerRef.current = 'domain'
          return
        }
      }
      // 先让 Lexical 撤：`stepLexicalHistory` 自己会返回「撤成了没有」（成功 true / 没得撤 false）。
      const handled = stepLexicalHistory(lexicalEditor, redo)
      if (handled) {
        undoOwnerRef.current = OWNER_AFTER_HISTORY
        return
      }
      // Lexical 也撤不动（历史被整篇重建清空过）→ 最后交给领域，避免「按了没反应」。
      historyRef.current?.(redo)
      undoOwnerRef.current = 'domain'
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return
      if (event.key.toLowerCase() !== 'z') return
      const target = event.target as HTMLElement | null
      const inEditor = Boolean(target?.closest('.editor-content'))
      const redo = event.shiftKey
      // 无论走哪边都在捕获阶段吃掉按键：Lexical 的撤销绑在编辑器根节点（目标阶段），
      // 只拦冒泡的话它已经先撤了一遍自己的历史——一次 ⌘Z 会同时撤两套，光标被它记的位置覆盖。
      event.preventDefault()
      event.stopPropagation()
      historyStep(redo, inEditor)
    }
    // 捕获阶段：比编辑器根节点上的 Lexical 快捷键先一步决策（互斥的关键）。
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
    // 只注册一次：keydown 里用到的一切都走 ref / store 的现读（store 是稳定实例），
    // 把依赖挂上去会让监听器每次渲染重装（同 docs/04 §7 的注册纪律）。
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return { historyStep }
}
