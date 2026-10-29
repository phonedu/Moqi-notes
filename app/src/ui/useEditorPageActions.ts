import type { MutableRefObject } from 'react'
import type { LexicalEditor } from '@moqi/editor'
import { createTextBlock, orderedRootIds, type BlockMap, type MetadataRegistry } from '@moqi/editor'
import type { DomainStore } from '../application/store'
import type { Operation } from '@moqi/editor'
import { availableCopyName } from '@moqi/editor'
import { planBlockDelete } from './deleteGuard'
import { listColumnOnOpen } from './panelLayout'
import { loadBlocksIntoEditor } from '@moqi/editor'
import type { ClipboardPort } from '../application/clipboard'
import type { LibraryFilter } from './libraryFilter'
import type { DialogState } from './useOverlays'
import type { TagSummary, ViewKind } from './types'
import type { UiPrefs } from './uiPrefs'

export type PageActionDeps = {
  store: DomainStore
  editorRef: MutableRefObject<LexicalEditor | null>
  activePageId: string | null
  snapshot: BlockMap
  registry: MetadataRegistry
  libraryFilter: LibraryFilter
  prefs: UiPrefs
  wideEnoughForColumn: boolean
  selectedIds: string[]
  persist: (changedIds: Iterable<string>) => void
  updateRegistry: (next: MetadataRegistry) => void
  updatePrefs: (next: UiPrefs) => void
  setLibraryFilter: (next: (current: LibraryFilter) => LibraryFilter) => void
  setView: (view: ViewKind) => void
  setActivePageId: (id: string) => void
  setRefPanelOpen: (open: boolean) => void
  setAiPanelOpen: (open: boolean) => void
  setBriefOpen: (open: boolean) => void
  setFocusMode: (open: boolean) => void
  exitSelection: () => void
  deleteSelection: (ids?: string[]) => void
  closeDrawer: () => void
  openDialog: (dialog: DialogState) => void
  notify: (message: string, actionLabel?: string, onAction?: () => void) => void
  clipboardPort: ClipboardPort
}

/**
 * 页面与标签动作（模块化 M1.6）：新建 / 打开 / 置顶 / 星标 / 副本 / 复制链接 / 标签合并与移除 /
 * 速览与引用标题。页面装载仍走 `loadBlocksIntoEditor`；领域写入仍走 `persist`。
 */
