/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createTextBlock, orderedRootIds, type AiAction, type AiMeta, type AiRequestInfo, type BlockMap } from './block'
import { dedupeSelection, deleteBlocks } from './selectionOps'
import type { Operation, Transaction } from './operation'
import { activePageSubtreeIds } from './treeOps'

export const LOW_CONFIDENCE_THRESHOLD = 0.5

/**
 * T18 (spec §4.6): a result may never masquerade as a confirmed fact. Missing
 * confidence or a score below the threshold downgrades to `needs-confirmation`;
 * an explicit `needs-confirmation` is preserved; only a scored, confident
 * proposal stays `complete`.
 */
export function resolveAiStatus(proposal: { status: 'complete' | 'needs-confirmation'; confidence?: number }): 'complete' | 'needs-confirmation' {
  if (proposal.status === 'needs-confirmation') return 'needs-confirmation'
  if (proposal.confidence === undefined || proposal.confidence < LOW_CONFIDENCE_THRESHOLD) return 'needs-confirmation'
  return 'complete'
}

/**
 * AI 块标签行上的「来源」文案（docs/09 §6.11 R09-AIB-7）：说**范围**，不数块数。
 *
 * 「来源 2 块」这类计数既不说明来自哪里、也不说明是什么（用户 裁决）。
 * 范围是人话：整篇 / 本段 / 选中的 N 段——配合 R09-AIB-6「读什么 ≠ 落哪」，
 * 用户一眼能看出这次 AI 吃的是哪一片内容。
 */
export function aiSourceLabel(input: { sourceCount: number; scope?: 'page' | 'selection' }): string {
  if (input.scope === 'page') return '基于全篇'
  return input.sourceCount <= 1 ? '基于本段' : '基于选中的 ' + input.sourceCount + ' 段'
}

export type AiInsertInput = {
  sourceIds: string[]
  action: AiAction
  items: string[]
  status: AiMeta['status']
  confidence?: number
  request?: AiRequestInfo
  /** 来源范围（写进标签文案，见 aiSourceLabel）。 */
  sourceScope?: 'page' | 'selection'
  /**
   * 结果落在哪个块**之后**（docs/09 §6.11 `R09-AIB-6`：目标块 = 选中块 > 光标块 > 正文最后一块）。
   * 缺省回落到最后一个来源块——**「AI 读什么」与「结果放哪」是两件事**：面板的「基于本篇」读整篇，
  * 结果却该落在光标那一块下面，不是文章末尾（用户实测 ）。
   */
  anchorId?: string | null
  /**
   * 生成期间用来流式承载正文的占位块：结果落库时与结果块**在同一个事务里**替换掉。
   * 分成两次 apply 会让一次「提取行动」占掉两个撤销步（docs/04 §5「最多占一个撤销步」）；
   * 已删除或不存在的 id 由 `dedupeSelection` 自动丢弃。
   */
  removeBlockIds?: string[]
  now?: number
  newId?: () => string
}

/**
 * 一次 AI 请求「读什么」的声明（docs/09 §6.11 `R09-AIB-6`、§6.10 `R09-TXBAR-2`）。
 *
 * 三个字段是**同一件事**的三个面：素材（`sourceIds`）、标签口径（`scope`）、
 * 「这次是不是按块选中发起的」（`byBlockSelection`，只决定落点档位）。它们必须一起产生——
 * 过去调用方只传一个 `string[]`，再由「数组非空」反推口径与档位，于是「整篇」被当成了
 * 「选中了页面容器这一个块」：标签写成「基于本段」、落点落到页面容器自己身上（结果被追加到
 * 页面最末尾）——用户实测 ：「选文本后 AI 生成的块直接生成到文档后面；三种范围全显示基于本段」。
 */
export type AiRequestPlan = {
  /** 来源块（未去重）：整篇入口传页面块 id，**由 `expandAiSources` 展开成子树**。 */
  sourceIds: string[]
  /** 标签口径：整篇 / 选区（本段与选中的 N 段都算选区），见 `aiSourceLabel`。 */
  scope: 'page' | 'selection'
  /** 按块选中发起（块工具栏 / 把手多选）：落点取最后选中的块，而不是光标块。 */
  byBlockSelection: boolean
}

