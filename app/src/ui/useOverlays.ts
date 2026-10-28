import { useCallback, useEffect, useState } from 'react'
import { anchorOf, type AnchorRect } from './Popover'
import type { LibraryCard, TagSummary } from './types'

/**
 * 浮层栈：**此刻开着哪一个浮层**，以及 **Esc 该退掉哪一层**（`docs/09` §九 `R09-KEY-13`）。
 *
 * 还债 #2 的模块④：2026-10-04 从 `EditorShell.tsx` 搬出来，**行为零变化**
 * （安全网 = `accept:R09-BEDIT-9`（卡片菜单三条关闭路径 / 视图门住）、
 * `accept:R09-KEY-13`（Esc 逐层退出）、`accept:SHELL-FIND-1`（⌘F 自己那层）+ 本文件的纯函数单测）。
 *
 * 为什么值得单独存在：① 「同一时刻只有一个浮层」这件事原来靠 21 处 `setDialog(null)` /
 * 9 处 `setMenu(null)` 各自记得清理，**清理由是规则、散在调用点就容易漏**（视图切换清不干净
 * 那次就是这么来的，用户实测 2026-10-03）；② Esc 的层级顺序是一条**写在规范里的规则**
 * （浮层 → 侧栏面板 → 选区 → 专注），规则该有名字、有单测、能被引用，而不是埋在 keydown 的
 * if 链里。**渲染仍留在 `EditorShell`**——各个菜单组件的 props 来自外壳的领域数据与动作，
 * 把它们一起搬进来只会得到一个 30 个 prop 的传话筒（更深的那一刀要等弹窗有了表征测试再动）。
 *
 * 弹窗与菜单的差别（2026-10-04 实测后写在这里，免得下次又去「修」一遍）：**弹窗是模态的**——
 * 遮罩接管外边那一下（`Dialogs.tsx` 的 `.mask` 在 mousedown 时关闭自己），所以「弹窗跨视图残留」
 * 走不到：点侧栏「设置」的第一下只关弹窗、视图不动，第二下才切过去。菜单不一样，它要浮在
 * 列表与正文旁边、不挡别处，所以**必须**由「离开编辑器就清掉」那条 effect 收拾。
 */
export type MenuState =
  | { kind: 'outline' | 'more' | 'blockType' | 'insert' | 'filter'; anchor: AnchorRect; element: HTMLElement | null }
  /** 块菜单（`R09-BEDIT-10`）：块浮动工具栏的 `⋯ 更多` 与**右键块体 / 把手**打开同一份清单；`blockIds` 是此刻作用的目标块。 */
  | { kind: 'blockMenu'; anchor: AnchorRect; element: HTMLElement | null; blockIds: string[] }
  /** 锚在列表里的菜单（页面库卡片 ⋯ / 侧栏标签 ⋯）：位置由 `useFloatingAnchor` 跟着锚点重测。 */
  | { kind: 'card'; anchor: AnchorRect; element: HTMLElement | null; card: LibraryCard }
  | { kind: 'tag'; anchor: AnchorRect; element: HTMLElement | null; tag: TagSummary }

export type DialogState =
  | { kind: 'find' }
  /** V2c：⌘K 全局搜索（`R09-SEARCH-1`）。它跨页面，所以归弹窗这一层、不归编辑器浮层。 */
  | { kind: 'search' }
  | { kind: 'keyboard' }
  | { kind: 'stat' }
  | { kind: 'addProperty' }
  | { kind: 'deletePage'; pageId: string; name: string }
  /** V2b：回收站的「从本机彻底删除」/「清空回收站」共用一个确认弹窗（`R09-TRASH-6`）。 */
  | { kind: 'purgePages'; pageIds: string[]; names: string[]; losers: string[] }
  /** 「插入外部链接」对话框（`R09-ELINK-1/2`）：带上打开那一刻光标/选区的领域落点（取消不留痕）。 */
  | { kind: 'externalLink'; blockId: string; offset: number; length: number; text: string }
  | { kind: 'closeWindow' }
  /** 多块删除 / 带子块删除：确认后仍可 ⌘Z；单块删除不弹。 */
  | { kind: 'bulkDelete'; ids: string[]; count: number; refs: number; hasChildren: boolean }
  /** 丢弃 AI 块不可逆（不进回收站）；动作前确认。 */
  | { kind: 'discardAiBlock'; blockId: string }
  | { kind: 'tagRename'; tag: TagSummary }
  | { kind: 'tagMerge'; tag: TagSummary }
  /** 选好目标标签后的第二段：把影响面写清再执行。 */
  | { kind: 'tagMergeConfirm'; tag: TagSummary; target: { id: string; name: string } }
  | { kind: 'tagRemoveAll'; tag: TagSummary }
  /** 媒体预览（图片灯箱）：只读预览，不改数据。 */
  | { kind: 'mediaPreview'; blockId: string }
  /** 嵌入块的「选择来源页面 / 块」（`R09-BLOCK-24`）：空态卡与 ⋯ 菜单的「更换来源」共用。 */
  | { kind: 'embedSource'; blockId: string }