export function useEditorPageActions(deps: PageActionDeps) {
  const {
    store, editorRef, registry, libraryFilter, prefs, wideEnoughForColumn, selectedIds,
    persist, updateRegistry, updatePrefs, setLibraryFilter, setView, setActivePageId,
    setRefPanelOpen, setAiPanelOpen, setBriefOpen, setFocusMode, exitSelection, deleteSelection, closeDrawer,
    openDialog, notify, clipboardPort,
  } = deps

  // ---------- 页面动作 ----------
  function createPage() {
    const page = createTextBlock({
      entityId: crypto.randomUUID(),
      blockUid: `p${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`,
      isObject: true,
      objectName: '未命名页面',
    })
    // 新建页面只建容器块（名字行为空）：用户接下来敲的第一行就是页面名（docs/04 §3.1）。
  // 不预置空子块——否则光标会落在空子块上，名字那一行永远是空的（ 用户实测）。
    store.apply({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      source: 'user',
      operations: [
        { type: 'insert', opId: crypto.randomUUID(), block: page, parentId: null, index: orderedRootIds(store.read()).length },
      ],
    })
    persist([page.entityId])
    // 新建页面进入编辑器；不自动打开任何面板（用户口径：属性编辑由摘要条原位展开）。
    openPage(page.entityId)
    exitSelection()
    // 窄屏下侧栏是覆盖式抽屉，新建后要能看见正文，把它收起（用户动作 → 同时记下意图）。
    closeDrawer()
  }

  function openPage(pageId: string) {
    const editor = editorRef.current
    setActivePageId(pageId)
    // 从页面库点开一张卡 = 「在右栏打开」：宽屏把页面列显示出来；窄屏 / 放不下三栏时页面列是覆盖式抽屉，
    // 点开一张卡就收起它——否则抽屉会一直盖着刚打开的那一页（docs/09 §八）。
    const listColumnCollapsed = listColumnOnOpen(wideEnoughForColumn)
    if (prefs.listColumnCollapsed !== listColumnCollapsed) updatePrefs({ ...prefs, listColumnCollapsed })
    setView('editor')
    setRefPanelOpen(false)
    setAiPanelOpen(false)
    setBriefOpen(false)
    setFocusMode(false)
    exitSelection()
    if (editor) loadBlocksIntoEditor(editor, store.subtree(pageId))
    // 兜底：个别引擎不认 overflow:clip，清掉滚动容器可能残留的横向偏移。
    const body = editor?.getRootElement()?.closest<HTMLElement>('.editor-body')
    if (body && body.scrollLeft !== 0) body.scrollLeft = 0
  }


  /**
   * V2b: 置顶 / 星标的唯一写入口 —— 领域操作 + 落盘 + toast 走同一条路。
   * 四个入口共用它：卡片 ⋯ 菜单、卡片头部 ★、编辑器 … 菜单、页面列。
   * `setPinned` / `setStarred` 返回 false 表示没改（no-op 或被上限拒绝），此时不落盘也不提示。
   */
  function togglePin(pageId: string) {
    const page = store.get(pageId)
    if (!page) return
    const next = !page.pinned
    /* B 批（`R09-STATE-5`）：成功不弹通知——置顶状态由卡片头部「已置顶」标记自证（`accept:PIN-MARK-1`） */
    if (store.setPinned(pageId, next)) {
      persist([pageId])
    }
  }

  function toggleStar(pageId: string) {
    const page = store.get(pageId)
    if (!page) return
    const next = !page.starred
    /* B 批（`R09-STATE-5`）：成功不弹通知——星标由卡片头部 ★ 自证（`accept:STAR-CARD-1`） */
    if (store.setStarred(pageId, next)) {
      persist([pageId])
    }
  }

  /**
   * 块删除的唯一入口：单块且无子块直接删（⌘Z 可撤销）；多块或带子块先弹确认。
   * 选区飞条、块菜单、窄档块胶囊与键盘删除都走这里，避免「有的路径弹、有的路径不弹」。
   */
  function requestDeleteSelection(ids?: unknown) {
    const roots = Array.isArray(ids) ? ids as string[] : selectedIds
    if (roots.length === 0) return
    const plan = planBlockDelete(roots, (id) => store.get(id), store.snapshot())
    if (!plan.needsConfirm) { deleteSelection(roots); return }
    openDialog({ kind: 'bulkDelete', ids: roots, ...plan })
  }

  function duplicatePage(pageId: string) {
    const rootIds = store.copy([pageId])
    if (!rootIds || rootIds.length === 0) return
    const copyId = rootIds[0]
    const source = store.get(pageId)
    const name = availableCopyName(store.read(), `${source?.objectName ?? '未命名页面'}（副本）`, copyId)
    const copy = store.get(copyId)
    // 名字 = 正文首行（docs/04 §3.1）：副本的**首行内容**也要换成新名字，否则派生会把名字改回源页的名字。
    const previousContent = copy?.content ?? []
    store.apply({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      source: 'user',
      operations: [{ type: 'update', opId: crypto.randomUUID(), blockId: copyId, changes: { content: [{ t: 'text', v: name }] }, previous: { content: previousContent } }],
    })
    persist([copyId])
    openPage(copyId)
    /* B 批（`R09-STATE-5`）：新建成功不弹通知（卡片出现在列表里 = 界面自证） */
  }

  async function copyLink(blockId: string, label: string) {
    const text = `[[${label}]]`
    try {
      await clipboardPort.writeText(text)
      /* B 批（`R09-STATE-5`）：复制链接成功不弹通知（剪贴板自证）——失败仍就地提示 */
    } catch {
      notify(`剪贴板不可用，链接为 ${text}`)
    }
  }

  // ---------- 标签 ----------
  function renameTag(tag: TagSummary, name: string) {
    const next = name.trim().replace(/^#/, '')
    if (!next) return
    const existing = registry.tags.find((item) => item.name === next && item.id !== tag.id)
    if (!existing) {
      updateRegistry({ ...registry, tags: registry.tags.map((item) => item.id === tag.id ? { ...item, name: next, modified: Date.now() } : item) })
      /* B 批：标签重命名成功不弹通知（侧栏标签行自证） */
      return
    }
    // 撞名时自动转为合并，避免出现重复标签。
    mergeTag(tag, { id: existing.id, name: existing.name })
  }

  function mergeTag(tag: TagSummary, target: { id: string; name: string }) {
    const blocks = [...store.read().values()].filter((block) => block.tags.includes(tag.id))
    const operations: Operation[] = blocks.map((block) => ({
      type: 'update',
      opId: crypto.randomUUID(),
      blockId: block.entityId,
      changes: { tags: [...new Set([...block.tags.filter((id) => id !== tag.id), target.id])] },
      previous: { tags: block.tags },
    }))
    if (operations.length > 0) {
      store.apply({ id: crypto.randomUUID(), timestamp: Date.now(), source: 'user', operations })
      persist(blocks.map((block) => block.entityId))
    }
    updateRegistry({ ...registry, tags: registry.tags.filter((item) => item.id !== tag.id) })
    if (libraryFilter.tagIds.includes(tag.id)) setLibraryFilter((current) => ({ ...current, tagIds: current.tagIds.map((id) => (id === tag.id ? target.id : id)) }))
    /* B 批：合并结果不弹通知（标签列表与页数自证）；受影响面保留在侧栏标签行 */
  }

  function removeTagFromAll(tag: TagSummary) {
    const blocks = [...store.read().values()].filter((block) => block.tags.includes(tag.id))
    const operations: Operation[] = blocks.map((block) => ({
      type: 'update',
      opId: crypto.randomUUID(),
      blockId: block.entityId,
      changes: { tags: block.tags.filter((id) => id !== tag.id) },
      previous: { tags: block.tags },
    }))
    if (operations.length > 0) {
      store.apply({ id: crypto.randomUUID(), timestamp: Date.now(), source: 'user', operations })
      persist(blocks.map((block) => block.entityId))
    }
    updateRegistry({ ...registry, tags: registry.tags.filter((item) => item.id !== tag.id) })
    if (libraryFilter.tagIds.includes(tag.id)) setLibraryFilter((current) => ({ ...current, tagIds: current.tagIds.filter((id) => id !== tag.id) }))
  }



  return {
    createPage, openPage, togglePin, toggleStar, requestDeleteSelection, duplicatePage, copyLink,
    renameTag, mergeTag, removeTagFromAll,
  }
}
