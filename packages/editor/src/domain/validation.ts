/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createTextBlock, MAX_PINNED_PAGES, type Block, type BlockMap } from './block'
import { newBlockUid } from './typeOps'
import { isSelfOrAncestor } from './treeOps'

export type ValidationIssue = {
  code: string
  blockId?: string
  message: string
}

const propertyValueTypes = new Set<unknown>(['text', 'number', 'date', 'checkbox', 'select'])

const allowedTypes = new Set<Block['type']>([
  'text',
  'heading1',
  'heading2',
  'heading3',
  'heading4',
  'heading5',
  'heading6',
  'bullet',
  'numbered',
  'quote',
  'code',
  'divider',
  'todo',
  'image',
  'file',
  'embed',
])

/**
 * 外部链接的地址判据（`09-桌面端交互规范` §6.13 `R09-ELINK-2`）：`http(s)://` 或 `mailto:`
 * 开头、且**不含空格**的字符串。`null` = 合法；否则是给用户看的原因——对话框的「确定」
 * 禁用理由与 `validation` 的 `link-url-invalid` 共用这一份，判据只有一个所有者。
 */
export function webUrlError(url: string): string | null {
  const value = url.trim()
  if (value.length === 0) return '先填一个地址'
  if (/\s/.test(value)) return '地址里不能有空格'
  if (!/^(https?:\/\/|mailto:)/i.test(value)) return '只认 http:// · https:// · mailto: 开头的地址'
  return null
}