export function useOverlays() {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)

  /**
   * 打开菜单。**再点同一个触发元素 = 收起**（标准菜单语义；`Popover` 的「点空白关闭」会跳过
   * 触发元素那一下，所以由这里判定）。锚点矩形就是触发元素的视口矩形（`anchorOf` 与浮层共用一个量法）。
   */
  const openMenu = useCallback((kind: MenuState['kind'], element: HTMLElement, extra?: Partial<MenuState>) => {
    setMenu((current) => (current && current.kind === kind && current.element === element
      ? null
      : ({ kind, anchor: anchorOf(element), element, ...extra } as MenuState)))
  }, [])

  const closeMenu = useCallback(() => setMenu(null), [])
  const openDialog = useCallback((next: DialogState) => setDialog(next), [])
  const closeDialog = useCallback(() => setDialog(null), [])

  return { menu, dialog, openMenu, closeMenu, openDialog, closeDialog }
}

/** Esc 能退掉的那几层，顺序即优先级（`docs/09` §九 `R09-KEY-13`）。 */
export type EscapeTarget = 'menu' | 'dialog' | 'aiPanel' | 'refPanel' | 'brief' | 'touchEdit' | 'selection' | 'focus' | 'none'

/**
 * Esc 该退哪一层。**顺序是规则，不是实现细节**：
 * 浮层（菜单 / 弹窗自己处理 Esc）→ 侧栏面板（AI → 引用 → 摘要）→ **触控编辑态** → 选区 → 专注模式。
 * 专注模式下侧栏与面板本就不可见，不能由它们消费 Esc（用户实测 2026-09-29 那次的配套口径）。
 * 返回 `menu` / `dialog` / `none` 时调用方**什么都不要做**：前两者的 Esc 由浮层自己接。
 * 触控编辑态（`10` §6.3）排在选区之前：它内含块选中态，一次 Esc 退出整个编辑态。
 */
export function escapeTarget(state: {
  menuOpen: boolean
  dialogOpen: boolean
  focusMode: boolean
  panels: { ai: boolean; ref: boolean; brief: boolean }
  touchEditing: boolean
  hasSelection: boolean
}): EscapeTarget {
  if (state.menuOpen || state.dialogOpen) return state.menuOpen ? 'menu' : 'dialog'
  if (!state.focusMode) {
    if (state.panels.ai) return 'aiPanel'
    if (state.panels.ref) return 'refPanel'
    if (state.panels.brief) return 'brief'
  }
  if (state.touchEditing) return 'touchEdit'
  if (state.hasSelection) return 'selection'
  if (state.focusMode) return 'focus'
  return 'none'
}

/**
 * Android 系统返回键的**应用内阶梯**（用户 2026-10-12 口径：「直接浮层，上一层；编辑态不用」）：
 * 挂 `window.__moqiBack`，Kotlin 侧（`MainActivity.kt`）的返回键先问它——返回 `true` = 吃掉了；
 * `false` = 谁都不接，交给系统退出应用。**编辑态（touch-edit）与文字选区不接**（那两级留给
 * 界面内的完成/Esc），其余与 Esc 的浮层阶梯同序：
 *   浮层（菜单 / 弹窗 / 三个侧面板）→ 设置 → 回收站 → 专注 → 抽屉 → 编辑器的页面列（回页面库）。
 *
 * 依赖对象每次渲染都是新的引用 ⇒ effect 每渲染重挂一次（赋值 + 删属性，开销可忽略），
 * 换来的是闭包永远拿得到**最新**的那份状态——比一口气凑二十个依赖安全。
 */
export function useBackNavigation(input: {
  /** 浮层那一级：关掉一层返回 true；没有开着的返回 false。 */
  closeOverlay: () => boolean
  settingsOpen: boolean
  /** 批 ζ（2026-10-12）：设置是否停在**子页**（列表页 = false）——子页上按返回要**先回列表**、再关设置
      （一层一个返回；与屏上统一标题栏的返回共走同一条栈）。 */
  settingsOnSubPage: boolean
  backToSettingsList: () => void
  closeSettings: () => void
  trash: boolean
  leaveTrash: () => void
  focusMode: boolean
  exitFocus: () => void
  drawerOpen: boolean
  closeDrawer: () => void
  /** 编辑器里页面列收着（compact 的"点进了一页"）⇒ 返回 = 回页面库。 */
  pageColumnHidden: boolean
  backToLibrary: () => void
}) {
  useEffect(() => {
    const back = () => {
      if (input.closeOverlay()) return true
      if (input.settingsOpen) {
        if (input.settingsOnSubPage) { input.backToSettingsList(); return true }
        input.closeSettings()
        return true
      }
      if (input.trash) { input.leaveTrash(); return true }
      if (input.focusMode) { input.exitFocus(); return true }
      if (input.drawerOpen) { input.closeDrawer(); return true }
      if (input.pageColumnHidden) { input.backToLibrary(); return true }
      return false
    }
    const bridge = window as unknown as { __moqiBack?: () => boolean }
    bridge.__moqiBack = back
    return () => { delete bridge.__moqiBack }
  }, [input])
}
