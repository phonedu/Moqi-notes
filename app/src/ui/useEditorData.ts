import { useEffect, useMemo, useRef, useState } from 'react'
import type { TextFormatType } from '@moqi/editor'
import { buildSidebarStats } from '@moqi/editor'
import type { Block } from '@moqi/editor'
import type { SearchIndexStatus } from '../application/search'
import { cleanupUnreferencedAssets } from '../application/assetSync'
import { createDefaultBackupPort, createDefaultExportPort, createDefaultFileChannelPort, createDefaultSearchPort } from '../composition'
import type { TagSummary } from './types'
import { useAiRuntime } from './useAiRuntime'
import { useBackNavigation } from './useOverlays'
import { useDataActions } from './useDataActions'
import { useDerivedData } from './useDerivedData'
import { useMediaImport } from './useMediaImport'
import { useEditorShortcuts } from './useEditorShortcuts'
import { useUndoRouting } from './useEditorShortcuts'
import { usePinyinBackfill } from './usePinyinBackfill'
import { useTrashActions } from './useTrashActions'
import { useTouchEdit } from '@moqi/editor'
import { activeFilterCount } from './libraryFilter'
import { currentBlockId } from '@moqi/editor'
import { focusNameRow } from '@moqi/editor'
import { sameFormats } from './shellSupport'
import { readFormatSnapshot } from '@moqi/editor'
import type { useEditorState } from './useEditorState'
import type { useEditorPersistence } from './useEditorPersistence'
import type { useEditorBlockCommands } from '@moqi/editor'
import type { useEditorLinkCommands } from './useEditorLinkCommands'
import type { useEditorPageActions } from './useEditorPageActions'
import type { useEditorInlineActions } from './useEditorInlineActions'
import type { useBlockSelection } from './useBlockSelection'

type Core = ReturnType<typeof useEditorState>
type Persistence = ReturnType<typeof useEditorPersistence>
type Blocks = ReturnType<typeof useEditorBlockCommands>
type Links = ReturnType<typeof useEditorLinkCommands>
type Pages = ReturnType<typeof useEditorPageActions>
type Inline = ReturnType<typeof useEditorInlineActions>
type Selection = ReturnType<typeof useBlockSelection>

export type EditorDataDeps = Core & Persistence & Blocks & Links & Pages & Inline & Selection & {
  initialBlocks: Block[]
  repairNotice?: string | null
}

/**
 * 编辑器的数据与服务编排（模块化 M1.6/M1.7）：同步派生、AI、媒体、导出、属性、触控、
 * 快捷键、专注与撤销路由。外壳只按顺序组装，不再自己养这些生命周期。
 */