export function validateBlockShape(block: Block): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (!block.entityId) issues.push({ code: 'entity-id-required', blockId: block.entityId, message: 'entityId 不能为空' })
  if (!block.blockUid) issues.push({ code: 'block-uid-required', blockId: block.entityId, message: 'blockUid 不能为空' })
  if (!allowedTypes.has(block.type)) issues.push({ code: 'unsupported-type', blockId: block.entityId, message: `不支持的 Block 类型: ${block.type}` })
  if (typeof block.checked !== 'boolean') issues.push({ code: 'checked-required', blockId: block.entityId, message: 'checked 必须是布尔值' })
  if (typeof block.position !== 'number' || !Number.isFinite(block.position)) issues.push({ code: 'position-required', blockId: block.entityId, message: 'position 必须是有限数值' })
  if (!Array.isArray(block.properties)) issues.push({ code: 'properties-array-required', blockId: block.entityId, message: 'properties 必须是数组' })
  else {
    for (const raw of block.properties as unknown[]) {
      if (!raw || typeof raw !== 'object') {
        issues.push({ code: 'property-value-invalid', blockId: block.entityId, message: '属性值必须是对象' })
        continue
      }
      const property = raw as Record<string, unknown>
      const type = property.type
      const valueMatches = type === 'select'
        ? typeof property.optionId === 'string'
        : type === 'number'
          ? typeof property.value === 'number' && Number.isFinite(property.value)
          : type === 'checkbox'
            ? typeof property.value === 'boolean'
            : typeof property.value === 'string'
      if (typeof property.defId !== 'string' || !propertyValueTypes.has(type) || !valueMatches) {
        issues.push({ code: 'property-value-invalid', blockId: block.entityId, message: '属性值必须包含 defId 与类型匹配的 value/optionId' })
      }
    }
  }
  // 属性面板的本页两档（`属性区重规划（已归档）` §0-1/§0-3/§0-10）：**可缺省**（旧数据由
  // `serialization.normalizeBlock` 补成 `[]`）；一旦出现就必须是数组。不设 required 码的理由：
  // 历史上手写的块（测试种子 / 导入草稿）不带这两个字段，报 required 会把它们全判成形状错。
  if (block.propertyShown !== undefined && !Array.isArray(block.propertyShown)) issues.push({ code: 'property-shown-invalid', blockId: block.entityId, message: 'propertyShown 必须是数组' })
  if (block.propertyHidden !== undefined && !Array.isArray(block.propertyHidden)) issues.push({ code: 'property-hidden-invalid', blockId: block.entityId, message: 'propertyHidden 必须是数组' })
  if (!Array.isArray(block.content)) issues.push({ code: 'content-array-required', blockId: block.entityId, message: 'content 必须是数组' })
  else {
    for (const fragment of block.content) {
      if (!fragment || typeof fragment.v !== 'string') {
        issues.push({ code: 'content-fragment-invalid', blockId: block.entityId, message: 'content 片段必须包含文本 v' })
        continue
      }
      // T13: only `inline-ref` fragments may carry a jump target, and it must be usable.
      if (fragment.ref && fragment.t !== 'inline-ref') issues.push({ code: 'ref-binding-only-on-inline-ref', blockId: block.entityId, message: 'ref 绑定只能出现在 inline-ref 片段上' })
      else if (fragment.ref && (!fragment.ref.targetId || (fragment.ref.kind !== 'object' && fragment.ref.kind !== 'block'))) {
        issues.push({ code: 'inline-ref-binding-invalid', blockId: block.entityId, message: 'inline-ref 的 ref 必须包含合法的 kind 和 targetId' })
      }
      // `R09-ELINK-*`：`url` 只出现在 `link` 片段上，且必须是能打开的外部地址（对称于上面两条）。
      if (fragment.url !== undefined && fragment.t !== 'link') issues.push({ code: 'url-binding-only-on-link', blockId: block.entityId, message: 'url 只能出现在 link 片段上' })
      else if (fragment.url !== undefined && webUrlError(fragment.url) !== null) {
        issues.push({ code: 'link-url-invalid', blockId: block.entityId, message: `link 的 url 不是可打开的外部地址：${fragment.url}` })
      }
    }
  }
  // 媒体块（13-媒体设计（已归档） §2）：图片 / 附件必须有 payload、别的类型不许有、字段要合法、嵌入的引用至多一条。
  // 四条都只**报告**、不进 `STRUCTURAL_CODES`——「文件缺失 / payload 坏了」正是用户该能删掉那块来修的场面，
  // 挡在写入路径上会让人连修都修不了（与 `content-fragment-invalid` 同一条教训）。
  const asset = block.asset ?? null
  if (block.type === 'image' || block.type === 'file') {
    if (!asset) {
      issues.push({ code: block.type === 'image' ? 'image-payload-required' : 'file-payload-required', blockId: block.entityId, message: '图片 / 附件块必须带 payload' })
    } else {
      const badShape = !asset.fileName || !asset.originalName || !asset.mime
        || !Number.isFinite(asset.size) || asset.size < 0
        || (asset.width !== undefined && (!Number.isFinite(asset.width) || asset.width <= 0))
        || (asset.height !== undefined && (!Number.isFinite(asset.height) || asset.height <= 0))
      if (badShape) issues.push({ code: 'asset-fields-invalid', blockId: block.entityId, message: `payload 字段不合法：${JSON.stringify(asset)}` })
    }
  } else if (asset) {
    issues.push({ code: 'asset-fields-invalid', blockId: block.entityId, message: '只有图片 / 附件块能带 payload' })
  }
  if (block.type === 'embed' && block.blockRefs.filter((ref) => ref.type === 'embed').length > 1) {
    issues.push({ code: 'embed-ref-invalid', blockId: block.entityId, message: '嵌入块至多一条 embed 引用（0 条 = 还没选来源）' })
  }
  if (!Array.isArray(block.children)) issues.push({ code: 'children-array-required', blockId: block.entityId, message: 'children 必须是数组' })
  if (block.isObject && !block.objectName) issues.push({ code: 'object-name-required', blockId: block.entityId, message: '对象 Block 必须有 objectName' })
  if (!block.isObject && block.objectName !== null) issues.push({ code: 'object-name-must-be-null', blockId: block.entityId, message: '普通 Block 的 objectName 必须为 null' })
  // V2b: `pinned` / `starred` are page-level (roots only). Kept as shape codes so
  // "置顶是页面级能力" is a verifiable invariant, not a convention.
  if (block.pinned && !block.isObject) issues.push({ code: 'pinned-must-be-false-on-non-object', blockId: block.entityId, message: '只有对象 Block（页面）可以置顶' })
  if (block.starred && !block.isObject) issues.push({ code: 'starred-must-be-false-on-non-object', blockId: block.entityId, message: '只有对象 Block（页面）可以星标' })
  if (block.aiMeta !== null && block.aiMeta !== undefined) {
    const meta = block.aiMeta as unknown as Record<string, unknown>
    // 与 AiAction / AiStatus 联合类型保持一致：新增动作或状态时必须同步这里。
    // 与 `serialization.ts` 的载入白名单、`AI_ACTION_LABEL` 的键三处同步（V2c 起是 7 项）。
    const validAction = (['summary', 'actions', 'ask', 'polish', 'expand', 'askback', 'reframe'] as string[]).includes(String(meta.action))
    const validStatus = meta.status === 'generating' || meta.status === 'complete' || meta.status === 'needs-confirmation'
      || meta.status === 'cancelled' || meta.status === 'error' || meta.status === 'accepted'
    if (!validAction || !validStatus || !Array.isArray(meta.sourceBlockIds)) {
      issues.push({ code: 'ai-meta-invalid', blockId: block.entityId, message: 'aiMeta 必须包含合法的 action、status 与 sourceBlockIds' })
    } else {
      // T20: accepted/needs-confirmation AI results must trace back to sources;
      // cancelled or errored runs may legitimately end with none.
      const hasSources = (meta.sourceBlockIds as unknown[]).length > 0
      if (!hasSources && (meta.status === 'complete' || meta.status === 'needs-confirmation')) {
        issues.push({ code: 'ai-meta-source-required', blockId: block.entityId, message: '已完成或待确认的 aiMeta 必须包含非空 sourceBlockIds' })
      }
    }
  }
  return issues
}

