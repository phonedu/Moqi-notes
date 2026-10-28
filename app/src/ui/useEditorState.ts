import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { LexicalEditor } from '@moqi/editor'
import { DomainStore } from '../application/store'
import { emptyRegistry, migratePlainTags } from '@moqi/editor'
import type { Block, MetadataRegistry } from '@moqi/editor'
import { editorNodes, loadBlocksIntoEditor } from '@moqi/editor'
import { EDITOR_THEME } from '@moqi/editor'
import { resolveFeatures, type EditorFeature, type ResolvedFeatures } from '@moqi/editor'
import type { AiConfig, TransactionStoragePort } from '../composition'
import { createDefaultAssetPort, createDefaultWindowShell } from '../composition'
import { useBreakpoints } from './useBreakpoints'
import { useWindowMinSize } from './useWindowMinSize'
import { useNotice } from './useNotice'
import { useOverlays } from './useOverlays'
import { exclusiveOverlays, onBreakpointCrossed, sidebarVisible, toggledSidebar } from './panelLayout'
import { firstPageId } from './shellSupport'
import { emptyFilter, type LibraryFilter } from './libraryFilter'
import type { SaveState, ViewKind } from './types'
import type { SettingsLevel, SettingsSection } from './SettingsView'
import type { UndoOwner } from './undoRouting'
import { applyAppearance, loadAiConfig, loadUiPrefs, saveUiPrefs, type UiPrefs } from './uiPrefs'

/**
 * 编辑器外壳的界面状态（模块化 M1.7）。
 *
 * 这里只放「状态 + 开关 + 纯界面派生」：不做领域写入、不碰保存队列、不读编辑器内容。
 * 命令 hook 与数据 hook 通过返回值拿到 setter / 开关；外壳只负责按顺序组装。
 */
