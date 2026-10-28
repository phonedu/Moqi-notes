import { splitContentAtOffset, textContent, type Block, type BlockMap, type ContentFragment, type RefKind } from './block'
import type { Operation, Transaction } from './operation'
import { webUrlError } from './validation'
import { isSelfOrAncestor, owningPageId } from './treeOps'

export type RefTrigger = '[[' | '(('

export type RefCandidate = {
  targetId: string
  label: string
  hint: string
}

const TRIGGER_LENGTH = 2
const MAX_CANDIDATES = 8

/**
 * 外部链接写入（`09-桌面端交互规范` §6.13 `R09-ELINK-1/2`；纪律见 `04` `R04-PASTE-1`）：
 * **一次事务**、只产出一个 `link` 片段——对话框、`⌘L`、常驻格式栏、粘贴纯 URL 四条路
 * **共用这一条命令入口**，谁也不许旁路拼片段。
 *
 * `offset` + `length` 是**替换区间**（选区建链 = 替换选区；`length: 0` = 在光标处插入）。
 * 区间与已有的行内引用 / 链接片段相交时**扩到整片段**——切片会把一个引用切成两截、
 * 丢掉它的绑定（`R04-CARET-5` 同族的边界纪律）。文字为空时用 URL 原文兜底（`R09-ELINK-2`）。
 */
export function insertExternalLink(
  blocks: BlockMap,
  blockId: string,
  input: { text: string; url: string; offset: number; length: number },
  now = Date.now(),
): Omit<Transaction, 'inverse'> | null {
  const block = blocks.get(blockId)
  if (!block || block.deleted) return null
  const url = input.url.trim()
  if (webUrlError(url) !== null) return null

  const total = block.content.reduce((count, fragment) => count + fragment.v.length, 0)
  let start = Math.max(0, Math.min(input.offset, total))
  let end = Math.max(start, Math.min(start + Math.max(0, input.length), total))
  // 扩到整片段：被区间碰到的非纯文本片段不切片，整段让给这次替换。
  let cursor = 0
  for (const fragment of block.content) {
    const fragmentStart = cursor
    const fragmentEnd = cursor + fragment.v.length
    cursor = fragmentEnd
    if (fragmentStart >= end || fragmentEnd <= start) continue
    if (fragment.t === 'text') continue
    start = Math.min(start, fragmentStart)
    end = Math.max(end, fragmentEnd)
  }

  const [before, rest] = splitContentAtOffset(block.content, start)
  const [, after] = splitContentAtOffset(rest, end - start)
  const text = input.text.trim().length > 0 ? input.text : url
  const link: ContentFragment = { t: 'link', v: text, url }

  return {
    id: crypto.randomUUID(),
    timestamp: now,
    source: 'user',
    operations: [{
      type: 'update',
      opId: crypto.randomUUID(),
      blockId,
      changes: { content: [...before, link, ...after] },
      previous: { content: block.content },
    }],
  }
}

/**
 * `[[页面|别名` 的查询解析（`09-桌面端交互规范` §6.13 `R09-ALIAS-1`：别名**只做显示**）。
 *
 * `|` 之前是**筛选关键词**，之后是**显示文字**——它会被写进行内引用的 `v`（写入那一刻的文字，
 * 不随目标改名变化）。**数据不动**：没有别名字段、没有「一页多名」，页面只有一个名字，
 * 别名只是某条链接自己的显示文字。不带 `|`、或 `|` 后为空时，显示文字回落成候选自己的标签。
 */
export function parseRefQuery(query: string): { needle: string; display: string | null } {
  const index = query.indexOf('|')
  if (index < 0) return { needle: query.trim(), display: null }
  return { needle: query.slice(0, index).trim(), display: query.slice(index + 1).trim() || null }
}

/** 对象候选的区分提示：页内摘要（首行之外的第一个非空块），没有则「空页面」。 */
function objectHint(blocks: BlockMap, pageId: string): string {
  const page = blocks.get(pageId)
  if (!page) return '对象'
  const stack = [...page.children]
  while (stack.length > 0) {
    const id = stack.shift()!
    const block = blocks.get(id)
    if (!block || block.deleted) continue
    const text = block.content.map((fragment) => fragment.v).join('').trim()
    if (text.length > 0) return text.slice(0, 18)
    stack.push(...block.children)
  }
  return '空页面'
}