export function validateBlockGraph(blocks: BlockMap): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const blockUids = new Set<string>()

  for (const [id, block] of blocks) {
    if (id !== block.entityId) issues.push({ code: 'map-key-mismatch', blockId: id, message: 'Map key 必须等于 entityId' })
    issues.push(...validateBlockShape(block))
    if (blockUids.has(block.blockUid)) issues.push({ code: 'duplicate-block-uid', blockId: id, message: `重复的 blockUid: ${block.blockUid}` })
    blockUids.add(block.blockUid)
    // 页面名允许重复（docs/04 §3 的 R04-NAME-6）：链接靠 targetId（entityId）指向，不靠名字；
    // 歧义只在候选消歧里处理，仅「复制页面」的程序生成名走 availableCopyName 避让。
    // 存储层没有 UNIQUE(object_name) 约束，这里也不报唯一性错误——历史版本曾报 duplicate-object-name，已废弃。
    if (!block.deleted && block.parent !== null) {
      const parent = blocks.get(block.parent)
      if (!parent) issues.push({ code: 'missing-parent', blockId: id, message: `父 Block 不存在: ${block.parent}` })
      else if (!parent.children.includes(id)) issues.push({ code: 'parent-child-mismatch', blockId: id, message: 'parent 指向的 children 未包含当前 Block' })
    }
    if (block.deleted) continue
    const childSet = new Set<string>()
    for (const childId of block.children) {
      if (childSet.has(childId)) issues.push({ code: 'duplicate-child', blockId: id, message: `children 中重复: ${childId}` })
      childSet.add(childId)
      const child = blocks.get(childId)
      if (!child) issues.push({ code: 'missing-child', blockId: id, message: `子 Block 不存在: ${childId}` })
      else if (child.deleted) issues.push({ code: 'deleted-child-in-active-tree', blockId: id, message: `活动树不能包含已删除子 Block: ${childId}` })
      else if (child.parent !== id) issues.push({ code: 'child-parent-mismatch', blockId: id, message: `子 Block ${childId} 的 parent 不一致` })
    }
    // T20: active blocks must never reference a target missing from the map;
    // targets marked deleted stay legal because backlink rendering filters them.
    for (const fragment of block.content) {
      if (fragment.t !== 'inline-ref' || !fragment.ref) continue
      if (!blocks.has(fragment.ref.targetId)) {
        issues.push({ code: 'dangling-inline-ref', blockId: id, message: `inline-ref 目标不存在: ${fragment.ref.targetId}` })
      }
    }
    for (const ref of block.blockRefs) {
      if (!blocks.has(ref.targetBlockId)) issues.push({ code: 'dangling-block-ref', blockId: id, message: `块级引用目标不存在: ${ref.targetBlockId}` })
      // 嵌入块指向自己 / 自己的祖先 ⇒ 源子树摊开渲染时无限递归（13-媒体设计（已归档） §8）。
      // 写入侧 `setEmbedSource` 已经拦住，这里是**载入外部文件 / 同步进来**的最后一道闸
      // （与上面几条一样只报告，站在写入路径上会让人连删掉那块都做不到）。
      else if (ref.type === 'embed' && isSelfOrAncestor(blocks, id, ref.targetBlockId)) {
        issues.push({ code: 'embed-ref-invalid', blockId: id, message: '嵌入来源指向自己或自己的祖先（会递归展开）' })
      }
    }
    for (const targetId of block.objectRefs) {
      if (!blocks.has(targetId)) issues.push({ code: 'dangling-object-ref', blockId: id, message: `对象引用目标不存在: ${targetId}` })
    }
  }

  for (const block of blocks.values()) {
    const seen = new Set<string>()
    let cursor: string | null = block.entityId
    while (cursor !== null) {
      if (seen.has(cursor)) {
        issues.push({ code: 'cycle', blockId: block.entityId, message: 'Block 树存在环' })
        break
      }
      seen.add(cursor)
      cursor = blocks.get(cursor)?.parent ?? null
    }
  }

  // V2b: at most `MAX_PINNED_PAGES` pinned pages. **Report-only — deliberately NOT in
  // `STRUCTURAL_CODES`**: a data state holding too many pins (e.g. merged in from a build
  // without the cap) must not turn every write into a rejection — that is precisely the
  // 「能看不能写」failure the STRUCTURAL_CODES comment above warns about. The real gate
  // lives in the domain operation (`store.setPinned`), which refuses and writes nothing.
  const pinnedPages = [...blocks.values()].filter((block) => !block.deleted && block.isObject && block.pinned)
  for (const block of pinnedPages.slice(MAX_PINNED_PAGES)) {
    issues.push({ code: 'pinned-limit-exceeded', blockId: block.entityId, message: `置顶页面超过 ${MAX_PINNED_PAGES} 个` })
  }
  return issues
}

