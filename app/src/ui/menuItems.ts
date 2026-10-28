import type { IconName } from '@moqi/editor'
import type { BlockType } from '@moqi/editor'

/**
 * 编辑器菜单的单一数据源（docs/09 §6.9）：
 * 常驻格式栏 `Aa ▾`、`＋ 插入 ▾` 与斜杠菜单的「转换为 / 插入」两区都由这里渲染，
 * 选项集合永不漂移；未实现的能力只在这里标注版本，不在各菜单里各写一份。
 */

export type BlockTypeItem = { type: BlockType; label: string; hint: string; icon: IconName; short: string }

export const BLOCK_TYPE_ITEMS: BlockTypeItem[] = [
  // 「标题 1」补回（2026-10-10 用户裁决，`R09-FMT-2` / `R09-EDIT-3` 同日改写）：**页面标题 = 容器
  // 名字行、不参与正文级别**；正文 H1–H6 完整可用。（此前 2026-10-08「级别 1 留给页面标题」已废。）
  { type: 'heading1', label: '标题 1', hint: 'H1', icon: 'heading', short: 'H1' },
  { type: 'heading2', label: '标题 2', hint: 'H2', icon: 'heading', short: 'H2' },
  { type: 'heading3', label: '标题 3', hint: 'H3', icon: 'heading', short: 'H3' },
  { type: 'heading4', label: '标题 4', hint: 'H4', icon: 'heading', short: 'H4' },
  { type: 'heading5', label: '标题 5', hint: 'H5', icon: 'heading', short: 'H5' },
  { type: 'heading6', label: '标题 6', hint: 'H6', icon: 'heading', short: 'H6' },
  { type: 'text', label: '正文', hint: '自然段', icon: 'heading', short: '正文' },
  { type: 'quote', label: '引用', hint: '', icon: 'quote', short: '引用' },
  { type: 'todo', label: '待办', hint: '', icon: 'check-square', short: '待办' },
  { type: 'code', label: '代码', hint: '', icon: 'code', short: '代码' },
  { type: 'bullet', label: '无序列表', hint: '', icon: 'list', short: '无序列表' },
  { type: 'numbered', label: '有序列表', hint: '', icon: 'list-numbered', short: '有序列表' },
  { type: 'divider', label: '分隔线', hint: '', icon: 'minus', short: '分隔线' },
]

/**
 * 块类型的显示名（格式栏 `Aa` 的 tooltip / aria、转换 toast）——与菜单同源（含「标题 1」，2026-10-10 起）。
 */
export const blockTypeLabel: Record<string, string> = {
  ...Object.fromEntries(BLOCK_TYPE_ITEMS.map((item) => [item.type, item.label])),
}

/**
 * 块类型的**全量显示名**（16 类）：活动块是媒体三员（只插不转、不在 `BLOCK_TYPE_ITEMS` 里）时也要有名字——
 * 此前格式栏直接用可转换 13 类的表，媒体块显示成「块类型：undefined（点击转换）」（2026-10-11 审计修复）。
 */
export function blockTypeName(type: BlockType): string {
  return blockTypeLabel[type] ?? ({ image: '图片', file: '附件', embed: '嵌入' } as Partial<Record<BlockType, string>>)[type] ?? type
}

export type InsertKind = 'todo' | 'quote' | 'code' | 'today' | 'now' | 'embed' | 'image' | 'file'

export type InsertItem = {
  kind: InsertKind
  label: string
  hint: string
  icon: IconName
  /** 未实现的能力标注版本；有值的项在菜单里禁用并显示版本号。 */
  version?: '后续版本' | 'V3'
}

