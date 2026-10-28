/**
 * UI 偏好（主题、卡片显隐、侧栏折叠）属于界面状态而不是 Block 领域数据：
 * 它们不参与 Block 事务、不写入 SQLite，只在本机记住用户的界面选择。
 * 存储不可用时全部退回默认值，界面不能因为偏好读写失败而失效。
 */
import type { LibraryViewMode } from './menuItems'
import { MQ } from './breakpoints'
import { matchMediaSafe } from './shellSupport'

/** 浅深三档（原来的 theme 语义原样保留，只是与主题 id 分开记）。 */
export type ThemeMode = 'light' | 'dark' | 'system'
export type FontSizeStep = 'small' | 'normal' | 'large' | 'xlarge'
export type LineHeightStep = 'tight' | 'normal' | 'loose'
export type ColumnWidthStep = 'narrow' | 'normal' | 'wide'

/**
 * 主题目录（主题设计稿 §4.3，20 套主题随包 themes.css）：id 英文小写连字符、发布后不改；
 * 显示名「轴·彩」中文四字内。**主题包**在 themes.css（19 套）+ tokens.css 的 :root（默认这套），
 * 本表只管「有哪些、叫什么」——加主题：themes.css 加一个令牌块 + 这里加一行 + 跑 `pnpm check:theme`。
 */
export const THEMES: { id: string; name: string }[] = [
  { id: 'default', name: '冷雾·靛蓝' },
  { id: 'warm-paper', name: '暖纸·赭' },
  { id: 'matcha', name: '抹茶·松' },
  { id: 'graphite', name: '石墨·钢蓝' },
  { id: 'sunset', name: '落日·珊瑚' },
  { id: 'celadon', name: '青瓷·青' },
  { id: 'grape', name: '葡萄·紫' },
  { id: 'sakura', name: '樱·玫' },
  { id: 'coffee', name: '咖啡·琥珀' },
  { id: 'olive', name: '苔原·橄榄' },
  { id: 'deepsea', name: '深海·天蓝' },
  { id: 'steel', name: '钢·锈' },
  { id: 'crimson', name: '绯霞·殷红' },
  { id: 'gold', name: '麦浪·鎏金' },
  { id: 'lake', name: '湖光·孔雀' },
  { id: 'heather', name: '紫雾·石楠' },
  { id: 'mint', name: '青屿·薄荷' },
  { id: 'ink', name: '宣纸·玄墨' },
  { id: 'mulberry', name: '桑葚·黑加仑' },
  { id: 'turquoise', name: '清泉·松石' },
]

export const FONT_SIZE_STEPS: { value: FontSizeStep; label: string }[] = [
  { value: 'small', label: '小' }, { value: 'normal', label: '标准' }, { value: 'large', label: '大' }, { value: 'xlarge', label: '特大' },
]
export const LINE_HEIGHT_STEPS: { value: LineHeightStep; label: string }[] = [
  { value: 'tight', label: '紧凑' }, { value: 'normal', label: '标准' }, { value: 'loose', label: '疏朗' },
]
export const COLUMN_WIDTH_STEPS: { value: ColumnWidthStep; label: string }[] = [
  { value: 'narrow', label: '窄' }, { value: 'normal', label: '标准' }, { value: 'wide', label: '宽' },
]