/**
 * 只有**结构性错误**才拒绝写入（docs/04 §2「保存契约」）。
 *
 * 区分两类问题（ 用户实测后定案）：
 * - **结构性错误**（父链断裂、缺字段、成环……）：块图本身不自洽，写入必须拒绝（原子回滚）。
 * - **引用悬空**（`dangling-inline-ref` / `dangling-block-ref` / `dangling-object-ref`）：**报告但不阻断**。
 *   回收站里的页面/块不在活跃块图里（`list_active` 只加载未删除的块），引用它**是合法状态**、且 30 天内可恢复；
 *   把它当错误拒绝写入的后果极其严重——含这类引用的页面**连删除、连打字都会被拦**，
 *   表现成「弹窗点确认没反应 / 整页变成只读」。改动一处引用（或删掉整页）正是修复它的手段，
 *   所以这条绝不能挡在写入路径上。
 */
const STRUCTURAL_CODES = new Set([
  'entity-id-required', 'block-uid-required', 'unsupported-type', 'checked-required',
  'position-required', 'properties-array-required', 'property-value-invalid',
  'property-shown-invalid', 'property-hidden-invalid',
  'content-array-required', 'content-fragment-invalid', 'ref-binding-only-on-inline-ref',
  'inline-ref-binding-invalid', 'url-binding-only-on-link', 'link-url-invalid',
  'children-array-required', 'object-name-required',
  'object-name-must-be-null', 'ai-meta-invalid', 'ai-meta-source-required',
  'map-key-mismatch', 'duplicate-block-uid', 'missing-parent',
  'parent-child-mismatch', 'duplicate-child', 'missing-child', 'deleted-child-in-active-tree',
  'child-parent-mismatch', 'cycle',
])