/**
 * 把入口声明展开成**真正送进模型**的来源块列表（`R09-AIB-12` 缺的那一半）。
 *
 * `scope: 'page'` 时页面块要展开成**整棵子树**；其余档原样（选区语义就是那些块）。
 * 为什么单列这一步：`R09-AIB-12` 当年修了「标签怎么说」与「落点在哪」，却漏了**来源列表本身**——
 * 面板宫格（基于本篇）传进来的是 `[pageId]`，`dedupeSelection` 不替它展开（它按「选中即选中」办），
 * 于是六项指令**只把页面名喂给了模型**： 用真实模型实测，「润色」的输出就是「产品路线」
 * 四个字（台账 D-018）。注释里写着「由 dedupeSelection 展开」是一厢情愿，现在由这个函数负责。
 */
export function expandAiSources(blocks: BlockMap, plan: AiRequestPlan): string[] {
  if (plan.scope !== 'page') return [...plan.sourceIds]
  const expanded: string[] = []
  for (const id of plan.sourceIds) {
    const block = blocks.get(id)
    if (block?.isObject) expanded.push(...activePageSubtreeIds(blocks, id))
    else if (block && !block.deleted) expanded.push(id)
  }
  return expanded
}

/**
 * 入口 → 「读什么」的**唯一出口**：块选中 > 光标 / 文字选区所在块 > 整篇。
 *
 * 入口只管说清自己手里有什么（选了块？光标在哪？哪一页？），口径与来源在这里一次定死，
 * 从根上杜绝「素材是整篇、标签却写基于本段」这类漂移。三个真实入口：块工具栏、
 * 文本选中工具栏（作用于选中文字，`R09-TXBAR-2`）、AI 助手面板（基于本篇）。
 */
export function aiSourcePlan(input: {
  /** 块工具栏 / 把手多选选中的块。 */
  selectedBlocks?: string[]
  /** 光标或文字选区所在的正文块（调用方负责确认它在本页、且不是页面容器）。 */
  caretBlockId?: string | null
  /** AI 助手面板的「基于本篇」：传页面块 id。 */
  pageId?: string | null
}): AiRequestPlan {
  const blocks = input.selectedBlocks ?? []
  if (blocks.length > 0) return { sourceIds: [...blocks], scope: 'selection', byBlockSelection: true }
  // 文字选区与折叠光标同档：读「所在块」（来源是块级 provenance，见 `R09-AIB-7`），
  // 落点也因此落在这块下方——`R09-TXBAR-2`「结果插入所在块下方」。
  if (input.caretBlockId) return { sourceIds: [input.caretBlockId], scope: 'selection', byBlockSelection: false }
  if (input.pageId) return { sourceIds: [input.pageId], scope: 'page', byBlockSelection: false }
  return { sourceIds: [], scope: 'page', byBlockSelection: false }
}

/**
 * 面板宫格的作用范围分类（`09-桌面端UI规范` `R09-AIPANEL-3c`，用户 裁决「③+②」）：
 *
 * - **产出型**（总结 / 提取行动 / 反问我）产出新内容、天然跨块 ⇒ 保留**整篇**；
 * - **改写型**（润色 / 扩写 / 换角度）的输出是逐行改写 ⇒ 只作用于**一段**：整篇喂进去时模型在
 *   「复述清单」、结果也是一坨文本（13-AI评测材料（已归档）），一次一段才服务得好。
 *
 * `ask` 不在宫格里（自由提问有自己的范围行，`R09-AIPANEL-5b`），登记为 `page` 只作兜底。
 */
const AI_OP_SCOPE: Record<AiAction, 'page' | 'single'> = {
  summary: 'page', actions: 'page', askback: 'page',
  polish: 'single', expand: 'single', reframe: 'single',
  ask: 'page',
}

/** 这条指令的作用范围（`R09-AIPANEL-3c`）；宫格渲染方据此分组说明（「作用于本段」/「基于本篇」）。 */
export function aiOpScope(action: AiAction): 'page' | 'single' {
  return AI_OP_SCOPE[action]
}

