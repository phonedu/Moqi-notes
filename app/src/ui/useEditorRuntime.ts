import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { LexicalEditor } from '@moqi/editor'
import { textContent, type Block, type BlockType } from '@moqi/editor'
import { clipboardPort, type TransactionStoragePort } from '../composition'
import { createTextBlock } from '@moqi/editor'
import { loadBlocksIntoEditor } from '@moqi/editor'
import { insertDateText } from './format'
import { insertRoute, type InsertKind } from './menuItems'
import { pathOf, propertyValueLabel } from './shellSupport'
import { refLabel } from '@moqi/editor'
import { summarizeBlock } from '@moqi/editor'
import { formatRelative } from './format'
import type { PeekContent } from './Peek'
import { closeAction, saveThenClose } from './closeFlow'
import { destroyWindow, watchCloseRequested } from './windowChrome'
import { useBlockSelection } from './useBlockSelection'
import { useEditorState } from './useEditorState'
import { useEditorPersistence } from './useEditorPersistence'
import { useEditorBlockCommands } from '@moqi/editor'
import { useEditorLinkCommands } from './useEditorLinkCommands'
import { useEditorPageActions } from './useEditorPageActions'
import { useEditorInlineActions } from './useEditorInlineActions'
import { useEditorData } from './useEditorData'
import { usePropertyEditor } from './usePropertyEditor'
import { useFloatingAnchor } from './blockAnchor'
import { useUndoRouting } from './useEditorShortcuts'

/**
 * 墨契编辑器的运行时组装（模块化 M1.7）。
 *
 * 顺序就是依赖顺序：界面状态 → 保存/同步 → 选区 → 块/链接/页面/行内命令 → 数据与服务 →
 * 关闭流程与浮层锚点。返回的对象是外壳、主内容与浮层组件的唯一输入（`EditorAppRuntime`）。
 */