/**
 * V2a T13 object/Block search source. Deleted targets never surface.
 *
 * 两条自引用都排掉（`docs/02`「自引用……不写半成品」、`11` `REF-LINK-4`「自引用被拒」）：
 * ① **同一个块**（光标所在块自己）；② **本篇**——从正文块回头引用它所在的页面。
 * 第二条 2026-10-04 补（台账 D-014）：此前只排了①，于是「一篇页面的正文块引用本篇」既能被选中、
 * 也真能插进去，结果是这一页的反链面板把自己页里的块算成「引用了我」。
 * **同页的其它块照旧都在**（`((` 引本页上文是常用写法，候选里标「本页」）。
 */
export function searchRefTargets(
  blocks: BlockMap,
  kind: RefKind,
  query: string,
  fromId: string,
  options: {
    /**
     * 把自己所在的那篇页面也放进候选。默认**不放**（行内引用 `[[` 的规矩，见上面 D-014 那条）；
     * 嵌入块的「选择来源」要放——嵌本页的一个小节是常用写法，那里没有自引用的问题
     * （自引用与祖先由 `setEmbedSource` 单独拒，`R09-BLOCK-24`）。
     */
    includeOwnPage?: boolean
  } = {},
): RefCandidate[] {
  const needle = parseRefQuery(query).needle.toLowerCase()
  const ownPageId = owningPageId(blocks, fromId)
  const candidates: RefCandidate[] = []
  for (const block of blocks.values()) {
    if (block.deleted || block.entityId === fromId) continue
    if (ownPageId !== null && block.entityId === ownPageId && !options.includeOwnPage) continue
    if (kind === 'object') {
      if (!block.isObject) continue
      const label = block.objectName ?? ''
      if (needle && !label.toLowerCase().includes(needle)) continue
      // 同名页面必须能区分（docs/04 §3）：提示给出**页内摘要**（首行之外的第一个非空块），
      // 没有别的文字就说「空页面」——同名时这一列就是唯一的区分依据。
      candidates.push({ targetId: block.entityId, label: label || '(未命名对象)', hint: objectHint(blocks, block.entityId) })
    } else {
      // 块引用的候选要说人话：标签是块自己的文字（空块给占位、页面容器给页名），
      // 提示是它所在的页面——此前提示直接写内部 blockUid，用户看不懂。
      const label = refLabel(block)
      if (needle && !label.toLowerCase().includes(needle)) continue
      candidates.push({ targetId: block.entityId, label, hint: owningPageLabel(blocks, block.entityId) })
    }
  }
  return candidates
    .sort((left, right) => left.label.localeCompare(right.label) || left.targetId.localeCompare(right.targetId))
    .slice(0, MAX_CANDIDATES)
}

/**
 * 引用的**显示名**（`((` / `[[` 共用一套）：页面容器用页名，普通块用正文（空白折叠）、空块给占位。
 *
 * 单一所有者：候选菜单的标签与「复制为块引用」写进剪贴板的文字都从这里取——
 * 插进文档的行内引用 `v` 就是它（见 `insertInlineRef` 的 `displayText`），三处必须一致，
 * 否则用户看到的候选与贴出去的文字会不一样。
 */
export function refLabel(block: Block): string {
  const text = textContent(block).replace(/\s+/g, ' ').trim()
  return block.isObject ? (block.objectName ?? '(未命名页面)') : text || '（空块）'
}

/** 候选的所属页面名（沿 parent 走到根上的对象块）：块引用候选与嵌入卡标题共用。 */
export function owningPageLabel(blocks: BlockMap, blockId: string): string {
  let cursor: string | null = blockId
  while (cursor) {
    const block = blocks.get(cursor)
    if (!block) break
    if (block.isObject) return block.objectName ?? '未命名页面'
    cursor = block.parent
  }
  return '本页'
}