/** `aiPanelGate` 的结果：能跑（带着已组装的来源声明）或不能跑（带着一句用户能执行的原因）。 */
export type AiPanelGate =
  | { kind: 'ready'; plan: AiRequestPlan }
  | { kind: 'blocked'; reason: string }

/**
 * 宫格一项此刻「能不能跑 / 为什么不能」（`R09-AIPANEL-3c`）：**按钮禁用与执行共用这一份判据**，
 * 规则改了只改这里。`ready` 时带着已经组装好的来源声明（`AiRequestPlan`），调用方直接进 `runAi`。
 *
 * 三种「不给跑」，每种都给一句用户能执行的原因（界面把它写在宫格下方，不许只藏在 tooltip 里）：
 * 改写型多块选中（一次只改一段）、改写型没有目标（没选中也没有光标块）、没有打开页面（产出型同此）。
 */
export function aiPanelGate(input: {
  action: AiAction
  /** 按块选中（把手多选）；> 1 块时改写型不给跑。 */
  selectedBlocks: string[]
  /** 光标所在块（调用方已过滤：在本页、非页面容器、未删除）。 */
  caretBlockId: string | null
  /** 当前打开的页面（产出型的整篇来源）。 */
  pageId: string | null
}): AiPanelGate {
  if (AI_OP_SCOPE[input.action] === 'page') {
    return input.pageId
      ? { kind: 'ready', plan: aiSourcePlan({ pageId: input.pageId }) }
      : { kind: 'blocked', reason: '先在编辑器里打开一页' }
  }
  if (input.selectedBlocks.length > 1) return { kind: 'blocked', reason: '一次只改一段（多块改写还没排期）' }
  if (input.selectedBlocks.length === 0 && input.caretBlockId === null) {
    return { kind: 'blocked', reason: '先选中要改的段（或把光标放进一段）' }
  }
  return {
    kind: 'ready',
    plan: aiSourcePlan({ selectedBlocks: input.selectedBlocks, caretBlockId: input.caretBlockId, pageId: input.pageId }),
  }
}

/**
 * AI 结果的落点（`09-桌面端交互规范` §6.11 `R09-AIB-6`）：**选中块 > 光标块 > 正文最后一块**，结果插在它的子树之后。
 *
 * 纯函数，只回答「哪一个块」；「光标块还在不在本页」由调用方用快照确认。
 * `selected` 非空表示这次是**按块选的**（块工具栏 / 多选），落点取最后选中的那一个；
 * 没有块选中时（整篇问答、只有文字选区）才用光标所在块。
 */
export function resolveAiAnchor(input: {
  /** 重新生成：原地更新那个 AI 块，不新建。 */
  targetBlockId?: string | null
  /** 本次请求显式选中的块（块工具栏 / 多选），**不含页面容器**。 */
  selected: string[]
  /** 光标所在块（可能是页面容器或不在本页，调用方负责过滤后传进来）。 */
  caretBlockId?: string | null
  /** 去重后的来源块，按文档顺序；作最后一档兜底。 */
  sources: string[]
}): string | null {
  if (input.targetBlockId) return input.targetBlockId
  if (input.selected.length > 0) return input.sources[input.sources.length - 1] ?? null
  if (input.caretBlockId) return input.caretBlockId
  return input.sources[input.sources.length - 1] ?? null
}

/**
 * T17 (spec §4.6): AI output is inserted as new Blocks after the target Block
 * (`R09-AIB-6`: 选中块 > 光标块 > 正文最后一块) subtree. The source blocks are never touched;
 * the new blocks carry `aiMeta` for provenance. Summary produces `text`, actions produce `todo`
 * Blocks with `checked=false` (AI never changes completion state).
 */