export function useEditorData(deps: EditorDataDeps) {
  const {
    store, snapshot, revision, registry, prefs, libraryFilter, activePageId, activeBlockId, 
    selectedIds, setView, setActivePageId, setRefPanelOpen, setAiPanelOpen, setBriefOpen, setFocusMode,
    openDialog, closeDialog, notify, persist, reloadFromStore, flushPendingPersist, cancelPendingPersist,
    replaceBlockText, moveBlocksStep, requestDeleteSelection, copySelectionToClipboard, cutSelection,
    createPage, openPage, openSettingsView, closeSettingsView, updateRegistry,
    aiPanelOpen, refPanelOpen, briefOpen, focusMode, menu, dialog, narrow, drawerOpen, sidebarShown,
    toggleSidebar, togglePageList, openExternalLinkDialog, exitSelection,
    settingsOpen, storage, assetPort, setAssetNames, setSaveState, setRevision,
    compact, settingsLevel, setSettingsLevel, view, closeMenu, closeDrawer, updatePrefs,
    editorRef, aiConfig, registryRef, syncEditorChanges, exportChoice, refreshPinyinRef, setAssetsReady,
    findQuery, includeDeleted, initialBlocks, setSettingsOpen, undoOwnerRef,
  } = deps

  useBackNavigation({ closeOverlay: () => { if (menu) { closeMenu(); return true } if (dialog) { closeDialog(); return true } if (aiPanelOpen) { setAiPanelOpen(false); return true } if (refPanelOpen) { setRefPanelOpen(false); return true } if (briefOpen) { setBriefOpen(false); return true } return false }, settingsOpen, settingsOnSubPage: compact && settingsLevel === 'page', backToSettingsList: () => setSettingsLevel('list'), closeSettings: closeSettingsView, trash: view === 'trash', leaveTrash: () => setView('editor'), focusMode, exitFocus: () => setFocusMode(false), drawerOpen, closeDrawer, pageColumnHidden: compact && activePageId !== null && prefs.listColumnCollapsed, backToLibrary: () => { exitTouchEdit(); closeMenu(); setAiPanelOpen(false); setRefPanelOpen(false); setView('editor'); updatePrefs({ ...prefs, listColumnCollapsed: false }) } })

  const sidebarStats = useMemo(() => {
    void revision
    return buildSidebarStats(store.read().values())
  }, [store, revision])
  const { openPurgeDialog, purgePages, movePageToTrash, restorePage } = useTrashActions({
    store, snapshot, activePageId, storage, assetPort, flushPendingPersist, reloadFromStore,
    setAssetNames, setSaveState, setActivePageId, setView, setRefPanelOpen, setRevision,
    openDialog, notify, persist,
  })

  /**
   * 还债 #2 模块③：AI 块的一生（`ui/useAiRuntime.ts`）——生成 / 停止 / 失败 / 采用 / 丢弃、
   * 助手面板的问答、载入时收口残留的「生成中」。喂给它的都是外壳已有的通路（落盘、整篇重建、
   * 选区清空、文本写回），模块本身不认识界面；入口的「读什么 / 落哪」仍由调用方用 `aiSourcePlan` 声明。
   */
  const {
    aiReady, aiState, aiAnswers, aiQuestions, hasGeneratingAiBlock, generatingRef,
    caretBlockInPage, cancelAi, runAi, askAi, insertAnswerAsBlock, acceptAiBlock, discardAiBlock,
  } = useAiRuntime({
    store, snapshot, activePageId, getEditor: () => editorRef.current, panelOpen: aiPanelOpen, aiConfig, replaceBlockText, persist,
    reloadFromStore, notify, exitSelection, openSettings: openSettingsView,
  })

  const tagSummaries = useMemo<TagSummary[]>(() => {
    const blocks = [...snapshot.values()].filter((block) => !block.deleted)
    return registry.tags
      .map((tag) => ({ id: tag.id, name: tag.name, count: blocks.filter((block) => block.tags.includes(tag.id)).length }))
      .filter((tag) => tag.count > 0)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-CN'))
  }, [registry.tags, snapshot])

  /**
   * V2c：检索端口（`03` §15.2）。桌面走 SQLite FTS5、浏览器通道走内存子串扫描，语义一致。
   * **引用要稳定**（⌘K 面板的检索 effect 依赖它），所以快照通过 ref 现读——不然每敲一个字都会重挂。
   */
  const snapshotRef = useRef(snapshot)
  // 镜像 Latest 值到 ref：渲染期写 ref 违反并发语义，挪到提交后（消费方都是事件/回调时点，读法不变）。
  useEffect(() => { snapshotRef.current = snapshot })
  // .current 在检索回调里才读（不在渲染期）；经 ref 现读是**刻意**的端口稳定设计（⌘K 的 effect 依赖它）。
  // eslint-disable-next-line react-hooks/refs
  const searchPort = useMemo(() => createDefaultSearchPort(() => snapshotRef.current, () => registryRef.current), [registryRef, snapshotRef])

  /**
   * 0.5 数据安全（`03` §15.9）：**本地快照**（自动、同盘）× **整库导出**（手动、可带走）×
   * **异地副本引导**（把同步位置指到云盘）——三者互补，让每种丢失都有恢复路径。
   * 启动时自动留一份当天的快照；设置里能看、能补、能恢复。失败只 toast 一次，绝不打扰写作。
   */
  const backupPort = useMemo(() => createDefaultBackupPort(), [])



  // 媒体分类（`mediaKindOf`）与扩展名→MIME（`guessMimeFromName`）的判据住在域层 `domain/block.ts`
  // ——它们属于 payload 自己的家族，粘贴 / 拖入 / 菜单三条管道共用同一份。

  /** 图片尺寸（占位卡按它留位）；解不出来就不写，CSS 按 16:9 兜底。 */

  /**
   * Markdown 导出的落盘端口（13-导出与媒体设计（已归档） §7；`R09-EXPORT-5`）。
   * 序列化在域层纯函数里，这里只做「拿已有文件名 → 算计划 → 落盘 → 如实报路径」。
   */
  const exportPort = useMemo(() => createDefaultExportPort(), [])

 // 媒体三管道 + Markdown 导入 + 嵌入块来源住在 `ui/useMediaImport.ts`（外壳拆分第六刀之一，）——
  // 这里只接线；与编辑器的耦合收成两个能力（光标锚点 / 镜像落盘），那个模块不 import 内核。
  const fileChannel = useMemo(() => createDefaultFileChannelPort(), [])
  /** 文件通道的两个活入口（`T-18`）：选文件复用**拖入的同一条路**（`importDroppedPaths`），选文件夹走 `importFolder`。 */
  const fileOps = {
    canPickFile: fileChannel.capabilities.pickFile,
    canPickFolder: fileChannel.capabilities.pickFolder,
    canSaveAs: fileChannel.capabilities.saveAs,
    onPickFiles: () => { void (async () => { const picked = await fileChannel.pickFile(['md', 'txt', 'zip']); if (picked) await importDroppedPaths([picked.ref]) })() },
    onPickFolder: () => { void (async () => { const dirPath = await fileChannel.pickFolder(); if (dirPath) await importFolder(dirPath) })() },
  }
  const { insertMediaBlock, importDroppedPaths, importFolder, importDroppedFiles, insertEmbedPlaceholder, applyEmbedSource, clearEmbedSource, pickMediaFile } = useMediaImport({
    currentAnchorId: () => { const editor = editorRef.current; return editor ? currentBlockId(editor) : null },
    syncEditorNow: () => { const editor = editorRef.current; if (editor) syncEditorChanges(editor, editor.getEditorState()) },
    assetPort, exportPort, store, registry, updateRegistry, persist, reloadFromStore, openPage, notify, setAssetNames,
  })

  /**
   * 丢弃「等落盘的那一份」：恢复快照前要用（`ui/useDataActions.ts`）——那两个 ref 是外壳保存队列的
   * 家产，所以这个能力由壳提供（语义与原实现一致：清定时器 + 清 pending 快照）。
   */
  /** 导出页三个入口（`T-18` 第三刀）：范围解析成 `ExportScope` 后走同一条执行——`destination` 只多一步「问落点」。 */
  function runExportFromPage(destination?: { pick: 'saveAs' | 'folder' }) {
    if (exportChoice.kind === 'page') {
      if (!activePageId) { notify('先打开一个页面再导出'); return }
      void runMarkdownExport({ kind: 'page', pageId: activePageId }, destination)
      return
    }
    if (exportChoice.kind === 'tag') {
      const tagId = exportChoice.tagId ?? exportTagChoices()[0]?.id ?? null
      if (tagId === null) { notify('还没有可导出的标签'); return }
      void runMarkdownExport({ kind: 'tag', tagId }, destination)
      return
    }
    void runMarkdownExport({ kind: 'all' }, destination)
  }

  const { exportTagChoices, runMarkdownExport, exportBusy, refreshPinyin, blockTitleForAsk, backupSummary } = useDataActions({
    store, registry, searchPort, backupPort, exportPort, assetPort, fileChannel, initialBlocks, settingsOpen, notify, closeDialog, cancelPendingPersist,
  })
  // 同 snapshotRef：镜像挪到提交后。
  useEffect(() => { refreshPinyinRef.current = refreshPinyin })

  // 资产端口：开局问一次目录 + 读一次已有文件名（判「文件缺失」）；就绪后重建一次编辑器，
  // 好让媒体块把显示地址挂上（装饰层读端口，不在渲染时问）。
  useEffect(() => {
    let alive = true
    void assetPort
      .prepare()
   // 启动扫一次孤儿资产（）：读不到名册就什么都不删，见 `application/assetSync.ts`。
      .then(() => cleanupUnreferencedAssets(assetPort, store.read().values()))
      .then(() => assetPort.listNames())
      .then((names) => {
        if (!alive) return
        setAssetNames(new Set(names))
        setAssetsReady(true)
        reloadFromStore()
      })
      .catch(() => undefined)
    return () => { alive = false }
    // 刻意只跟 assetPort 走：重挂会重复问目录、重扫孤儿资产（setter 恒稳）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetPort])

  // 桌面拖入：Tauri 的拖放事件给**路径**（Windows 上 HTML5 drop 拿不到文件）。
  useEffect(() => {
    let stop: (() => void) | null = null
    let alive = true
    void assetPort
      .watchDrops((paths) => { void importDroppedPaths(paths) })
      .then((unlisten) => { if (alive) stop = unlisten; else unlisten() })
      .catch(() => undefined)
    return () => { alive = false; stop?.() }
  }, [assetPort, importDroppedPaths])

  // 浏览器预览拖入：HTML5 drop 给的是**字节**（与上面的桌面路径各管一段）。
  useEffect(() => {
    const isEditorDrop = (target: EventTarget | null) => target instanceof HTMLElement && target.closest('.doc-col') !== null
    const onDragOver = (event: DragEvent) => {
      if (!isEditorDrop(event.target)) return
      if (![...(event.dataTransfer?.items ?? [])].some((item) => item.kind === 'file')) return
      event.preventDefault()
    }
    const onDrop = (event: DragEvent) => {
      const files = [...(event.dataTransfer?.files ?? [])]
      if (files.length === 0 || !isEditorDrop(event.target)) return
      event.preventDefault()
      void importDroppedFiles(files)
    }
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('drop', onDrop)
    return () => {
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('drop', onDrop)
    }
  // 监听器闭包真读 importDroppedFiles：身份变化时重挂重注（卸载函数已正确清理）。
  }, [importDroppedFiles])

  /**
   * V2c 有来源问答：这一次提问的范围（来自 ⌘K 检索命中的块）。null = 基于本篇（默认）。
   * 它是**界面状态、不落库**：范围标签（「基于检索命中的 N 块」）只活在界面上——领域里的来源范围
   * 仍是既有两个取值，新增加载取值会牵动载入白名单（`R09-AIB-11` 的教训）。
   */
  const [searchScope, setSearchScope] = useState<{ sourceIds: string[]; label: string } | null>(null)

  /**
   * V2c 补（台账 D-016）：**这次问答的答案存到哪**（`R09-AIPANEL-2/6b`）。
   *
   * 与范围是两件事：页面内入口（快捷指令 / 选中文字 / 块菜单）默认「当前页」——那是用户当下的上下文；
   * 从 ⌘K 跨页范围进来时默认「新建一页」——**不猜**。此前的实现是落到 `resolveAiAnchor` 的兜底上：
   * 有光标就落当时打开的那一页、没光标就落「最后一条搜索命中」所在的页，而界面一个字都不说。
   */
  const [askTargetMode, setAskTargetMode] = useState<'current' | 'new'>('current')

  /**
   * V2c：索引状态（`R09-SEARCH-6` / `R09-SET-13`）——设置里那一行读它。
   * 每 2 秒回读一次：索引规模是**派生数据**，打字与删除都会改它，读到旧值就等于在骗人；
   * 读失败不当错误（退回 null，界面显示「读取中」），检索坏掉不该影响设置页。
   */
  const [indexStatus, setIndexStatus] = useState<SearchIndexStatus | null>(null)
  useEffect(() => {
    let alive = true
    const read = () => { void searchPort.status().then((next) => { if (alive) setIndexStatus(next) }).catch(() => {}) }
    read()
    const timer = setInterval(read, 2_000)
    return () => { alive = false; clearInterval(timer) }
  }, [searchPort])

  /**
   * 启动回填（老库 / 新库首次）：拼音由前端算、Rust 不碰，覆盖率不足时补一遍。
   * **分片调度住 `ui/usePinyinBackfill.ts`**——按时间预算切片、片间让出空闲
   * （`D-042`：固定 300 块一片的同步转换在真机上单片 1–3.7s，撞上打字就是 ≈5s 停顿）。
   */
  usePinyinBackfill({
    needsBackfill: indexStatus !== null && indexStatus.pinyinIndexed < indexStatus.indexed,
    blocks: () => [...store.read().values()],
    refresh: refreshPinyin,
  })

 // 派生数据住在 `ui/useDerivedData.ts`（外壳拆分第七刀，）——外壳只把输入接进来；
  // 各条目的依赖清单与原实现逐条一致（含 `revision` 这种「靠计数强制重算」的驱动）。
  const {
    trashEntries, libraryCards, visibleCards, recentPages, activePage, activeBlock,
    aiGridGates, outlineEntries, findHits, propertyRows, tagUsage, propertyUsage,
    backlinkCards, outgoingCards, pageStats,
  } = useDerivedData({
    store, revision, snapshot, registry, prefs, libraryFilter,
    selectedIds, activeBlockId, activePageId, findQuery, includeDeleted,
  })
  const filterCount = activeFilterCount(libraryFilter)
  /** 条件里只有「含所选」的一个标签时，侧栏那个标签高亮（两处同步的可见形态）。 */
  const activeLibraryTagId = libraryFilter.tagMode === 'include' && libraryFilter.tagIds.length === 1 ? libraryFilter.tagIds[0] : null


  /**
   * 三层工具栏共用的格式状态（docs/09 §6.9 的作用域表）：**由编辑器的更新事件驱动**，不看 `revision`。
   * 靠 revision（保存队列回调）读状态会慢一拍——点完最后一个格式，按钮不亮，用户看到的就是「工具栏没联动」。
   * - `selection`：选区 / 光标处的格式（折叠光标时就是「接下来输入的字」的格式）——格式栏与文本工具栏用；
   * - `blocks`：选中块的整块格式——块工具栏用。
   */
  const [formatSnapshot, setFormatSnapshot] = useState<{ selection: TextFormatType[]; blocks: TextFormatType[] }>({ selection: [], blocks: [] })
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const read = () => {
      const next = readFormatSnapshot(editor, selectedIds)
      setFormatSnapshot((current) => sameFormats(current, next) ? current : next)
    }
    read()
    return editor.registerUpdateListener(() => { read() })
    // editorRef 是 ref：身份恒稳，列进 deps 满足规则（零行为变化）。
  }, [editorRef, selectedIds])

  /** 块工具栏的按下态：作用于整块，状态取自被选中的块。 */
  const activeFormatsValue = formatSnapshot.blocks

 // 主 keydown 与 ⌘Z 路由住在 `ui/useEditorShortcuts.ts`（外壳拆分第五刀，）——这里只接线；
  // 依赖清单与注册契约（主 keydown 随状态重装 / ⌘Z 只注册一次）在那个文件里原样保留。
  // 触控编辑态（`10` §6.3，compact 档）：动作与窄口都在 `ui/useTouchEdit.ts`，只有名字行落位要真编辑器类型。
  const { touchEditId, activateTouchBlock, followTouchBlock, touchBlankTap, exitTouchEdit } = useTouchEdit({
    compact, store, revision, editorRef, exitSelection,
    focusNameRow: (containerId) => { const editor = editorRef.current; if (editor) focusNameRow(editor, containerId) },
  })

  useEditorShortcuts({
    prefs, dialog, menu, aiPanelOpen, refPanelOpen, briefOpen, selectedIds, focusMode, view, activePageId, libraryCards, narrow, drawerOpen, sidebarShown,
    toggleSidebar, togglePageList, moveBlocksStep, deleteSelection: requestDeleteSelection, copySelectionToClipboard, cutSelection,
    openExternalLinkDialog, createPage, openPage, exitSelection, setFocusMode, setAiPanelOpen, setRefPanelOpen, setBriefOpen, notify, openDialog, closeDialog, toggleSettings: () => { setSettingsOpen((open) => !open); setSettingsLevel('list') /* θ3：开合都归零（函数式更新 ⇒ 不吃过期闭包） */ }, touchEditing: deps.compact && touchEditId !== null, exitTouchEdit,
  })

  // 专注模式：body.is-focus 隐藏顶栏、格式栏与属性钉住区（docs/09 §6.7）。
  useEffect(() => {
    document.body.classList.toggle('is-focus', focusMode)
    // 安卓壳（真机）挂个类：桌面窗口控件不渲染（docs/10 §七同族）——按 UA 判，够用且不动依赖。
    if (/Android/i.test(navigator.userAgent)) document.body.classList.add('is-android')
    return () => document.body.classList.remove('is-focus')
  }, [focusMode])

  const { historyStep } = useUndoRouting({ editorRef, store, reloadFromStore, undoOwnerRef })

  // 分栏里的页面列：窄屏（<1080px，放不下 侧栏+页面列+正文）自动隐藏，
  // 与「两栏都折叠」的放大态长得一样，⌘⇧\ 仍可手动开关（docs/09 §八）。
  // 页面栏在任何宽度都要能打开：宽屏是并排的一栏，窄屏是覆盖式抽屉（docs/09 §八）。
  // 之前把整个渲染条件挂在 wideEnoughForColumn 上，窄屏时连抽屉都不渲染，侧栏开关也跟着消失。
  const pageColumnVisible = deps.view === 'editor' && !focusMode && !deps.prefs.listColumnCollapsed


  return {
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
  }
}