/**
 * `[[` / `((` 触发词的准备（工具条「选中文字 → 转页面链接」与光标处插入共用）：
 * 把块内 [start, start + length) 这段文字换成「触发词 + 原文」——原文原样留在原地，
 * 随后候选菜单把「触发词 + 查询词」整段换成 inline-ref（见 insertInlineRef）。
 *
 * length 为 0 表示没有选中文字：只在光标处插入一个触发词，之后走打字触发的筛选行为。
 * 越界或空操作返回 null（调用方不改数据、不产生 transaction）。
 */
export function insertRefTrigger(
  content: ContentFragment[],
  start: number,
  length: number,
  trigger: RefTrigger,
): ContentFragment[] | null {
  const total = content.reduce((count, fragment) => count + fragment.v.length, 0)
  if (start < 0 || length < 0 || start + length > total) return null
  const [head, rest] = splitContentAtOffset(content, start)
  const [removed, tail] = splitContentAtOffset(rest, length)
  if (length > 0 && removed.length === 0) return null
  const original = removed.map((fragment) => fragment.v).join('')
  return [...head, { t: 'text', v: trigger + original }, ...tail]
}

/**
 * V2a T13: accepting a `[[`/`((` suggestion is one transaction that atomically
 * (1) replaces the trigger + query with an `inline-ref` fragment and
 * (2) writes the object/Block ref (with its backRef). One undo restores both.
 *
 * 触发词可以在块内**任意位置**（`offset`）：打字触发时它是块尾后缀（省略 offset 的默认行为），
 * 工具条「选中文字 → 转链接」时它在文字中间——两条路共用这一条领域通路（docs/09 §6.9）。
 *
 * Contract no-ops return null: missing/deleted target, self reference, an
 * object link to a non-object, or a missing trigger. Closing the menu, Esc or
 * deleting the trigger therefore never writes a half ref and keeps the text.
 */
export function insertInlineRef(
  blocks: BlockMap,
  fromId: string,
  kind: RefKind,
  targetId: string,
  input: {
    trigger: RefTrigger
    query: string
    displayText: string
    /**
     * 触发词在块内行内文字里的起始下标；省略时按「触发词 + 查询词是块尾后缀」处理（打字触发的老契约）。
     * 工具条那条路是「选中一段文字 → 变链接」，触发词落在文字中间，所以要显式给下标（见 docs/09 §6.9）。
     */
    offset?: number
  },
  now = Date.now(),
): Omit<Transaction, 'inverse'> | null {
  const from = blocks.get(fromId)
  const target = blocks.get(targetId)
  if (!from || from.deleted) return null
  if (!target || target.deleted) return null
  if (fromId === targetId) return null
  // 页级自引用也拒（`02`「自引用……不写半成品」、`11` `REF-LINK-4`）：`[[` 不能把一篇页面
  // 链回它自己，`((` 也不能把「本篇」这个页面容器链回自己页里的块——两者都会让这一页的反链
  // 面板把自己算成来源（台账 D-014）。**同页其它块照旧允许**：那是「引本页上文」的常用写法。
  if (targetId === owningPageId(blocks, fromId)) return null
  if (kind === 'object' && !target.isObject) return null

  const removeLength = TRIGGER_LENGTH + input.query.length
  const total = from.content.reduce((count, fragment) => count + fragment.v.length, 0)
  if (removeLength <= 0 || removeLength > total) return null
  const start = input.offset === undefined ? total - removeLength : input.offset
  if (start < 0 || start + removeLength > total) return null
  const [before, rest] = splitContentAtOffset(from.content, start)
  const [removed, after] = splitContentAtOffset(rest, removeLength)
  if (removed.map((fragment) => fragment.v).join('') !== input.trigger + input.query) return null

  const reference: ContentFragment = {
    t: 'inline-ref',
    v: input.displayText,
    ref: { kind, targetId },
  }

  const operations: Operation[] = [{
    type: 'update',
    opId: crypto.randomUUID(),
    blockId: fromId,
    changes: { content: [...before, reference, ...after] },
    previous: { content: from.content },
  }]
  if (kind === 'object') {
    operations.push({ type: 'object-ref', opId: crypto.randomUUID(), fromId, targetId })
  } else {
    operations.push({ type: 'block-ref', opId: crypto.randomUUID(), fromId, targetId, refType: 'link' })
  }

  return { id: crypto.randomUUID(), operations, timestamp: now, source: 'user' }
}

