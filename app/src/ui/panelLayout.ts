/**
 * 面板（侧栏 / 页面列）的「意图 / 呈现」规则（docs/09 §八）。
 *
 * - **意图**：`ui-prefs` 里的 `sidebarCollapsed` / `listColumnCollapsed`——用户希望面板是什么状态，只由用户动作改写。
 * - **呈现**：宽屏是并排一栏；窄屏或放不下三栏时是覆盖式抽屉，此刻是否弹出。
 *
 * 窗口宽度变化只改呈现：把窗口拖窄再拖宽，用户的设置必须原样保留。
 * 此前实现在跨 900px 断点时改写并保存侧栏设置，表现为「我明明折好了，拖一下窗口它自己开了」。
 */

export interface SidebarState {
  /** 当前是否落在窄屏（<900px）。 */
  narrow: boolean
  /** 用户意图：侧栏是否折叠。 */
  collapsed: boolean
  /** 呈现：窄屏抽屉此刻是否弹出（不进 `ui-prefs`，不跨重启）。 */
  drawerOpen: boolean
}

/** 此刻侧栏是否可见：宽屏看意图，窄屏看抽屉。 */
export function sidebarVisible(state: SidebarState): boolean {
  return state.narrow ? state.drawerOpen : !state.collapsed
}

/**
 * 用户点开合开关（原生栏 ☰、`⌘\`、侧栏内的入口）之后的新状态。
 * 窄屏切的是抽屉、宽屏切的是意图；两种都把用户意图记下来，拖宽后照它呈现。
 */
export function toggledSidebar(state: SidebarState): { collapsed: boolean; drawerOpen: boolean } {
  if (state.narrow) {
    const open = !state.drawerOpen
    return { collapsed: !open, drawerOpen: open }
  }
  return { collapsed: !state.collapsed, drawerOpen: false }
}

/** 跨断点的更新量：只重置抽屉呈现，**绝不包含 `collapsed`**（意图不被窗口宽度改写）。 */
export function onBreakpointCrossed(): { drawerOpen: boolean } {
  return { drawerOpen: false }
}

/**
 * 点开一个页面之后，页面列的意图取什么值（docs/09 §八）。
 *
 * 宽屏：页面列是并排一栏——「在右栏打开」就该让它显示出来；
 * 窄屏 / 放不下三栏：它是覆盖式抽屉——收起它，否则抽屉会一直盖着刚打开的那一页。
 */
export function listColumnOnOpen(columnFits: boolean): boolean {
  return !columnFits
}

/** 窄屏下会互相盖住的那三个东西：侧栏抽屉、页面列抽屉、右侧面板（AI / 引用 / 属性）。 */
export type OverlayKind = 'sidebar' | 'listColumn' | 'panel'

/**
 * **覆盖层互斥**（`docs/09` §四；台账 D-017）：同一时刻只留一个覆盖层。
 *
 * 为什么必须互斥、而不是靠层级压过去：覆盖层的遮罩铺满整个视口 / 编辑区
 * （`.side-backdrop` / `.col-backdrop`），面板开在遮罩底下就是「看得见、点不动」——
 * 用户实测：从页面库抽屉里点「就这些问 AI」，面板确实开了，但点面板的任何位置
 * 命中的都是遮罩（效果是「把页面库关了」），于是他以为「面板必须先收起页面库才用得了」。
 * 三者都是全屏级覆盖层，叠着谁也读不好。
 *
 * **两个抽屉的判据不同**（这点踩过一次）：侧栏是 `≤899px` 的抽屉、页面列是 `≤1279px` 的抽屉，
 * 所以调用方要把各自的「此刻是不是抽屉」传进来——按一个「窄屏」写死会在 900–1279px 这一段漏收页面列。
 *
 * 返回「要打开 `opened` 时」其余覆盖层要做什么：
 * - `drawerOpen`：侧栏抽屉的目标状态（只有开它自己时为 true）；
 * - `listColumnCollapsed`：页面列的目标状态；`null` = **不动**——宽屏下它是并排的一栏，不是覆盖层；
 * - `closePanels`：是否收掉右侧那三个面板（开抽屉时为 true；**开面板时 false**，
 *   面板之间不互斥，具体开哪一个由调用方决定）。
 */
export function exclusiveOverlays(
  opened: OverlayKind,
  drawers: { sidebar: boolean; listColumn: boolean },
): { drawerOpen: boolean; listColumnCollapsed: boolean | null; closePanels: boolean } {
  return {
    drawerOpen: opened === 'sidebar',
    listColumnCollapsed: opened === 'listColumn' ? false : drawers.listColumn ? true : null,
    closePanels: opened !== 'panel',
  }
}
