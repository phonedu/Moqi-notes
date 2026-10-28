export type BlockType =
  | 'text'
  | 'heading1'
  | 'heading2'
  | 'heading3'
  | 'heading4'
  | 'heading5'
  | 'heading6'
  | 'bullet'
  | 'numbered'
  | 'quote'
  | 'code'
  | 'divider'
  | 'todo'
  /** 媒体（13-媒体设计（已归档） §2；A 族只插不转）：图片 / 附件 / 嵌入。 */
  | 'image'
  | 'file'
  | 'embed'

/**
 * 列表类块（docs/09 §五）：项目列表 / 编号列表 / 待办。
 * 回车在列表项里**继续同类型**、空项回车**退出列表**都靠这一个判据（见 `decideListEnter`）。
 */
export function isListType(type: BlockType): boolean {
  return type === 'bullet' || type === 'numbered' || type === 'todo'
}

export type Mark = {
  /** `highlight` = 行内高亮（`R09-TXBAR-10` 的 `.tx-h`）；它在 Lexical 里是 format 位，不是 style（台账 D-011）。 */
  type: 'bold' | 'italic' | 'underline' | 'code' | 'color' | 'strike' | 'highlight'
  attrs?: Record<string, unknown>
}

export type RefKind = 'object' | 'block'

/** T13: an inline reference keeps its jump target independently of the display text. */
export type InlineRefBinding = {
  kind: RefKind
  targetId: string
}

export type ContentFragment = {
  t: 'text' | 'mention' | 'link' | 'inline-ref'
  v: string
  marks?: Mark[]
  ref?: InlineRefBinding
  /**
   * 外部链接的目标地址（`09-桌面端交互规范` §6.13 `R09-ELINK-*`；只在 `link` 片段上）。
   * 与 `ref` 互斥：`ref` 是图内引用（进 `objectRefs` / `blockRefs`、有反链、可能悬空）；
   * `url` 在应用之外——不进任何 refs、没有「悬空」概念。
   */
  url?: string
}

export type BlockRef = {
  targetBlockId: string
  fromBlockId: string
  type: 'link' | 'embed' | 'mention'
  context?: string
}

export type PropertyType = 'text' | 'number' | 'date' | 'checkbox' | 'select'

export type PropertyOption = { id: string; label: string }

export type PropertyDef = {
  id: string
  name: string
  type: PropertyType
  options?: PropertyOption[]
  color?: string
  /** T15/§4.4: a disabled def keeps historical values but stops accepting edits. */
  disabled?: boolean
  created: number
  modified: number
}

/** T15: typed property values; an absent entry means "unset", distinct from checkbox false. */
export type PropertyValue =
  | { defId: string; type: 'text'; value: string }
  | { defId: string; type: 'number'; value: number }
  | { defId: string; type: 'date'; value: string }
  | { defId: string; type: 'checkbox'; value: boolean }
  | { defId: string; type: 'select'; optionId: string }

export type TagDef = { id: string; name: string; created: number; modified: number }

/** T17: provenance for a Block created by an AI action. */
export type AiAction = 'summary' | 'actions' | 'ask' | 'polish' | 'expand' | 'askback' | 'reframe'
/** AI 动作的用户可见名称（UI 与 Block 标记共用同一份文案）。 */
export const AI_ACTION_LABEL: Record<AiAction, string> = {
  summary: '总结',
  actions: '提取行动',
  ask: '自由问答',
  polish: '润色',
  expand: '扩写',
  askback: '反问我',
  reframe: '换角度',
}
/** 生成中的 AI 块在流式写入完成前保持该状态；停止后保留已生成部分并进入完成或取消态。 */
export type AiStatus = 'generating' | 'complete' | 'needs-confirmation' | 'cancelled' | 'error' | 'accepted'
export type AiRequestInfo = { provider: string; model: string; requestedAt: number }
export type AiMeta = {
  action: AiAction
  sourceBlockIds: string[]
  /**
   * 来源**范围**（docs/09 §6.11 R09-AIB-7 的来源标签文案）：整篇（面板「基于本篇」）
   * 还是按块选的。标签上写范围、不写块数——「来源 2 块」既不说是来自哪、也不说是什么
   * （用户 2026-09-29 裁决换成范围口径）。
   */
  sourceScope?: 'page' | 'selection'
  status: AiStatus
  confidence?: number
  request?: AiRequestInfo
  error?: string
}