/** 嵌入块来源候选的条数上限（页面在前、块在后，两张表一起算）。 */
const EMBED_CANDIDATE_MAX = 12

/** 嵌入来源候选：`RefCandidate` 加上它属于哪一档（对话框在行尾标出来）。 */
export type EmbedCandidate = RefCandidate & { kind: RefKind }

/**
 * 「选择来源页面 / 块」的候选（13-媒体设计（已归档） §8、`R09-BLOCK-24`）——**页面在前、块在后**，
 * 与 `[[` / `((` 菜单共用同一个搜索源（`searchRefTargets`）。两处差别只有一条：
 * 这里**含本页**（嵌本页的小节是常用写法）。
 *
 * **自己与自己的祖先不进候选**：嵌入把源子树摊开渲染，源子树里正好含这个嵌入块 ⇒ 无限递归；
 * 「嵌入块所在的那一页」也在这条里（页面容器就是它的祖先），所以候选里看不到自己这一篇。
 * `setEmbedSource` 有同一条判据兜底（候选之外还有别的写入路径）。
 */
export function searchEmbedTargets(blocks: BlockMap, query: string, fromId: string): EmbedCandidate[] {
  return [
    ...searchRefTargets(blocks, 'object', query, fromId, { includeOwnPage: true }).map((item) => ({ ...item, kind: 'object' as const })),
    ...searchRefTargets(blocks, 'block', query, fromId, { includeOwnPage: true }).map((item) => ({ ...item, kind: 'block' as const })),
  ]
    .filter((item) => !isSelfOrAncestor(blocks, fromId, item.targetId))
    .slice(0, EMBED_CANDIDATE_MAX)
}

/**
 * 嵌入块的来源（13-媒体设计（已归档） §8）：一个嵌入块**至多一条** `embed` 引用
 * （0 条 = 还没选来源，就是原型那张「选择来源页面 / 块」空态卡）。
 * 上限由 `validation` 的 `embed-ref-invalid` 兜底（载入外部文件时的最后一道闸）。
 */
export function embedTarget(block: Block): string | null {
  return block.blockRefs.find((ref) => ref.type === 'embed')?.targetBlockId ?? null
}

/**
 * 设置 / 更换 / 清除嵌入块的来源（13-媒体设计（已归档） §8「选源 / 换源」）。
 *
 * **一次事务、一个撤销步**：旧的至多一条 `embed` 引用先 `block-unref`，新的再 `block-ref`——
 * 两笔操作在同一事务里（`apply` 一次 = 撤销一次）。分两次写就会变成两步撤销，
 * 用户按一次 ⌘Z 只回到「没有来源」的中间态（`04` §5「每个用户可理解的结构动作最多占一个撤销步」）。
 *
 * 契约 no-op 返回 null：源块不存在 / 已删 / 不是嵌入块 / 自引用或**指向自己的祖先** / 目标没变。
 * 祖先那一条的理由：卡片把源块子树摊开渲染，源子树里正好含这个嵌入块 ⇒ 无限递归
 * （导出侧同样摊开快照，一起炸）。判据住 `treeOps.isSelfOrAncestor`，`validation` 载入兜底用同一条。
 * 传 `null` = 清除来源（回到空态卡），用于「换源」前的清空与手动去掉来源。
 */
export function setEmbedSource(
  blocks: BlockMap,
  fromId: string,
  targetId: string | null,
  now = Date.now(),
): Omit<Transaction, 'inverse'> | null {
  const from = blocks.get(fromId)
  if (!from || from.deleted || from.type !== 'embed') return null
  const current = embedTarget(from)
  if (targetId === null) {
    if (current === null) return null
  } else {
    const target = blocks.get(targetId)
    if (!target || target.deleted) return null
    if (isSelfOrAncestor(blocks, fromId, targetId)) return null
    if (current === targetId) return null
  }

  const operations: Operation[] = []
  if (current !== null) {
    operations.push({ type: 'block-unref', opId: crypto.randomUUID(), fromId, targetId: current, refType: 'embed' })
  }
  if (targetId !== null) {
    operations.push({ type: 'block-ref', opId: crypto.randomUUID(), fromId, targetId, refType: 'embed' })
  }
  return { id: crypto.randomUUID(), operations, timestamp: now, source: 'user' }
}

