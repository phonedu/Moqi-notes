import type { PropertyDef, PropertyOption, PropertyType, PropertyValue } from '@moqi/editor'

/** 三个互斥视图（`09-桌面端交互规范` §八：工作区 / 回收站 / 设置）——页面库不是视图，是工作区的中间栏（`R09-RESP-3`）。 */
export type ViewKind = 'editor' | 'trash'

export type SaveState = 'saved' | 'saving' | 'error'

/**
 * V2b：同步状态——界面按这四态显示（`09-桌面端交互规范` `R09-SYNC-2…5`）。
 *
 * `unconfigured` **不是错误态**，是「还没配过同步位置」的正常状态（`R09-SYNC-5`：点开是
 * 设置入口）；`offline` 也不是错误（`R09-SYNC-4`：编辑照常，连上后自动补传）。
 */
export type SyncStatus =
  | { kind: 'unconfigured' }
  | { kind: 'synced'; at: number }
  | { kind: 'syncing'; done: number; total: number }
  | { kind: 'offline'; pending: number }

/** 页面库卡片（docs/09 §4.1.1 两段结构）。 */
export type LibraryCard = {
  id: string
  name: string
  /** 正文摘要段落（真实子 Block 文本，卡片按 112px 截断）。 */
  paragraphs: string[]
  createdLabel: string
  updatedLabel: string
  backlinkCount: number
  /** V2b：页面置顶（最多 5 个）。卡片头部据此显示置顶标记，⋯ 菜单据此切换文案。 */
  pinned: boolean
  /** V2b：页面星标。已星标时卡片头部出现 ★（快捷取消入口），`R09-CARD-3`。 */
  starred: boolean
  /** V2c 筛选面板要的结构化字段（`R09-FILT-3/4`）：时间戳、标签 id、属性值。 */
  created: number
  modified: number
  tagIds: string[]
  /** 属性值（原 V2c 的窄形状只带 optionId；`属性区重规划（已归档）` §7.1-A4 起带**全量值**——按属性排序要用）。 */
  properties: PropertyValue[]
}

export type TagSummary = { id: string; name: string; count: number }

export type TrashEntry = {
  id: string
  name: string
  deletedLabel: string
  remainingDays: number
  childCount: number
  backlinkCount: number
}

export type NavEntry = { id: string; label: string; depth: number; kind: 'object' | 'block' }

/** 侧栏标签菜单（docs/09 §6.8：重命名 / 合并到… / 从所有页面移除）。 */
export type TagMenuTarget = { id: string; name: string; count: number }

/** 属性面板与摘要展开面板共用的行模型（三处同构，docs/09 §4.4）。 */
export type PropertyRow =
  | { kind: 'custom'; def: PropertyDef; value: PropertyValue | undefined }
  | { kind: 'tags'; tags: { id: string; name: string }[] }
  /**
   * 默认字段「**时间**」（`属性区重规划（已归档）` §0-12 已裁）：**一行**，值 = 页面创建时间（`created`）、
   * **用户可改**；`modified` 系统维护、不进面板（旧的「编辑时间」行随之退场）。
   * 行的显示集合键沿用 `sys:created`——存量 `propertyShown/hidden` 里的它照旧生效。
   */
  | { kind: 'time'; timestamp: number }

export type CreatePropertyInput = { name: string; type: PropertyType }

export type { PropertyDef, PropertyOption, PropertyType, PropertyValue }