export type UiPrefs = {
  /** 主题 id（themes.css 的 data-theme 值；目录见 THEMES）。 */
  themeId: string
  /** 浅深三档（与主题 id 两轴独立：跟随系统只动它）。 */
  mode: ThemeMode
  /** 排版三轴（指令 §4.7；档位即钳制，属性挂 <html>）。 */
  fontSize: FontSizeStep
  lineHeight: LineHeightStep
  columnWidth: ColumnWidthStep
 /** 页面库卡片属性行上被「卡片显隐」关掉的字段 id（属性定义 id 或系统字段 id；入口在属性行的 ⋯ 菜单， 起）。 */
  hiddenCardFields: string[]
 /** 最近挂到页面上的属性定义 id（最新在前；添加属性弹窗的「最近使用」组， 新设计）。 */
  recentProperties: string[]
  sidebarCollapsed: boolean
  /** 页面库形态：画册 / 列表 / 简约（docs/09 §4.1）。 */
  libraryView: LibraryViewMode
  /** 编辑器左侧「页面列表」列是否折叠（折叠后就是放大写作，docs/09 §八）。 */
  listColumnCollapsed: boolean
  /** 侧栏宽度（px，拖分隔条改；docs/09 §八）。 */
  sidebarWidth: number
  /** 中间页面库栏宽度（px）。 */
  pagecolWidth: number
  /**
  * 导入时把正文里的**行内标签**（Obsidian 的 `#标签`）收成页面标签（用户 裁决：
   * 做成导入页的开关；默认开——对齐 Obsidian 语义"行内标签 ⊂ 这篇笔记的标签"）。
   * **只登记、不改字**：正文一字不动（幂等、往返逐字一致），见 `domain/mdRefs.collectInlineTags`。
   */
  importInlineTags: boolean
}

/** 系统字段 id（docs/09 §4.4：日期与星标默认闭眼，头部已有时间与 ★）。 */
export const SYSTEM_FIELD_IDS = { tags: 'sys:tags', created: 'sys:created', edited: 'sys:edited', star: 'sys:star' } as const

export const defaultUiPrefs: UiPrefs = {
  themeId: 'default',
  mode: 'light',
  fontSize: 'normal',
  lineHeight: 'normal',
  columnWidth: 'normal',
  hiddenCardFields: [SYSTEM_FIELD_IDS.created, SYSTEM_FIELD_IDS.edited, SYSTEM_FIELD_IDS.star],
  recentProperties: [],
  sidebarCollapsed: false,
  libraryView: 'list',
  listColumnCollapsed: false,
  sidebarWidth: 250,
  pagecolWidth: 400,
  importInlineTags: true,
}

const STORAGE_KEY = 'moqi-project-b:ui-prefs'

/** 宽度偏好必须落在可用区间内：越界（手改 localStorage、换屏幕）时回落到默认值。 */
function clampWidth(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function loadUiPrefs(): UiPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return { ...defaultUiPrefs }
    const parsed = JSON.parse(raw) as Partial<UiPrefs>
    return {
      // 主题 id：目录里认得才用，否则回落默认；老偏好只有 `theme`（无 themeId）⇒ 映射成 default + 原浅深，不丢用户设置。
      themeId: typeof parsed.themeId === 'string' && THEMES.some((theme) => theme.id === parsed.themeId) ? parsed.themeId : 'default',
      mode: parsed.mode === 'dark' || parsed.mode === 'system' ? parsed.mode : 'light',
      fontSize: parsed.fontSize === 'small' || parsed.fontSize === 'large' || parsed.fontSize === 'xlarge' ? parsed.fontSize : 'normal',
      lineHeight: parsed.lineHeight === 'tight' || parsed.lineHeight === 'loose' ? parsed.lineHeight : 'normal',
      columnWidth: parsed.columnWidth === 'narrow' || parsed.columnWidth === 'wide' ? parsed.columnWidth : 'normal',
      hiddenCardFields: Array.isArray(parsed.hiddenCardFields) ? parsed.hiddenCardFields.filter((id): id is string => typeof id === 'string') : [...defaultUiPrefs.hiddenCardFields],
      recentProperties: Array.isArray(parsed.recentProperties) ? parsed.recentProperties.filter((id): id is string => typeof id === 'string').slice(0, 6) : [],
      sidebarCollapsed: parsed.sidebarCollapsed === true,
      // 只认显式的 `false`：老偏好（没这一项）落到默认值「收」（与 defaultUiPrefs 一致）。
      importInlineTags: parsed.importInlineTags !== false,
   // 画册形态已移除（）：历史偏好一律落到列表。
      libraryView: parsed.libraryView === 'compact' ? 'compact' : 'list',
   // 移动骨架（`10` §三， 4a）：compact 档**进应用 = 首页**——启动时让上一轮的
      // 「页面列收起」意图让位（只影响启动落点；跨断点不写它，`R09-RESP-15` 意图不被宽度改写）。
      listColumnCollapsed: parsed.listColumnCollapsed === true && !matchMediaSafe(MQ.compact),
      sidebarWidth: clampWidth(parsed.sidebarWidth, 200, 420, 250),
      pagecolWidth: clampWidth(parsed.pagecolWidth, 300, 620, 400),
    }
  } catch {
    return { ...defaultUiPrefs }
  }
}