/**
 * 媒体块的资产（13-媒体设计（已归档） §2；**仅 image / file 有值**）。
 * 落盘名是不透明随机名（同步共享目录里杜绝跨设备撞车），原名只在 payload 里——显示与导出用原名。
 * **文件缺失不是校验错**：数据合法、界面降级（`R04-WRITE-1` 口径）。
 */
export type BlockAsset = {
  /** 磁盘名（`<随机 id>.<ext>`），落在 `<数据目录>/assets/`。 */
  fileName: string
  /** 用户看到的原名（导出写 `assets/<原名>`）。 */
  originalName: string
  mime: string
  size: number
  /** 图片才有（占位卡按它算比例）。 */
  width?: number
  height?: number
}

/** 媒体分类：`image/*` 走图片块，其余走附件块（粘贴 / 拖入 / 菜单三条管道共用这一份判据）。 */
export function mediaKindOf(mime: string): 'image' | 'file' {
  return mime.startsWith('image/') ? 'image' : 'file'
}

/**
 * 扩展名 → MIME 的**最小表**（只为两条窄路服务）：① 桌面拖入给的是路径、Rust 按名复制不回 MIME；
 * ② 某些来源的 `File.type` 为空。认不出的按 `application/octet-stream`（附件块，图片仍能靠显示端加载来判断）。
 */
export function guessMimeFromName(name: string): string {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  const table: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
    heic: 'image/heic', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown',
  }
  return table[ext] ?? 'application/octet-stream'
}

export type MetadataRegistry = { properties: PropertyDef[]; tags: TagDef[] }

export type Block = {
  entityId: string
  blockUid: string
  type: BlockType
  content: ContentFragment[]
  parent: string | null
  children: string[]
  /** T15: explicit sibling order key; roots render by (position, created, id). */
  position: number
  collapsed: boolean
  checked: boolean
  deleted: boolean
  deletedAt: number | null
  prevParent: string | null
  prevIndex: number | null
  blockRefs: BlockRef[]
  blockBackRefs: BlockRef[]
  objectRefs: string[]
  objectBackRefs: string[]
  isObject: boolean
  objectName: string | null
  /** V2b: page-level pin (roots only). At most `MAX_PINNED_PAGES` pages may be pinned. */
  pinned: boolean
  /** V2b: page-level star (roots only). A mark only — it does not affect ordering. */
  starred: boolean
  tags: string[]
  properties: PropertyValue[]
  /**
   * 属性面板 · **本页加进来的行**（`13-属性区重规划` §0-1/§0-3/§0-10，2026-10-10 用户裁决）：
   * 值域 = 默认字段 id（`sys:tags` / `sys:created` / `sys:edited`）或用户属性 defId。缺省 `[]`
   * ⇒ 新页面不显示任何默认属性（默认属性必须先「添加属性」加进来才出现）。
   */
  propertyShown: string[]
  /**
   * 属性面板 · **本页删掉的行**（同批裁决 §0-10：「从本页删除」＝本页不再显示、**值保留**）。
   * 值域 = defId 或默认字段 id；再添加 = 出列。行的显示规则是纯函数 `propertyRowVisible`。
   */
  propertyHidden: string[]
  /** 媒体资产（13-媒体设计（已归档） §2）：只有 image / file 有值；其余一律 null。 */
  asset: BlockAsset | null
  /** T17: null for human-authored Blocks; set on AI result Blocks. */
  aiMeta: AiMeta | null
  created: number
  modified: number
}

export type BlockMap = Map<string, Block>

/** V2b: how many pages may be pinned at once (user ruling 2026-09-30: more than 5 is meaningless). */
export const MAX_PINNED_PAGES = 5

/** V2b: 回收站保留期（天）。到期自动从本机彻底删除（`09-桌面端UI规范` `R09-TRASH-3`）。 */
export const TRASH_RETENTION_DAYS = 30

/**
 * V2b: 回收站里已过保留期、该被自动彻底删除的**根条目**。
 *
 * ⚠️ 这是真删数据的路径（`09-桌面端UI规范` `R09-TRASH-3` 的「到期自动彻底删除」），只在载入时跑一次。
 * 时间戳取 `deletedAt`，老数据没有它就退回 `modified`（与 `remainingDays` 同一口径——
 * 否则「剩余 0 天」的条目会永远留在回收站里，界面就是在承诺一件不会发生的事）。
 */