export function insertAiResults(
  blocks: BlockMap,
  input: AiInsertInput,
): { transaction: Omit<Transaction, 'inverse'>; blockIds: string[] } | null {
  const items = input.items.map((item) => item.trim()).filter((item) => item.length > 0)
  if (items.length === 0) return null
  const sources = dedupeSelection(blocks, input.sourceIds)
  if (sources.length === 0) return null

  const anchorId = (input.anchorId && blocks.get(input.anchorId) ? input.anchorId : null) ?? sources[sources.length - 1]
  const anchor = blocks.get(anchorId)!
  // 来源本身就是页面（对象块）时，结果必须落进页面内部；落到根级会变成一个新的"页面"。
  const parentId = anchor.parent ?? (anchor.isObject ? anchor.entityId : null)
  const baseIndex = parentId === anchorId
    ? anchor.children.length
    : parentId === null
      ? orderedRootIds(blocks).indexOf(anchorId) + 1
      : blocks.get(parentId)!.children.indexOf(anchorId) + 1
  const now = input.now ?? Date.now()
  const newId = input.newId ?? (() => crypto.randomUUID())

  const blockIds: string[] = []
  const operations: Operation[] = items.map((text, offset) => {
    const block = createTextBlock({ entityId: newId(), blockUid: newId(), text, parent: parentId, now })
    block.type = input.action === 'actions' ? 'todo' : 'text'
    block.aiMeta = {
      action: input.action,
      status: input.status,
      sourceBlockIds: [...sources],
      ...(input.sourceScope === undefined ? {} : { sourceScope: input.sourceScope }),
      ...(input.confidence === undefined ? {} : { confidence: input.confidence }),
      ...(input.request === undefined ? {} : { request: input.request }),
    }
    blockIds.push(block.entityId)
    return { type: 'insert', opId: newId(), block, parentId, index: baseIndex + offset }
  })

  // 占位块的移除与结果插入同属一次生成（docs/04 §5）：撤销一次就回到「生成前」，
  // 不需要用户为程序内部用的临时块额外按一次 ⌘Z。
  const removals = deleteBlocks(blocks, input.removeBlockIds ?? [], { now })

  return {
    transaction: { id: newId(), operations: [...operations, ...(removals?.transaction.operations ?? [])], timestamp: now, source: 'ai' },
    blockIds,
  }
}

/**
 * 存成新页时页名取什么（`R09-AIPANEL-6b`）：问句前 12 字 + 前缀，空白压平。
 *
 * 页名就是首行（`R04-NAME-7` 派生），所以这串字会同时成为页面的第一行——
 * 它是「这条回答从哪来」最省事的记录；问句为空时回落「自由问答」。
 */
export function aiAnswerPageName(question: string | undefined): string {
  const clean = (question ?? '').replace(/\s+/g, ' ').trim()
  return `问 AI：${clean.slice(0, 12) || '自由问答'}`
}

/**
 * 把 AI 结果存进**新建的页面**（页名 = `pageName`）——跨页提问的落点之一（`R09-AIPANEL-6b`）。
 *
 * **建页与结果插入在同一个事务里**：对用户来说「把这条回答存成一页」是一个动作，
 * 就该只占一步撤销（`R04-UNDO-1`；拆成两次事务的话 ⌘Z 只撤得掉结果、留下一张空页）。
 * 页名同时写进首行内容——名字是派生索引（`R04-NAME-7`，由 `applyTransaction` 统一重算），
 * 这里给出一致的初值，免得多一个「名字凭空出现」的中间态。
 */
export function insertAiResultsIntoNewPage(
  blocks: BlockMap,
  input: AiInsertInput & { pageName: string },
): { transaction: Omit<Transaction, 'inverse'>; blockIds: string[]; pageId: string } | null {
  const newId = input.newId ?? (() => crypto.randomUUID())
  const pageId = newId()
  const page = createTextBlock({
    entityId: pageId,
    blockUid: newId(),
    text: input.pageName,
    isObject: true,
    objectName: input.pageName,
    now: input.now,
  })
  // 结果落进页内：锚点就是这张页面块自己（`insertAiResults` 对对象锚点会把结果放进它内部）
  const withPage: BlockMap = new Map(blocks)
  withPage.set(pageId, page)
  const inner = insertAiResults(withPage, { ...input, anchorId: pageId })
  if (!inner) return null
  const pageOperation: Operation = { type: 'insert', opId: newId(), block: page, parentId: null, index: orderedRootIds(blocks).length }
  return {
    transaction: { ...inner.transaction, operations: [pageOperation, ...inner.transaction.operations] },
    blockIds: inner.blockIds,
    pageId,
  }
}