export function saveUiPrefs(prefs: UiPrefs): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // 偏好写入失败只影响下次启动的默认值，不影响本次会话。
  }
}

/** 浅深三档 → 实际生效的 light / dark（跟随系统在这里落地）。 */
export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode !== 'system') return mode
  try {
    return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function applyAppearance(prefs: Pick<UiPrefs, 'themeId' | 'mode' | 'fontSize' | 'lineHeight' | 'columnWidth'>): void {
  try {
    const root = document.documentElement
    // 两轴独立：主题 id 挂 data-theme、浅深挂 data-mode（主题设计稿 §2）。
    root.dataset.theme = prefs.themeId
    root.dataset.mode = resolveTheme(prefs.mode)
    // 排版三轴：档位即钳制，CSS 里只认这三档（tokens.css 末尾的 data-fs / data-lh / data-colw 块）。
    root.dataset.fs = prefs.fontSize
    root.dataset.lh = prefs.lineHeight
    root.dataset.colw = prefs.columnWidth
  } catch {
    // 无 document 的环境（测试）直接跳过。
  }
}

export function isFieldVisible(prefs: UiPrefs, fieldId: string): boolean {
  return !prefs.hiddenCardFields.includes(fieldId)
}

export function toggleField(prefs: UiPrefs, fieldId: string): UiPrefs {
  const hidden = prefs.hiddenCardFields.includes(fieldId)
    ? prefs.hiddenCardFields.filter((id) => id !== fieldId)
    : [...prefs.hiddenCardFields, fieldId]
  return { ...prefs, hiddenCardFields: hidden }
}

/** 挂属性时记一笔「最近使用」（最新在前、去重、上限 6 条；添加属性弹窗的快捷组数据源）。 */
export function pushRecentProperty(prefs: UiPrefs, defId: string, limit = 6): UiPrefs {
  const recent = [defId, ...prefs.recentProperties.filter((id) => id !== defId)].slice(0, limit)
  return { ...prefs, recentProperties: recent }
}

/**
 * AI 能力配置（docs/09 §4.6）：BYOK，密钥仅存本机，不上传任何中转服务。
 * 与会话数据分开存放，清空页面数据不会连带删除用户的密钥配置。
 */
export type StoredAiConfig = { baseUrl: string; apiKey: string; model: string }

const AI_KEY = 'moqi-project-b:ai-config'

export function loadAiConfig(): StoredAiConfig | null {
  try {
    const raw = globalThis.localStorage?.getItem(AI_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredAiConfig>
    if (typeof parsed.baseUrl !== 'string' || typeof parsed.apiKey !== 'string' || typeof parsed.model !== 'string') return null
    return { baseUrl: parsed.baseUrl, apiKey: parsed.apiKey, model: parsed.model }
  } catch {
    return null
  }
}

export function saveAiConfig(config: StoredAiConfig): void {
  try {
    globalThis.localStorage?.setItem(AI_KEY, JSON.stringify(config))
  } catch {
    // 写入失败只影响下次启动的默认值，不影响本次会话。
  }
}

/**
 * 上次运行过的版本号（docs/09 §4.6 关于卡片）：更新后用来提示「本次更新」。
 * 与界面偏好同类——只存本机、不进 Block 领域数据、读写失败不阻塞界面。
 */
const SEEN_VERSION_KEY = 'moqi-project-b:seen-version'

export function loadSeenVersion(): string | null {
  try {
    return globalThis.localStorage?.getItem(SEEN_VERSION_KEY) ?? null
  } catch {
    return null
  }
}

export function saveSeenVersion(version: string): void {
  try {
    globalThis.localStorage?.setItem(SEEN_VERSION_KEY, version)
  } catch {
    // 写入失败只影响下次启动的更新提示，不影响本次会话。
  }
}