export function expiredTrashIds(blocks: Block[], now = Date.now()): string[] {
  const cutoff = now - TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000
  return blocks
    .filter((block) => block.deleted && (block.deletedAt ?? block.modified) < cutoff)
    .map((block) => block.entityId)
}

/** T15: canonical sibling/root order. */
export function compareBlockOrder(left: Block, right: Block): number {
  return left.position - right.position || left.created - right.created || left.entityId.localeCompare(right.entityId)
}

/** V2b: pinned roots first, then the canonical order. `orderedRootIds` is the single owner of root order. */
export function compareRootOrder(left: Block, right: Block): number {
  return Number(right.pinned) - Number(left.pinned) || compareBlockOrder(left, right)
}

/** T15: active roots in canonical render order. V2b: pinned pages lead. */
export function orderedRootIds(blocks: BlockMap): string[] {
  return [...blocks.values()]
    .filter((block) => !block.deleted && block.parent === null)
    .sort(compareRootOrder)
    .map((block) => block.entityId)
}

/** V2b: pinned pages, in render order. */
export function pinnedRootIds(blocks: BlockMap): string[] {
  return orderedRootIds(blocks).filter((id) => blocks.get(id)?.pinned === true)
}

/** V2b: whether another page may be pinned. `blockIds` excludes the page being unpinned/kept. */
export function pinnedCount(blocks: BlockMap, exclude?: string): number {
  return pinnedRootIds(blocks).filter((id) => id !== exclude).length
}

/** V2b: true when the page may become pinned — already pinned, or there is room left. */
export function canPinPage(blocks: BlockMap, entityId: string): boolean {
  const page = blocks.get(entityId)
  if (!page || page.deleted || !page.isObject) return false
  if (page.pinned) return true
  return pinnedCount(blocks) < MAX_PINNED_PAGES
}

export function textContent(block: Block): string {
  return block.content.map((fragment) => fragment.v).join('')
}

export function createTextBlock(input: {
  entityId: string
  blockUid: string
  text?: string
  parent?: string | null
  isObject?: boolean
  objectName?: string | null
  now?: number
}): Block {
  const now = input.now ?? Date.now()
  return {
    entityId: input.entityId,
    blockUid: input.blockUid,
    type: 'text',
    content: [{ t: 'text', v: input.text ?? '' }],
    parent: input.parent ?? null,
    children: [],
    position: 0,
    collapsed: false,
    checked: false,
    deleted: false,
    deletedAt: null,
    prevParent: null,
    prevIndex: null,
    blockRefs: [],
    blockBackRefs: [],
    objectRefs: [],
    objectBackRefs: [],
    isObject: input.isObject ?? false,
    objectName: input.objectName ?? null,
    pinned: false,
    starred: false,
    tags: [],
    properties: [],
    propertyShown: [],
    propertyHidden: [],
    asset: null,
    aiMeta: null,
    created: now,
    modified: now,
  }
}

export function cloneBlock(block: Block): Block {
  return structuredClone(block)
}

export function cloneBlockMap(blocks: BlockMap): BlockMap {
  // 整图一次 `structuredClone`（`Map` 本身可克隆）：与逐块克隆语义相同，省掉逐块的调用开销
  // 与中间数组，GC 压力也小一截（性能批 ⓒ ②；微基准 1.1–1.2×，真实收益主要在大图）。
  return structuredClone(blocks)
}

/** Splits inline content without mutating the source fragments. */
export function splitContentAtOffset(content: ContentFragment[], offset: number): [ContentFragment[], ContentFragment[]] {
  const left: ContentFragment[] = []
  const right: ContentFragment[] = []
  let remaining = Math.max(0, offset)
  for (const fragment of content) {
    if (remaining >= fragment.v.length) {
      left.push(structuredClone(fragment))
      remaining -= fragment.v.length
    } else if (remaining > 0) {
      left.push({ ...structuredClone(fragment), v: fragment.v.slice(0, remaining) })
      right.push({ ...structuredClone(fragment), v: fragment.v.slice(remaining) })
      remaining = 0
    } else {
      right.push(structuredClone(fragment))
    }
  }
  return [left, right]
}