/**
 * 这个形状码是不是**结构性**的（拒绝写入）。**载入面**（`serialization.parseBlockForLoad`）也用它：
 * 报告级的码（媒体四条、`pinned` / `starred` 两条……）没有理由挡启动——那些数据的修法就是
 * 「进应用 → 删掉那一块」，挡在载入上等于连修的机会都没有（ 属性批·审计；此前
 * `parseBlock` 对**任何**形状问题都抛，桌面端遇到一行这类数据会整屏「无法恢复项目 B」）。
 */
export function isStructuralCode(code: string): boolean {
  return STRUCTURAL_CODES.has(code)
}

export function assertValidBlockGraph(blocks: BlockMap): void {
  const issues = validateBlockGraph(blocks).filter((issue) => STRUCTURAL_CODES.has(issue.code))
  // 报错必须能定位到块：这条消息会原样进 toast / 控制台，缺 blockId 时只能靠翻库对账
 // （ 的 parent-child-mismatch 就是这么查出来的）。
  if (issues.length > 0) {
    throw new Error(issues.map((issue) => `${issue.code}${issue.blockId ? `@${issue.blockId}` : ''}: ${issue.message}`).join('; '))
  }
}

/**
 * 载入自愈：丢掉指向不存在 Block 的 children 引用。
 * 只要出现过一次「子块未落库」的写入（例如保存中断），父块就会引用一个不存在的子块，
 * 之后任何 apply 都会被 assertValidBlockGraph 拒绝，软件表现为「能看不能写」。
 * 这类引用不携带任何可恢复信息（目标内容确实丢了），因此载入时直接清理并上报数量。
 */
export function dropDanglingChildren(blocks: Block[]): { blocks: Block[]; repairedBlockIds: string[]; removed: number } {
  const ids = new Set(blocks.map((block) => block.entityId))
  const repairedBlockIds: string[] = []
  let removed = 0
  const next = blocks.map((block) => {
    const kept = block.children.filter((childId) => ids.has(childId))
    if (kept.length === block.children.length) return block
    removed += block.children.length - kept.length
    repairedBlockIds.push(block.entityId)
    return { ...block, children: kept }
  })
  return { blocks: next, repairedBlockIds, removed }
}

/**
 * 载入自愈第二道：把「parent 指着某个父块、却不在那个父块的 children 里」的 Block 收回去。
 *
 * 这一类不一致会让块图**长期**不自洽：`assertValidBlockGraph` 之后会拒绝每一次领域写入，
 * 而 Lexical 侧照旧能打字——用户看到的正是「缩进 / 反缩进 / 行尾 ＋ / 类型转换全部没反应，
 * 字却还能敲进去」（ 实测：5 个空块漏记 children，整篇编辑器变成只读，
 * 根因是子块与父块 children 分两次落库、其中一次丢了）。
 *
 * 位置按 `position` 判定（域内每次插入 / 移动都会对同一父块归一化 position）：
 * 插到第一个 position 更大的同级之前，没有更大的就接到末尾——顺序不会因自愈被打乱。
 * `parent` 指向不存在的 Block 时降级成根块：宁可暂时不在页面里出现，也不能让整篇写不进去。
 */
export function adoptOrphanedChildren(blocks: Block[]): {
  blocks: Block[]
  adopted: number
  adoptedBlockIds: string[]
  rootedBlockIds: string[]
} {
  const byId = new Map(blocks.map((block) => [block.entityId, block]))
  const orphansByParent = new Map<string, string[]>()
  const rootedBlockIds: string[] = []
  for (const block of blocks) {
    if (block.deleted || block.parent === null) continue
    const parent = byId.get(block.parent)
    if (!parent) {
      rootedBlockIds.push(block.entityId)
      continue
    }
    if (parent.children.includes(block.entityId)) continue
    orphansByParent.set(block.parent, [...(orphansByParent.get(block.parent) ?? []), block.entityId])
  }
  if (orphansByParent.size === 0 && rootedBlockIds.length === 0) {
    return { blocks, adopted: 0, adoptedBlockIds: [], rootedBlockIds: [] }
  }

  const rooted = new Set(rootedBlockIds)
  const adoptedBlockIds: string[] = []
  const next = blocks.map((block) => {
    if (rooted.has(block.entityId)) return { ...block, parent: null }
    const orphans = orphansByParent.get(block.entityId)
    if (!orphans) return block
    const children = [...block.children]
    for (const orphanId of orphans) {
      const orphan = byId.get(orphanId)!
      const position = (childId: string) => byId.get(childId)?.position ?? Number.MAX_SAFE_INTEGER
      const index = children.findIndex((childId) => position(childId) > orphan.position)
      children.splice(index < 0 ? children.length : index, 0, orphanId)
      adoptedBlockIds.push(orphanId)
    }
    return { ...block, children }
  })
  return { blocks: next, adopted: adoptedBlockIds.length, adoptedBlockIds, rootedBlockIds }
}