export function useEditorRuntime(initialBlocks: Block[], storage: TransactionStoragePort, repairNotice?: string | null) {
  const core = useEditorState(initialBlocks, storage, repairNotice)
  const {
    store, snapshot, view, setView, settingsSection, setSettingsSection, settingsLevel, setSettingsLevel,
    settingsOpen, setSettingsOpen, exportChoice, setExportChoice, prefs, setPrefs, saveState, setSaveState,
    revision, setRevision, activePageId, setActivePageId, activePageIdRef, activeBlockId, setActiveBlockId,
    registry, setRegistry, registryRef, libraryFilter, setLibraryFilter, toggleTagFilter, toggleStarFilter,
    refPanelOpen, setRefPanelOpen, aiPanelOpen, setAiPanelOpen, briefOpen, setBriefOpen,
    menu, dialog, openMenu, closeMenu, openDialog, closeDialog, notify, band,
    focusMode, setFocusMode, findQuery, setFindQuery, includeDeleted, setIncludeDeleted,
    drawerOpen, setDrawerOpen, narrow, compact, wideEnoughForColumn, sidebarShown,
    contentElement, setContentElement, aiConfig, setAiConfig,
    editorRef, docColRef, captureEditor, editorRoot, startResize, refreshPinyinRef, undoOwnerRef,
    assetPort, assetsReady, setAssetsReady, assetNames, setAssetNames, closingRef,
    closeDrawer, openSidePanel, openDrawerOverlay, toggleSidebar, togglePageList, updatePrefs, patchPrefs,
    initialConfig, updateRegistry, openSettingsView, closeSettingsView, openExportPage,
  } = core

  const persistence = useEditorPersistence({
    store, storage, activePageId, activePageIdRef, editorRef, undoOwnerRef, registry, updateRegistry,
    assetPort, setAssetNames, setRevision, setSaveState, notify,
    refreshPinyin: (blocks) => refreshPinyinRef.current(blocks),
  })
  const {
    persist, onChange, syncEditorChanges, reloadFromStore, flushPendingPersist, cancelPendingPersist,
    adoptRootContent, pendingEnterRef, editorBase,
    syncState, syncStatus, deviceIdLabel, resolveDeviceId, isSyncConfigured, setSyncDirectory, runSyncOnce, scheduleSync,
  } = persistence
  /**
   * 还债 #2 模块②：选区与批量（`ui/useBlockSelection.ts`）。这里只管注入依赖与派发
   * 「对选中块做的事」——格式 / 缩进 / AI 仍在本文件，模块不认识它们（见模块头注释）。
   */
  const selection = useBlockSelection({
    store, activePageId, reloadFromStore, notify, surfaceRevision: revision, editorRoot,
  })
  const { selectedIds, selectBlock, exitSelection, copySelection, deleteSelection, copySelectionToClipboard, cutSelection, selectionRect } = selection
  const blockCommands = useEditorBlockCommands({
    store, editorRef, selectedIds, activeBlockId, activePageId, persist, syncEditorChanges, reloadFromStore, pendingEnterRef, editorBase,
  })
  const {
    onEnter, outlineMove, toggleCollapse, convertCurrentBlock, replaceBlockText, toggleChecked, caretRangeInBlock,
    handleMove, moveBlocksStep, moveBlockStepById, insertSibling, insertBlockOfType,
    flushPendingEnter, nameRowFacts,
  } = blockCommands
  const linkCommands = useEditorLinkCommands({
    store, editorRef, activePageId, persist, syncEditorChanges, caretRangeInBlock, notify, openDialog, setView, setActivePageId, exitSelection,
  })
  const { openExternalLinkDialog, applyExternalLink, openExternalUrl, insertReference, jumpToBlock } = linkCommands
  /** 用户请求关闭：按规则决定「先问」还是「落盘后关」。 */
  function requestClose() {
    const action = closeAction({ closing: closingRef.current, generating: generatingRef.current })
    if (action === 'ignore') return
    if (action === 'confirm-generating') { openDialog({ kind: 'closeWindow' }); return }
    void proceedClose()
  }

  /**
   * 真正关闭：先把保存队列落盘，再销毁窗口；保存期间重复关闭请求忽略。
   *
   * 保存或关闭失败都复位关闭状态；不能因超时而丢弃尚未落盘的数据。
   */
  async function proceedClose(): Promise<void> {
    if (closingRef.current) return
    closingRef.current = true
    let closed: boolean
    try {
      closed = await saveThenClose(flushPendingPersist, destroyWindow)
    } catch (error) {
      closingRef.current = false
      setSaveState('error')
      notify(`尚未保存，已取消关闭：${error instanceof Error ? error.message : String(error)}；请重试`)
      return
    }
    if (!closed) {
      closingRef.current = false
      notify('关闭窗口失败：再点一次退出，或从任务栏右键关闭')
    }
  }

  /**
   * 关闭窗口（docs/09 §3.1 关闭语义、docs/03 保存契约）：拦下系统关闭请求（Alt+F4 / 任务栏 / 系统关机），
   * 先落盘再自己销毁窗口。**一律 preventDefault**，这样 Tauri 包装器不会再去调一次 `destroy()`，
   * 关闭路径只有我们这一条、可失败可上报。监听只注册一次，所以「有没有生成中的块」走 ref 读最新值。
   */
  useEffect(() => {
    let stop: (() => void) | undefined
    let cancelled = false
    void watchCloseRequested((event) => {
      event.preventDefault()
      if (closingRef.current) return
      requestClose()
    }).then((off) => { if (cancelled) off(); else stop = off })
    return () => { cancelled = true; stop?.() }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps -- 关闭监听只注册一次；随渲染变化的值（生成中 / 队列 / 保存态）都走 ref 读最新

  /**
   * 插入项的**唯一落点**：＋插入 ▾ 与斜杠菜单共用（`R09-FMT-5` 明写「与斜杠菜单同一数据源渲染」）。
   * 去哪儿由纯映射 `insertRoute` 定（文字型直插；图片 / 附件走选文件——13-媒体设计（已归档） §4 的「菜单」管道；
   * 嵌入块落空占位再选来源——`R09-BLOCK-24`）。
   *
   * 为什么要收这一台：斜杠菜单原先直接把 `item.insert` 喂给 `insertBlockOfType`（只认三种文字型，
   * 当初靠一句 `as` 谎报类型压住 TS）——2026-10-06 媒体三件套摘掉 version 后**自动进了斜杠菜单**，
   * 从那条路插图片 / 附件会落下一个没有 asset 的空壳块（正是「文件缺失」那一类脏数据）。
   */
  function pickInsert(editor: LexicalEditor, kind: InsertKind) {
    const route = insertRoute(kind)
    if (route === 'file') { pickMediaFile(kind as 'image' | 'file'); return }
    if (route === 'embed') { insertEmbedPlaceholder(); return }
    if (kind === 'today' || kind === 'now') { insertBlockOfType(editor, 'text', insertDateText(kind)); return }
    insertBlockOfType(editor, kind as 'todo' | 'quote' | 'code')
  }

  // ---------- 派生数据 ----------

  /** 速览卡内容（docs/09 §五）：标题 → 状态行 → 摘要。 */
  function resolvePeek(targetId: string, displayText = ''): PeekContent | null {
    const block = store.get(targetId)
    if (!block) return null
    if (!block.isObject) {
      return {
        title: pathOf(snapshot, block),
        status: `块 · 更新 ${formatRelative(block.modified)}`,
        summary: summarizeBlock(block) || '（空 Block）',
        isBlock: true,
      }
    }
    const paragraphs: string[] = []
    // 与 `useDerivedData` 的库卡片同口径：根块正文 = 页面名，标题行已经显示一次，摘要从子块起算
    // （2026-10-10 视觉批 ⓓ）。
    for (const childId of block.children) {
      const child = snapshot.get(childId)
      if (!child || child.deleted) continue
      const text = textContent(child).replace(/\s+/g, ' ').trim()
      if (text) paragraphs.push(text)
      if (paragraphs.length >= 3) break
    }
    const parts: string[] = []
    for (const def of registry.properties) {
      const label = propertyValueLabel(def, block.properties.find((item) => item.defId === def.id))
      if (label) parts.push(`${def.name} · ${label}`)
    }
    for (const tagId of block.tags) {
      const tag = registry.tags.find((item) => item.id === tagId)
      if (tag) parts.push(`#${tag.name}`)
    }
    parts.push(`更新 ${formatRelative(block.modified)}`)
    // R09-ALIAS-2：显示文字 ≠ 目标当前页名 → 多一行「实际指向」（标题行仍是被引页的标题）。
    const name = block.objectName ?? '未命名页面'
    return {
      title: name,
      status: parts.join(' · '),
      summary: paragraphs.join(' ') || '（空页面）',
      isBlock: false,
      alias: displayText.length > 0 && displayText !== name ? name : undefined,
    }
  }
  /**
   * 别名链接的**原生 title** = 完整语法（`R09-ALIAS-3`）：页面目标 → `[[真实页名|显示文字]]`、
   * 相等时 `[[真实页名]]`；块目标 → `((块名))`。复制与对账靠它，正文里不加角标。
   */
  function resolveRefTitle(targetId: string, displayText: string): string | null {
    const block = store.get(targetId)
    if (!block) return null
    if (block.isObject) {
      const name = block.objectName ?? '未命名页面'
      return displayText.length > 0 && displayText !== name ? `[[${name}|${displayText}]]` : `[[${name}]]`
    }
    return `((${refLabel(block)}))`
  }

  const pageActions = useEditorPageActions({
    store, editorRef, activePageId, snapshot, registry, libraryFilter, prefs, wideEnoughForColumn, selectedIds,
    persist, updateRegistry, updatePrefs, setLibraryFilter, setView, setActivePageId,
    setRefPanelOpen, setAiPanelOpen, setBriefOpen, setFocusMode, exitSelection, deleteSelection, closeDrawer,
    openDialog, notify, clipboardPort,
  })
  const {
    createPage, openPage, togglePin, toggleStar, requestDeleteSelection, duplicatePage, copyLink,
    renameTag, mergeTag, removeTagFromAll,
  } = pageActions
  const inlineActions = useEditorInlineActions({
    store, editorRef, persist, syncEditorChanges, caretRangeInBlock, convertCurrentBlock, replaceBlockText, pickInsert, openDialog,
  })
  const { handleSlashCommand, toggleInlineFormat, convertSelectionToLink, isLinkConvert, clearLinkConvert } = inlineActions
  const data = useEditorData({
    ...core, ...persistence, ...selection, ...blockCommands, ...linkCommands, ...pageActions, ...inlineActions,
    initialBlocks, repairNotice,
  })
  const {
    sidebarStats, openPurgeDialog, purgePages, movePageToTrash, restorePage,
    aiReady, aiState, aiAnswers, aiQuestions, hasGeneratingAiBlock, generatingRef,
    caretBlockInPage, cancelAi, runAi, askAi, insertAnswerAsBlock, acceptAiBlock, discardAiBlock,
    tagSummaries, searchPort, backupPort, exportPort, fileChannel, fileOps,
    insertMediaBlock, importDroppedPaths, importFolder, importDroppedFiles, insertEmbedPlaceholder, applyEmbedSource, clearEmbedSource, pickMediaFile,
    runExportFromPage, exportTagChoices, runMarkdownExport, exportBusy, refreshPinyin, blockTitleForAsk, backupSummary,
    searchScope, setSearchScope, askTargetMode, setAskTargetMode, indexStatus,
    trashEntries, libraryCards, visibleCards, recentPages, activePage, activeBlock,
    aiGridGates, outlineEntries, findHits, propertyRows, tagUsage, propertyUsage,
    backlinkCards, outgoingCards, pageStats, filterCount, activeLibraryTagId,
    formatSnapshot, activeFormatsValue, touchEditId, activateTouchBlock, followTouchBlock, touchBlankTap, exitTouchEdit,
    historyStep, pageColumnVisible,
  } = data
  // ---------- 属性编辑 ----------
  // 写入口（建 / 改名 / 改选项 / 挂载 / 取值 / 标签；**停用已取消**——`13-属性区重规划` §0-4）
  // 住在 `ui/usePropertyEditor.ts`——这里只接线（外壳拆分第四刀，2026-10-09）。
  const { propertyCallbacks, createProperty, createAndAddProperty, deleteProperty, handleRenameProperty, handleAddPropertyOption, mountProperty, handleRenamePropertyOption, handleRemovePropertyOption, handleMovePropertyOption, handleMoveProperty, nameProblemText } = usePropertyEditor({
    registry, updateRegistry, store, activePageId, prefs, updatePrefs, persist, notify, closeDialog,
  })

  const blockTypeOfCursor: BlockType = activeBlock?.type ?? activePage?.type ?? 'text'

  // 锚在滚动列表里的菜单（页面库卡片 ⋯、侧栏标签 ⋯）：位置跟着锚点重测；**列表一滚动就收起**
  // （用户实测 2026-10-03：滚动时既不收也不跟，直接感觉「关不掉」）。收起由 `useFloatingAnchor`
  // 在测量里判定（锚点相对打开那一刻移动了 / 滚出可见带），回调用 ref 存，不会把 effect 绑到每次渲染。
  const listAnchorMenu = menu?.kind === 'card' || menu?.kind === 'tag' ? menu : null
  /** 块菜单的目标块（`R09-BEDIT-10`）：单选时才谈「折叠 / 展开」这类要具体块的条目。 */
  const blockMenuTarget = menu?.kind === 'blockMenu' && menu.blockIds.length === 1 ? store.get(menu.blockIds[0]) ?? null : null
  const closeListAnchorMenu = useCallback(() => closeMenu(), [closeMenu])
  const floatingAnchor = useFloatingAnchor(listAnchorMenu?.element ?? null, listAnchorMenu !== null, closeListAnchorMenu)
  const listAnchorRect = floatingAnchor?.anchor ?? listAnchorMenu?.anchor ?? null
  const listAnchorVisible = listAnchorMenu !== null && (floatingAnchor ? floatingAnchor.inView : true)
  // 离开编辑器就把它的浮层与选中一起收干净：**菜单**已经按视图门住（不会画在别的视图上），但状态还留着
  // ——不清的话切回编辑器时它们会原样冒出来（用户实测 2026-10-03）。放到下一帧：不在 effect 体里同步 setState。
  // **设置弹窗也算「离开编辑器」**（`R09-SET-16` 改成居中模态后它不改 `view`，光靠 `view` 门不住：
  // `FLOAT-VIEW-1` 要求浮层不画在设置弹窗上，所以把 `settingsOpen` 一起看住）。清选区走 `exitSelection`。
  useEffect(() => {
    if (view === 'editor' && !settingsOpen) return
    const frame = requestAnimationFrame(() => { closeMenu(); exitSelection() })
    return () => cancelAnimationFrame(frame)
  }, [view, settingsOpen, closeMenu, exitSelection])


  return {
    ...core, ...persistence, ...selection, ...blockCommands, ...linkCommands, ...pageActions, ...inlineActions, ...data,
    pickInsert, resolvePeek, resolveRefTitle, blockTypeOfCursor, floatingAnchor, listAnchorRect, listAnchorVisible,
    blockMenuTarget, requestClose, proceedClose,
    propertyCallbacks, createProperty, createAndAddProperty, deleteProperty, handleRenameProperty,
    handleAddPropertyOption, mountProperty, handleRenamePropertyOption, handleRemovePropertyOption,
    handleMovePropertyOption, handleMoveProperty, nameProblemText,
  }
}

export type EditorAppRuntime = ReturnType<typeof useEditorRuntime>