export function useEditorState(initialBlocks: Block[], storage: TransactionStoragePort, repairNotice?: string | null) {
  const store = useMemo(() => new DomainStore(initialBlocks), [initialBlocks])

  // ---------- 界面状态 ----------
  const [view, setView] = useState<ViewKind>('editor')
  /** 设置弹窗的分区（受控：上下文快捷要从外面切到导出页——`EXPORT-MENU-1`）。 */
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('ai')
  /** 批 ζ：设置层级单源（列表页 / 子页）——屏上统一标题栏与系统返回共用它。 */
  const [settingsLevel, setSettingsLevel] = useState<SettingsLevel>('list')
  /** 设置是**居中模态**（`R09-SET-16`）：不再是视图——`view` 只剩编辑器与回收站。 */
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** 导出页的范围选择（受控，同上）：标签 id 只在 kind === 'tag' 时有意义。 */
  const [exportChoice, setExportChoice] = useState<{ kind: 'page' | 'tag' | 'all'; tagId: string | null }>({ kind: 'all', tagId: null })
  const [prefs, setPrefs] = useState<UiPrefs>(() => loadUiPrefs())
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [revision, setRevision] = useState(0)
  const snapshot = useMemo(() => {
    void revision
    return store.snapshot()
  }, [store, revision])
  // 编辑器首屏承载的是第一页（见 initialConfig 的 editorState）：activePageId 一开始就指向它，
  // 否则顶栏标题、属性钉住条、页面列表高亮与「编辑器空态」都会以为当前没有页面。
  const [activePageId, setActivePageId] = useState<string | null>(() => firstPageId(store.read()) ?? null)
  // 同步轮询跑在 `setInterval` 捕获的陈旧闭包里，读不到当下的 `activePageId`。
  // `reloadFromStore(activePageIdRef.current)` 就是给这种调用点用的（见它的注释）。
  const activePageIdRef = useRef<string | null>(activePageId)
  useEffect(() => { activePageIdRef.current = activePageId }, [activePageId])
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null)
  const [registry, setRegistry] = useState<MetadataRegistry>(() => emptyRegistry())
  /** A2：检索端口在挂载时捕获一次，注册表却会变（属性改名 / 加选项）——按 ref 读**当下**这一份。 */
  const registryRef = useRef(registry)
  registryRef.current = registry
  /** V2c：页面库的筛选条件（`09-桌面端UI规范` §4.2）。**单一所有者**——筛选面板与侧栏标签点击都改这一份。 */
  const [libraryFilter, setLibraryFilter] = useState<LibraryFilter>(emptyFilter)

  /**
   * 侧栏点标签 = 筛选条件里的「含所选 + 这一个标签」（`R09-FILT-7`：面板与侧栏两处同步）；
   * 再点同一个标签 = 取消这个条件（与面板里取消勾选同一件事）。
   */
  function toggleTagFilter(tagId: string | null) {
    setLibraryFilter((current) => (tagId === null || current.tagIds.includes(tagId)
      ? { ...current, tagMode: 'any', tagIds: [] }
      : { ...current, tagMode: 'include', tagIds: [tagId] }))
    setView('editor')
  }

  /**
   * 侧栏「星标」（`R09-PRIN-1`，活原型 `#navStar`）：把**同一个页面库**的筛选条件拨到「只看星标」。
   * 与 `toggleTagFilter` 同一个做法——侧栏只改筛选条件那一份状态，不另立视图；
   * 再点一下 = 取消（与筛选面板里取消勾选同一件事）。
   */
  function toggleStarFilter() {
    setLibraryFilter((current) => ({ ...current, star: current.star === 'starred' ? 'any' : 'starred' }))
    setView('editor')
  }

  const [refPanelOpen, setRefPanelOpen] = useState(false)
  const [aiPanelOpen, setAiPanelOpen] = useState(false)
  const [briefOpen, setBriefOpen] = useState(false)
  const { menu, dialog, openMenu, closeMenu, openDialog, closeDialog } = useOverlays()
  const { notify, band } = useNotice()
  const [focusMode, setFocusMode] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [includeDeleted, setIncludeDeleted] = useState(false)
  /**
   * 侧栏的「意图」与「呈现」分开（docs/09 §八）：`prefs.sidebarCollapsed` 是用户意图，
   * 只由用户动作改写；窄屏下侧栏渲染成覆盖式抽屉，抽屉此刻是否弹出是呈现层状态。
   * 规则与用例见 `ui/panelLayout.ts`——窗口宽度变化只改呈现，不改设置。
   */
  const [drawerOpen, setDrawerOpen] = useState(false)
  // 断点三问（docs/08 四档表 / docs/09 §八）：宽度决定版面档，跨 ≤899px 只重置抽屉「呈现」、绝不改写意图。
  const { narrow, compact, wideEnoughForColumn } = useBreakpoints(useCallback(() => setDrawerOpen(onBreakpointCrossed().drawerOpen), []))
  const sidebarShown = sidebarVisible({ narrow, collapsed: prefs.sidebarCollapsed, drawerOpen })
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(null)
  // 默认配置**留空**（aiReady 要求三项全非空 ⇒ 未配置 = AI 入口不亮）：默认值一旦写死具体模型名
 // 就会随服务端下线静默过时（ deepseek-chat 下线报错）；填什么由用户在设置里定。
  const [aiConfig, setAiConfig] = useState<AiConfig>(() => loadAiConfig() ?? { baseUrl: '', apiKey: '', model: '' })

  const editorRef = useRef<LexicalEditor | null>(null)
  /**
   * M5 可选能力：产品默认全开；验收 / 外部宿主可经 `localStorage['moqi:features-off']`（逗号清单，
   * 键 = `EditorFeature`）关灯——判据住在包（`editor/features.ts`），「关掉就不出现」由各入口消费。
   * 启动读一次（与 uiPrefs 同款口径：不给运行中翻转留状态）。
   */
  const features = useMemo<ResolvedFeatures>(() => {
    const off = typeof localStorage === 'undefined' ? '' : localStorage.getItem('moqi:features-off') ?? ''
    const offList = off.split(',').map((item) => item.trim()).filter(Boolean) as EditorFeature[]
    const offMap = Object.fromEntries(offList.map((key) => [key, false])) as Partial<Record<EditorFeature, boolean>>
    return resolveFeatures({ ai: true, media: true, backlinks: true, properties: true, ...offMap })
  }, [])
  const docColRef = useRef<HTMLDivElement | null>(null)
  const captureEditor = useCallback((editor: LexicalEditor | null) => { editorRef.current = editor }, [])
  /** 正文根元素（Lexical 的 contentEditable）：选区模块量浮层落点、刷选中样式都用它；引用稳定。 */
  const editorRoot = useCallback(() => editorRef.current?.getRootElement() ?? null, [])
  /**
   * 三栏宽度拖拽（docs/09 §八）：按住分隔条改宽度，松手写偏好。
   * 只改 CSS 变量，不动布局结构——编辑器实例与选区都不受影响。
   */
  const startResize = (target: 'sidebar' | 'pagecol') => (event: ReactMouseEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = target === 'sidebar' ? prefs.sidebarWidth : prefs.pagecolWidth
    const min = target === 'sidebar' ? 200 : 300
    const max = target === 'sidebar' ? 420 : 620
    const onMove = (move: MouseEvent) => {
      const next = Math.min(max, Math.max(min, Math.round(startWidth + (move.clientX - startX))))
      setPrefs((current) => ({ ...current, [target === 'sidebar' ? 'sidebarWidth' : 'pagecolWidth']: next }))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.classList.remove('plan')
      setPrefs((current) => { saveUiPrefs(current); return current })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.classList.add('plan')
  }
  const refreshPinyinRef = useRef<(blocks: Map<string, Block>) => Promise<unknown>>(async () => undefined)
  const undoOwnerRef = useRef<UndoOwner>('domain')
  const assetPort = useMemo(() => createDefaultAssetPort(), [])
  const [assetsReady, setAssetsReady] = useState(false)
  /** `assets/` 下真实存在的磁盘名——判「文件缺失」（数据合法、界面降级）。 */
  const [assetNames, setAssetNames] = useState<Set<string>>(new Set())
  /** 关闭流程是否已经启动：拦下的系统关闭请求由我们自己收尾，放行第二次触发，避免绕圈。 */
  const closingRef = useRef(false)

  // 载入自愈结果提示一次（断链已被清理，用户需要知道数据被动过）。
  useEffect(() => {
    if (repairNotice) notify(repairNotice)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 主题：浅色 / 深色 / 跟随系统
  // 外观 = 主题两轴 + 排版三轴：任何一项变了都重新施加（只写 <html> 上的属性，不逐条覆盖 CSS）。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { applyAppearance(prefs) }, [prefs.themeId, prefs.mode, prefs.fontSize, prefs.lineHeight, prefs.columnWidth])

  // 窗口最小宽度：读数 × 判据 → 平台命令（`docs/09` §八 `R09-RESP-19`；判据在 `minWindowSize.ts`）。接线两行。
  useWindowMinSize(useMemo(() => createDefaultWindowShell(), []))

  /** 窄屏抽屉在跳转或点遮罩后收起：用户动作同时记下意图，拖宽后它不再自己冒出来。 */
  function closeDrawer() {
    if (!narrow) return
    setDrawerOpen(false)
    setPrefs((current) => {
      if (current.sidebarCollapsed) return current
      const next = { ...current, sidebarCollapsed: true }
      saveUiPrefs(next)
      return next
    })
  }

  /**
   * 开右侧面板（AI / 引用 / 属性）：先收起**会盖住它的**两个抽屉，再开这一个（`docs/09` §四，台账 D-017）。
   *
  * 反例就是 用户实测的那个场面：页面库抽屉开着 → 它头部的 🔍 → ⌘K → 「就这些问 AI」，
   * 面板确实开出来了，但开在遮罩底下——点面板的任何位置命中的都是遮罩（等于「把页面库关了」），
   * 于是看起来像「必须先收起页面库，AI 面板才能用」。宽屏下栏与面板并排，这几句是无副作用的收尾。
   */
  /** 两个抽屉各自的判据不同：侧栏是 ≤899px、页面列是 ≤1279px（按一个「窄屏」写死会在 900–1279 漏收页面列）。
      移动骨架（4a）：compact 档的页面库是**首页视图**（`10` §三）——不是覆盖层，侧栏开合不再连带收它。 */
  const overlayDrawers = () => ({ sidebar: narrow, listColumn: !wideEnoughForColumn && !compact })

  function openSidePanel(kind: 'ai' | 'ref') {
    // M5：能力关闭时入口全部不出现，这里再拦一道（防快捷键 / 残留状态把关掉的面板叫出来）。
    if (kind === 'ai' && !features.ai) return
    if (kind === 'ref' && !features.backlinks) return
    const next = exclusiveOverlays('panel', overlayDrawers())
    if (next.listColumnCollapsed !== null && next.listColumnCollapsed !== prefs.listColumnCollapsed) {
      updatePrefs({ ...prefs, listColumnCollapsed: next.listColumnCollapsed })
    }
    if (drawerOpen) setDrawerOpen(false)
    if (kind === 'ai') setAiPanelOpen(true)
    else setRefPanelOpen(true)
  }

  /** 开抽屉（侧栏 / 页面列）：反过来先收掉全部右侧面板（窄屏下它们都是覆盖层）。 */
  function openDrawerOverlay(kind: 'sidebar' | 'listColumn') {
    const next = exclusiveOverlays(kind, overlayDrawers())
    setAiPanelOpen(false)
    setRefPanelOpen(false)
    if (next.drawerOpen) setDrawerOpen(true)
    if (next.listColumnCollapsed !== null && next.listColumnCollapsed !== prefs.listColumnCollapsed) {
      updatePrefs({ ...prefs, listColumnCollapsed: next.listColumnCollapsed })
    }
  }

  /** 侧栏开关：窄屏切的是抽屉（呈现），同时把用户意图记下来；宽屏只切意图（docs/09 §八）。 */
  function toggleSidebar() {
    const next = toggledSidebar({ narrow, collapsed: prefs.sidebarCollapsed, drawerOpen })
    if (narrow && next.drawerOpen) openDrawerOverlay('sidebar')
    else setDrawerOpen(next.drawerOpen)
    // 窄屏下侧栏与页面列表互斥：开抽屉的同时收起页面列表（docs/09 §14.1）；compact 档首页是视图不是抽屉（4a），不动它。
    updatePrefs({ ...prefs, sidebarCollapsed: next.collapsed, ...(narrow && next.drawerOpen && !compact ? { listColumnCollapsed: true } : {}) })
  }

  /** 页面列表开关：窄屏下与侧栏互斥（开一个自动收另一个，docs/09 §14.1）。 */
  function togglePageList() {
    const collapsed = prefs.listColumnCollapsed
    if (narrow && collapsed) openDrawerOverlay('listColumn')
    updatePrefs({ ...prefs, listColumnCollapsed: !collapsed, ...(narrow && collapsed ? { sidebarCollapsed: true } : {}) })
  }

  function updatePrefs(next: UiPrefs) {
    setPrefs(next)
    saveUiPrefs(next)
  }

  /**
   * 按增量改偏好（设置页那几组档位走这条）：用**函数式更新**读当前值——
   * 连点两个档位时，渲染期闭包里的 prefs 是旧的，{ ...prefs, ...patch } 会把前一次改动盖掉
  * （ 视觉批 accept 实测：连切主题 + 深色 + 特大，只有最后一下留下）。
   */
  function patchPrefs(patch: Partial<UiPrefs>) {
    setPrefs((current) => {
      const next = { ...current, ...patch }
      saveUiPrefs(next)
      return next
    })
  }

  useEffect(() => {
    let active = true
    void storage.loadMetadata()
      .then((loaded) => { if (active) setRegistry(migratePlainTags(store.read().values(), loaded ?? emptyRegistry())) })
      .catch(() => { if (active) setRegistry(emptyRegistry()) })
    return () => { active = false }
  }, [storage, store])

  const initialConfig = useMemo(() => ({
    namespace: 'moqi-project-b-editor',
    nodes: editorNodes,
    // 行内格式的主题类（docs/09 §6.10）：Lexical 一个文本节点只渲染一个标签，
    // 斜体、删除线、与加粗同时存在的高亮只能靠类名表达，不配主题就是「加了没反应」。
    theme: EDITOR_THEME,
    onError(error: Error) { throw error },
    editorState(editor: LexicalEditor) {
      // 编辑器一次只承载当前页面子树；页面库是入口，编辑器是单页工作面。
      const pageId = firstPageId(store.read())
      if (pageId) loadBlocksIntoEditor(editor, store.subtree(pageId))
    },
  }), [store])

  // ---------- 属性注册表 ----------
  function updateRegistry(next: MetadataRegistry) {
    setRegistry(next)
    void storage.saveMetadata(next)
  }

 /** 打开设置：导出范围回默认「全部页面」（`EXPORT-MENU-1`）；θ3（）：**一律开在列表页**，子页只由外部指令直落（`openExportPage`）。 */
  function openSettingsView() {
    setExportChoice({ kind: 'all', tagId: null }); setSettingsLevel('list'); setSettingsOpen(true)
  }
  /** θ3：关闭设置——**层级一并归零**（子页 → 关闭 → 重开 = 列表）。行为只碰稳定 setter ⇒ 闭包过期也安全（旧写法读 `settingsOpen` 就会过期）。 */
  function closeSettingsView() { setSettingsOpen(false); setSettingsLevel('list') }

  /** 上下文快捷：打开设置并落到导出页、预选「当前页面」（`EXPORT-MENU-1`）。 */
  function openExportPage(fromPage: boolean) {
    setExportChoice({ kind: fromPage ? 'page' : 'all', tagId: null }); setSettingsSection('export'); setSettingsLevel('page') // 批 ζ：外部指令直落子页，返回先回列表
    setSettingsOpen(true)
  }

  return {
    store, storage, snapshot, features, view, setView, settingsSection, setSettingsSection, settingsLevel, setSettingsLevel, settingsOpen, setSettingsOpen,
    exportChoice, setExportChoice, prefs, setPrefs, saveState, setSaveState, revision, setRevision,
    activePageId, setActivePageId, activePageIdRef, activeBlockId, setActiveBlockId,
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
  }
}