/**
 * 载入自愈（第四道）：把**老数据里的页面名落进正文首行**（ 用户实测发现）。
 *
 * 「页面名 = 正文首行」之前，名字由独立标题控件写进 `objectName`，正文里没有对应那一行；
 * 改成派生之后，这类页面的名字会回落成「未命名页面」——名字看着就丢了。迁移规则：
 * 对象块**自身内容为空**且 `objectName` 是有意义的名字（非空、非「未命名页面」）时，
 * 把名字写成它的首行内容（名字落进正文，派生随后保持一致）。只在名字会丢的情况下动手。
 */
export function adoptObjectNames(blocks: Block[]): { blocks: Block[]; adopted: { entityId: string; name: string }[] } {
  const adopted: { entityId: string; name: string }[] = []
  const next = blocks.map((block) => {
    if (!block.isObject || block.deleted) return block
    const own = block.content.map((fragment) => fragment.v).join('').trim()
    const name = (block.objectName ?? '').trim()
    if (own.length > 0 || name.length === 0 || name === '未命名页面') return block
    adopted.push({ entityId: block.entityId, name })
    return { ...block, content: [{ t: 'text' as const, v: name }], objectName: name }
  })
  return { blocks: next, adopted }
}

/**
 * 载入自愈（第六道）：**分隔线不承载正文**（`02` §「类型转换」：divider 无正文，原正文挪到
 * 紧随其后的新 `text` 块）。
 *
 * 历史数据里可能带着正文：转换路径曾经只改当前节点，编辑器随后把正文镜像回领域——于是正文
 * 既留在线上、又在下面重复一份（ 用户实测「块里有字转成分隔线」时发现）。这里把
 * 线上那份挪到紧随其后的新块（与转换时的做法一致），线上留空。新块沿用分隔线的 `position`
 * 加半格，**排在其后**，下一次插入时由领域的 `normalizePositions` 归整。
 */
export function adoptDividerBodies(blocks: Block[], now = Date.now()): {
  blocks: Block[]
  adopted: { entityId: string; movedInto: string }[]
} {
  const adopted: { entityId: string; movedInto: string }[] = []
  const siblings = new Map<string, Block>()
  for (const block of blocks) {
    if (block.type !== 'divider' || block.deleted || block.content.length === 0) continue
    const sibling = createTextBlock({ entityId: crypto.randomUUID(), blockUid: newBlockUid(), parent: block.parent, now })
    sibling.content = structuredClone(block.content)
    sibling.position = block.position + 0.5
    siblings.set(block.entityId, sibling)
    adopted.push({ entityId: block.entityId, movedInto: sibling.entityId })
  }
  if (adopted.length === 0) return { blocks, adopted }

  const next: Block[] = []
  for (const block of blocks) {
    const sibling = siblings.get(block.entityId)
    if (sibling) {
      next.push({ ...block, content: [], modified: now })
      next.push(sibling)
      continue
    }
    if (block.children.some((id) => siblings.has(id))) {
      const children = block.children.flatMap((id) => (siblings.has(id) ? [id, siblings.get(id)!.entityId] : [id]))
      next.push({ ...block, children })
      continue
    }
    next.push(block)
  }
  return { blocks: next, adopted }
}