export const INSERT_ITEMS: InsertItem[] = [
  { kind: 'todo', label: '待办', hint: '下方新建待办', icon: 'check-square' },
  { kind: 'quote', label: '引用', hint: '下方新建引用', icon: 'quote' },
  { kind: 'code', label: '代码', hint: '下方新建代码块', icon: 'code' },
  // 「今天」「现在」（2026-10-11，`13-功能缺口总账` `G-E06`）：中文笔记高频（日记 / 会议记录）——
  // 插入一个装着日期时间的普通文本块（`insertDateText` 出文本，不加新块类型）。
  { kind: 'today', label: '今天', hint: '下方新建日期块', icon: 'calendar' },
  { kind: 'now', label: '现在', hint: '下方新建日期时间块', icon: 'history' },
  // 「AI 块」项 2026-10-08 用户裁决删除：插入一个空 AI 块没有用（AI 内容由指令生成，
  // 入口在块浮动工具栏 / 常驻格式栏 / AI 助手面板）——条文见 `R09-FMT-5` / `R09-AIB-8`。
  { kind: 'embed', label: '嵌入块', hint: '同步显示来源块内容', icon: 'embed' },
  { kind: 'image', label: '图片块', hint: '本地上传 / 粘贴 / 拖入', icon: 'image' },
  { kind: 'file', label: '附件块', hint: '任意文件占位卡', icon: 'paperclip' },
]

/**
 * 整块格式清单（`R09-BEDIT-1`）：块浮动工具栏的「整块格式」一组——2026-10-11 补「下划线整块」成**六连**
 * （`13-功能缺口总账` `G-E04`：常驻栏 / 文本栏 / 斜杠菜单都有下划线，只此一处漏了）。
 * **移动端胶囊仍五连**（`10` §6.2，清单在 `BlockCapsule`）；type 用结构化字面量（不 import lexical，边界门 ③）。
 */
export const BLOCK_FORMAT_ITEMS: { format: 'bold' | 'italic' | 'underline' | 'strikethrough' | 'code' | 'highlight'; icon: IconName; label: string }[] = [
  { format: 'bold', icon: 'bold', label: '加粗整块' },
  { format: 'italic', icon: 'italic', label: '斜体整块' },
  { format: 'underline', icon: 'underline', label: '下划线整块' },
  { format: 'strikethrough', icon: 'strike', label: '删除线整块' },
  { format: 'code', icon: 'inline-code', label: '行内代码整块' },
  { format: 'highlight', icon: 'highlight', label: '高亮整块' },
]

/** 已交付的插入项：斜杠菜单只列这些。 */
export const AVAILABLE_INSERT_ITEMS = INSERT_ITEMS.filter((item) => !item.version)

/**
 * M5 可选能力：媒体类插入项（图片 / 附件 / 嵌入）。`media` 关闭时这些项从**所有**插入入口
 * （＋插入 ▾ / 斜杠菜单 / 移动插入面板）一起消失——判据只在这一处，入口不各自为政。
 */
export const MEDIA_INSERT_KINDS: ReadonlySet<InsertKind> = new Set(['image', 'file', 'embed'])
export function insertItemsForMedia<T extends { kind: InsertKind }>(items: T[], media: boolean): T[] {
  return media ? items : items.filter((item) => !MEDIA_INSERT_KINDS.has(item.kind))
}

/**
 * 插入项的**落点路由**（`pickInsert` 的唯一依据）：文字型直插 / 图片附件走选文件 / 嵌入落占位。
 * 做成纯映射是为了可单测——`INSERT_ITEMS` 每加一项，`tests/ui/shell.test.tsx` 会要求它有明确去处
 * （2026-10-08 的教训：斜杠菜单曾把图片 / 附件直接喂给只认文字型的 `insertBlockOfType`，
 * 落出没有 asset 的空壳块；根因正是「去哪」散在调用点里、没有单一所有者）。
 */
export type InsertRoute = 'block' | 'file' | 'embed'

export function insertRoute(kind: InsertKind): InsertRoute {
  if (kind === 'image' || kind === 'file') return 'file'
  if (kind === 'embed') return 'embed'
  return 'block'
}

/**
 * 页面库两种形态（docs/09 §4.1；画册形态 2026-09-27 已移除）：列表 / 简约。
 * 单一数据源：页面库头部的切换器与编辑器左侧的页面列都从这里渲染，避免两处漂移。
 */
export type LibraryViewMode = 'list' | 'compact'

export const LIBRARY_VIEWS: { mode: LibraryViewMode; label: string; hint: string }[] = [
  { mode: 'list', label: '列表', hint: '一页一张卡，四段信息齐全，可展开' },
  { mode: 'compact', label: '简约', hint: '紧凑一屏多页，看标题与两行摘要' },
]