/** 嵌入卡要显示的一切（13-媒体设计（已归档） §8）：标题两段 + 引用内容 + 跳转目标。 */
export type EmbedView = {
  state: 'ok' | 'dangling'
  /** 标题前半段：源块所在页面名。 */
  pageLabel: string
  /** 标题后半段：源块自己的标签；**目标是整页时为空**（标题就只是页名，不写「页 › 页」）。 */
  blockLabel: string
  /** 引用内容：逐行文字，缩进已含（子块两格一层）。 */
  lines: string[]
  /** 被上限截掉的行数（0 = 没截；导出侧不截，见 `exportMd` 的嵌入分支）。 */
  hiddenLines: number
  /** 「来源 ↗」的跳转目标（源块所在页面）；悬空时为 null。 */
  sourcePageId: string | null
}

/** 卡片正文的行数 / 字数上限：引用是「看一眼」，源块可能几千行（`03` §11.1 的进页面预算）。 */
const EMBED_BODY_MAX_LINES = 24
const EMBED_BODY_MAX_CHARS = 1600

/** 块在嵌入卡正文里的一行文字：媒体块不展开资产，给可读占位（资产是文件，不是文字）。 */
function embedInlineLabel(blocks: BlockMap, block: Block): string {
  switch (block.type) {
    case 'divider':
      return '———'
    case 'image': {
      const caption = textContent(block).replace(/\s+/g, ' ').trim()
      return caption ? `［图片］${caption}` : '［图片］'
    }
    case 'file':
      return `［附件］${block.asset?.originalName ?? '附件'}`
    case 'embed': {
      const target = embedTarget(block)
      return `［嵌入］${target ? refLabel(blocks.get(target) ?? block) : ''}`
    }
    default:
      return textContent(block)
  }
}

/** 源块子树 → 逐行文字（只读快照；已删的块不进，块内换行按行拆）。 */
function embedBodyLines(blocks: BlockMap, root: Block): string[] {
  const out: string[] = []
  const walk = (block: Block, depth: number): void => {
    const indent = '  '.repeat(Math.min(depth, 6))
    for (const line of embedInlineLabel(blocks, block).split('\n')) {
      const text = line.trim()
      if (text) out.push(indent + text)
    }
    for (const childId of block.children) {
      const child = blocks.get(childId)
      if (child && !child.deleted) walk(child, depth + 1)
    }
  }
  walk(root, 0)
  return out
}

/**
 * 嵌入卡的显示数据（`R09-BLOCK-24` 的单一所有者）：卡片标题、正文、跳转目标全从这里出。
 * 返回 null = 这个块不是嵌入块，或**还没选来源**（空态卡由 CSS 画，「选择来源」是交互不是数据）。
 * 源块被删 / 彻底删除 → `dangling`（降级占位「来源已删除」，反链计数照旧含这条引用）。
 */
export function embedViewOf(blocks: BlockMap, embedBlockId: string): EmbedView | null {
  const block = blocks.get(embedBlockId)
  if (!block || block.type !== 'embed') return null
  const targetId = embedTarget(block)
  if (targetId === null) return null
  const target = blocks.get(targetId)
  if (!target || target.deleted) {
    return { state: 'dangling', pageLabel: '', blockLabel: '', lines: [], hiddenLines: 0, sourcePageId: null }
  }

  const all = embedBodyLines(blocks, target)
  const lines: string[] = []
  let used = 0
  for (const line of all) {
    if (lines.length >= EMBED_BODY_MAX_LINES || used + line.length > EMBED_BODY_MAX_CHARS) break
    lines.push(line)
    used += line.length
  }
  return {
    state: 'ok',
    pageLabel: owningPageLabel(blocks, target.entityId),
    blockLabel: target.isObject ? '' : refLabel(target),
    lines,
    hiddenLines: all.length - lines.length,
    sourcePageId: owningPageId(blocks, target.entityId),
  }
}
