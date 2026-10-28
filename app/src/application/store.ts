import { canPinPage, cloneBlockMap, compareBlockOrder, MAX_PINNED_PAGES, pinnedCount, type Block, type BlockMap, type BlockType, type ContentFragment, type PropertyValue, type RefKind } from '@moqi/editor'
import { applyTransaction, touchedBlockIds, type DeleteSnapshot, type Operation, type Transaction } from '@moqi/editor'
import { indentBlock, insertOutlineAfter, insertOutlineAsPage, moveBlock, moveBlocks, outdentBlock, owningPageId, subtreeMap } from '@moqi/editor'
import type { OutlineDraft } from '@moqi/editor'
import { copyBlocks, deleteBlocks } from '@moqi/editor'
import { insertAiResults, insertAiResultsIntoNewPage, type AiInsertInput } from '@moqi/editor'
import { convertBlockType } from '@moqi/editor'
import { embedViewOf, insertExternalLink, insertInlineRef, refLabel, searchEmbedTargets, searchRefTargets, setEmbedSource, type EmbedCandidate, type EmbedView, type RefCandidate, type RefTrigger } from '@moqi/editor'
import { collectBacklinks, type BacklinkEntry } from '@moqi/editor'
import { applyPropertyValue } from '@moqi/editor'

export class DomainStore {
  private blocks: BlockMap
  private undoStack: Transaction[] = []
  private redoStack: Transaction[] = []
  /**
   * 自上次 `takeTouched` 以来「内容变了」的块，含因 children 变化而变动的父块
   * （见 domain/operation.ts `touchedBlockIds`）。落盘方按这个集合补齐，就不会漏写父块。
   */
  private touchedIds = new Set<string>()
  /** V2b：已「从本机彻底删除」、等待落盘方删行的块 id（与 `touchedIds` 相反的一条路）。*/
  private purgedIds = new Set<string>()
  /** V2b：已应用、待写进 `oplog` 的事务（同步只读那份日志；见 `noteApplied`）。*/
  private committed: Transaction[] = []

  constructor(initialBlocks: Block[] = []) {
    this.blocks = new Map(initialBlocks.map((block) => [block.entityId, structuredClone(block)]))
  }

  snapshot(): BlockMap { return cloneBlockMap(this.blocks) }
  get(blockId: string): Block | undefined { const block = this.blocks.get(blockId); return block ? structuredClone(block) : undefined }
  /**
   * 只读遍历口（**不许写**）：`snapshot()` 会整表深拷贝，挂在启动路径（首屏装载）或每次编辑的
   * 量测路径（`editorBase` 的子树基线）上就把预算吃光——与 `embedView` / `resolveInlineRef`
   * 同一个取舍（性能批 ⓒ ②：全库深拷是启动与编辑两头最大的单项同步开销）。
   * 只给「只读、且需要留下的数据自己 `cloneBlock`」的纯读函数用；写它 = 绕过事务与领域校验。
   */
  read(): BlockMap { return this.blocks }

  /** 一页的子树**副本**（编辑器基线用）：只有这一页，不克隆整库。 */
  subtree(pageId: string): BlockMap { return subtreeMap(this.blocks, pageId) }

  canUndo(): boolean { return this.undoStack.length > 0 }
  canRedo(): boolean { return this.redoStack.length > 0 }

  /** 取走并清空「改动过的块」清单——落盘方每次写库前调用一次。 */
  takeTouched(): string[] {
    const ids = [...this.touchedIds]
    this.touchedIds.clear()
    return ids
  }

  private noteTouched(operations: Operation[]): void {
    for (const id of touchedBlockIds(operations)) this.touchedIds.add(id)
  }

  /**
   * V2b：所有会改块图的路径（apply / applyMirror / undo / redo）都从这里收口。
   * 除了记「哪些块要落盘」，还把事务**排队等待写进 `oplog`**——同步只读那份日志，
   * 漏记一条就是一次永远同步不出去的变化。
   */
  private noteApplied(transaction: Transaction): void {
    this.noteTouched(transaction.operations)
    if (transaction.operations.length > 0) this.committed.push(transaction)
  }

  /** V2b：取出并清空待写日志的事务（落盘方消费，与 `takeTouched` 同一节拍）。 */
  takeCommittedTransactions(): Transaction[] {
    const list = this.committed
    this.committed = []
    return list
  }

  /**
   * Applies one transaction. 领域校验失败时必须原子回滚：applyTransaction 会先改内存再校验，
   * 若只抛出而不还原，一次被拒绝的写入就会把块图留在不自洽的状态里，
   * 之后每一次 apply 都会被校验拦住（用户看到的是「软件还活着但什么都写不进去」）。
   *
   * **不需要在这里先备份整库**：`applyTransaction` 全程只动**工作副本**，`assertValidBlockGraph`
   * 通过之后才 `blocks.clear()` 回灌真图（operation.ts 的 applyTransaction）——被拒绝的写入
   * 根本碰不到 `this.blocks`（`undo` / `redo` 早就靠同一条不变式）。性能批 ⓒ ② 实测：每事务
   * 白拷 5000 块是编辑路径上最大的一笔。不变式由「被领域校验拒绝的写入必须原子回滚」守着。
   */
  apply(input: Omit<Transaction, 'inverse'>): void {
    const transaction = applyTransaction(this.blocks, { ...input, inverse: [] })
    this.noteApplied(transaction)
    this.undoStack.push(transaction)
    this.redoStack = []
  }

  /**
   * 镜像写入：把编辑器里的变化同步进领域，但**不占领域撤销栈**。
   *
   * 字符输入由 Lexical 的 HistoryPlugin 记录（docs/04 §5「两套历史不能互相重复记录同一变化」）；
   * 编辑器 → 领域的同步只是把这次输入镜像过来，本身不是一次可撤销的用户动作。
   * 若它也压栈，⌘Z 会先把「刚敲进去的字」当成一次领域撤销，用户真正想撤销的缩进 / 类型转换排在后面
   * （用户实测现象：输入文字 → 缩进 → 转类型 → ⌘Z，内容被撤掉了，缩进和转换还在）。
   *
   * 镜像写入虽然不记新记录，但会**把栈里已有的记录刷新到现状**（见 `refreshInsertedSnapshots`）：
   * 撤销栈里的「落块」记录存的是落块那一刻的快照，不跟着走的话，⇧⌘Z 重做会把旧快照写回来
   * ——AI 块重做丢正文（正文正是流式镜像写回的），回车新建的块重做丢刚敲的字。
   */
  applyMirror(input: Omit<Transaction, 'inverse'>): void {
    // 同 `apply`：真图由 `applyTransaction` 在校验后才回灌，这里不必先备份整库。
    const transaction = applyTransaction(this.blocks, { ...input, inverse: [] })
    this.noteApplied(transaction)
    const touched = new Set<string>()
    for (const operation of input.operations) {
      if (operation.type === 'update') touched.add(operation.blockId)
      if (operation.type === 'insert') touched.add(operation.block.entityId)
    }
    if (touched.size > 0) this.refreshInsertedSnapshots(touched)
  }

  /** 让撤销栈里指向这些块的「落块」记录跟上块现状（供镜像写入收尾时调用）。 */
  private refreshInsertedSnapshots(touched: Set<string>): void {
    for (const transaction of this.undoStack) {
      for (const operation of transaction.operations) {
        if (operation.type !== 'insert' || !touched.has(operation.block.entityId)) continue
        const current = this.blocks.get(operation.block.entityId)
        if (current) operation.block = structuredClone(current)
      }
    }
  }

  /** Builds and applies a Tab indent; returns false for contract no-ops. */
  indent(blockId: string): boolean {
    const transaction = indentBlock(this.blocks, blockId)
    if (!transaction) return false
    this.apply(transaction)
    return true
  }

  /** Builds and applies a Shift+Tab outdent; returns false for contract no-ops. */
  outdent(blockId: string): boolean {
    const transaction = outdentBlock(this.blocks, blockId)
    if (!transaction) return false
    this.apply(transaction)
    return true
  }

  /** Builds and applies a drag move; returns false for invalid or no-op drops. */
  move(blockId: string, newParentId: string | null, newIndex: number): boolean {
    const transaction = moveBlock(this.blocks, blockId, newParentId, newIndex)
    if (!transaction) return false
    this.apply(transaction)
    return true
  }

  /**
   * γ2（2026-10-12）：**块组拖拽**——一个 transaction 移动整组（保持相对顺序、**一步撤销**）。
   * 与 `copy` / `deleteSelection` 同一写法（数组入参 → 一个 transaction）；返回 false = 定义好的 no-op
   * （任一成员落点非法 ⇒ 整组都不动，界面的「回弹」）。
   */
  moveBlocks(blockIds: string[], newParentId: string | null, newIndex: number): boolean {
    const transaction = moveBlocks(this.blocks, blockIds, newParentId, newIndex)
    if (!transaction) return false
    this.apply(transaction)
    return true
  }

  /**
   * Applies a `/` menu type conversion; returns affected Block ids, or null for a contract no-op.
   *
   * `mirror: true` 用于**不是用户动作**的内容写回（目前只有 AI 流式生成按 90ms 节拍写回正文，
   * 见 docs/04 §5）：走 `applyMirror` 只把编辑器镜像进领域，不占撤销栈——否则一次生成会在
   * 撤销栈里留下几十条「第 N 个流片段」，⌘Z 要按几十次才退得掉（实测 60 个节拍 = 61 条记录）。
   */
  convertType(blockId: string, nextType: BlockType, nextContent?: ContentFragment[], options: { mirror?: boolean; checked?: boolean } = {}): string[] | null {
    const transaction = convertBlockType(this.blocks, blockId, nextType, nextContent, Date.now(), options.checked)
    if (!transaction) return null
    if (options.mirror) this.applyMirror(transaction)
    else this.apply(transaction)
    const affected: string[] = []
    for (const operation of transaction.operations) {
      if (operation.type === 'update') affected.push(operation.blockId)
      if (operation.type === 'insert') {
        affected.push(operation.block.entityId)
        if (operation.parentId) affected.push(operation.parentId)
      }
    }
    return affected
  }

  /** Object/Block search source for the T13 `[[`/`((` menus. */
  findRefTargets(kind: RefKind, query: string, fromId: string): RefCandidate[] {
    return searchRefTargets(this.blocks, kind, query, fromId)
  }

  /**
   * 嵌入块的来源（13-媒体设计（已归档） §8）：设置 / 更换 / 清除，一次事务一个撤销步。
   * 返回 false = 契约 no-op（已删 / 不是嵌入块 / 自引用或祖先 / 目标没变），调用方不改界面。
   */
  setEmbedSource(blockId: string, targetId: string | null): boolean {
    const transaction = setEmbedSource(this.blocks, blockId, targetId)
    if (!transaction) return false
    this.apply(transaction)
    return true
  }

  /**
   * 嵌入卡的显示数据（`R09-BLOCK-24`）。装饰层每次重扫都问它，所以**直接读内部块图**——
   * `snapshot()` 会整表深拷贝，挂在每帧的量测路径上会把「输入到上屏 ≤ 50ms」的预算吃光。
   */
  embedView(blockId: string): EmbedView | null {
    return embedViewOf(this.blocks, blockId)
  }

  /**
   * 粘贴/导入时**按名字**解析引用（ / ——与 refToken 写出的形态同一张表）：
   * 页名找同名页；块名找标签相同的块（**同页优先**，找不到再看全库；同名取稳定的第一个）。
   * 直接读内部块图（粘贴是低频动作，但仍不整表克隆）。
   */
  resolveInlineRef(kind: 'object' | 'block', label: string, fromId: string): string | null {
    const wanted = label.trim()
    if (wanted.length === 0) return null
    const ownPage = owningPageId(this.blocks, fromId)
    let fallback: string | null = null
    for (const block of this.blocks.values()) {
      if (block.deleted || block.entityId === fromId) continue
      if (kind === 'object') {
        if (!block.isObject || (block.objectName ?? '') !== wanted) continue
        return block.entityId
      }
      if (block.isObject || refLabel(block) !== wanted) continue
      if (ownPage !== null && owningPageId(this.blocks, block.entityId) === ownPage) return block.entityId
      if (fallback === null) fallback = block.entityId
    }
    return kind === 'block' ? fallback : null
  }

  /** 「选择来源页面 / 块」的候选（页面在前、块在后，含本页）。 */
  embedSourceTargets(query: string, fromId: string): EmbedCandidate[] {
    return searchEmbedTargets(this.blocks, query, fromId)
  }

  /**
   * Applies a `[[`/`((` acceptance: one transaction updates the content and
   * writes the ref + backRef together. Returns affected ids, or null for a
   * contract no-op (missing/deleted target, self reference, malformed trigger).
   */
  /** `R09-ELINK-1/2`：一次事务写一个 `link` 片段；对话框 / ⌘L / 格式栏 / 粘贴纯 URL 共用这条入口。 */
  insertExternalLink(blockId: string, input: { text: string; url: string; offset: number; length: number }): boolean {
    const transaction = insertExternalLink(this.blocks, blockId, input)
    if (!transaction) return false
    this.apply(transaction)
    return true
  }

  insertRef(fromId: string, kind: RefKind, targetId: string, input: { trigger: RefTrigger; query: string; displayText: string; offset?: number }): string[] | null {
    const transaction = insertInlineRef(this.blocks, fromId, kind, targetId, input)
    if (!transaction) return null
    this.apply(transaction)
    const affected: string[] = []
    for (const operation of transaction.operations) {
      if (operation.type === 'update') affected.push(operation.blockId)
      if (operation.type === 'object-ref' || operation.type === 'block-ref') affected.push(operation.fromId, operation.targetId)
    }
    return affected
  }

  /** Reverse-link sources for the T14 panel; hidden deleted sources stay opt-in. */
  backlinks(targetId: string, includeDeleted = false): BacklinkEntry[] {
    return collectBacklinks(this.blocks, targetId, { includeDeleted })
  }

  /** T15: sets or clears one typed property. `null` clears; returns false for no-ops. */
  setProperty(blockId: string, defId: string, value: PropertyValue | null): boolean {
    const block = this.blocks.get(blockId)
    if (!block || block.deleted) return false
    const next = applyPropertyValue(block.properties, value, defId)
    if (!next) return false
    this.apply({ id: crypto.randomUUID(), operations: [{ type: 'update', opId: crypto.randomUUID(), blockId, changes: { properties: next }, previous: { properties: block.properties } }], timestamp: Date.now(), source: 'user' })
    return true
  }

  /** T15: adds a `TagDef.id` to a Block without duplicating it. */
  addTag(blockId: string, tagId: string): boolean {
    const block = this.blocks.get(blockId)
    if (!block || block.deleted || block.tags.includes(tagId)) return false
    this.apply({ id: crypto.randomUUID(), operations: [{ type: 'update', opId: crypto.randomUUID(), blockId, changes: { tags: [...block.tags, tagId] }, previous: { tags: block.tags } }], timestamp: Date.now(), source: 'user' })
    return true
  }

  removeTag(blockId: string, tagId: string): boolean {
    const block = this.blocks.get(blockId)
    if (!block || block.deleted || !block.tags.includes(tagId)) return false
    this.apply({ id: crypto.randomUUID(), operations: [{ type: 'update', opId: crypto.randomUUID(), blockId, changes: { tags: block.tags.filter((id) => id !== tagId) }, previous: { tags: block.tags } }], timestamp: Date.now(), source: 'user' })
    return true
  }

  /**
   * V2b: pins or unpins a page. **This is the real gate for the 5-page cap** — the menu
   * greying out is only the first line of defence. A rejected call returns `false` and
   * writes nothing: no transaction, so nothing reaches the undo stack or the oplog.
   */
  setPinned(blockId: string, pinned: boolean): boolean {
    const block = this.blocks.get(blockId)
    if (!block || block.deleted || !block.isObject || block.pinned === pinned) return false
    if (pinned && pinnedCount(this.blocks, blockId) >= MAX_PINNED_PAGES) return false
    this.apply({ id: crypto.randomUUID(), operations: [{ type: 'update', opId: crypto.randomUUID(), blockId, changes: { pinned }, previous: { pinned: block.pinned } }], timestamp: Date.now(), source: 'user' })
    return true
  }

  /** V2b: whether the page's ⋯ menu should leave 「置顶」 enabled (drives the disabled state). */
  canPin(blockId: string): boolean {
    return canPinPage(this.blocks, blockId)
  }

  /** V2b: stars or unstars a page. A mark only — it never affects ordering (that is `setPinned`). */
  setStarred(blockId: string, starred: boolean): boolean {
    const block = this.blocks.get(blockId)
    if (!block || block.deleted || !block.isObject || block.starred === starred) return false
    this.apply({ id: crypto.randomUUID(), operations: [{ type: 'update', opId: crypto.randomUUID(), blockId, changes: { starred }, previous: { starred: block.starred } }], timestamp: Date.now(), source: 'user' })
    return true
  }

  /** T15: recycle-bin entries, newest deletion first. */
  deletedRoots(): Block[] {
    return [...this.blocks.values()]
      .filter((block) => block.deleted && (block.parent === null || this.blocks.get(block.parent)?.deleted === false))
      .sort((left, right) => (right.deletedAt ?? 0) - (left.deletedAt ?? 0) || compareBlockOrder(left, right))
      .map((block) => structuredClone(block))
  }

  /** T15: restores a deleted root and its whole subtree via the existing restore operation. */
  restore(blockId: string): boolean {
    const root = this.blocks.get(blockId)
    if (!root || !root.deleted) return false
    const snapshots: DeleteSnapshot[] = []
    const stack = [blockId]
    while (stack.length > 0) {
      const id = stack.pop()!
      const block = this.blocks.get(id)
      if (!block) continue
      snapshots.push({ blockId: id, prevParent: block.prevParent, prevIndex: block.prevIndex ?? 0 })
      for (const childId of block.children) {
        if (this.blocks.get(childId)?.deleted) stack.push(childId)
      }
    }
    this.apply({ id: crypto.randomUUID(), operations: [{ type: 'restore', opId: crypto.randomUUID(), blockId, snapshots }], timestamp: Date.now(), source: 'user' })
    return true
  }

  /**
   * T16: copies the parent-deduplicated selection as one transaction and
   * returns the new copy-root ids. Returns null when nothing is copyable.
   */
  copy(blockIds: string[]): string[] | null {
    const result = copyBlocks(this.blocks, blockIds)
    if (!result) return null
    this.apply(result.transaction)
    return result.rootIds
  }

  /**
   * T16: deletes the parent-deduplicated selection as one transaction and
   * returns the deleted root ids, so callers can show an undo affordance.
   */
  deleteSelection(blockIds: string[]): string[] | null {
    const result = deleteBlocks(this.blocks, blockIds)
    if (!result) return null
    this.apply(result.transaction)
    return result.rootIds
  }

  /**
   * V2b：「从本机彻底删除」。**不是一次变更**——不产生 transaction，因此不进 oplog、
   * 不压撤销栈、不可撤销（`docs/03` §14.5 层 2：本机行为，不参与同步）。
   *
   * 传入的必须是**整棵子树**（回收站给的就是整棵）：只摘掉一部分会留下指向不存在父块的
   * 子块，那是结构性错误，会当场把整库变成只读。安全网在这里做第二道——摘除后把仍活着的
   * 父块 `children` 里的死引用清掉，并把它标成待落盘。
   *
   * @returns 实际摘掉的块数。
   */
  purge(entityIds: Iterable<string>): number {
    const ids = [...entityIds].filter((id) => this.blocks.has(id))
    if (ids.length === 0) return 0
    const remove = new Set(ids)
    for (const id of ids) {
      const block = this.blocks.get(id)!
      const parentId = block.parent
      if (parentId !== null && !remove.has(parentId)) {
        const parent = this.blocks.get(parentId)
        if (parent) {
          parent.children = parent.children.filter((childId) => !remove.has(childId))
          this.touchedIds.add(parentId)
        }
      }
      this.blocks.delete(id)
      this.touchedIds.delete(id)
      // 块没了，涉及它的历史步骤再撤销/重做会 `mustGet` 抛错——按「这次事务碰过哪些块」摘掉。
      // 用领域既有的 `touchedBlockIds` 遍历（正反两个方向都看），不另写一套判定。
      const touches = (transaction: Transaction): boolean =>
        touchedBlockIds(transaction.operations).includes(id) || touchedBlockIds(transaction.inverse).includes(id)
      this.undoStack = this.undoStack.filter((transaction) => !touches(transaction))
      this.redoStack = this.redoStack.filter((transaction) => !touches(transaction))
    }
    for (const id of ids) this.purgedIds.add(id)
    return ids.length
  }

  /** V2b: 待物理删除的块 id（落盘方消费；与 `takeTouched` 同一条路，但语义是「删」不是「存」）。*/
  takePurged(): string[] {
    const ids = [...this.purgedIds]
    this.purgedIds.clear()
    return ids
  }

  /**
   * `R09-MD-3` **粘贴即转换**：把解析好的草稿树整棵插到锚点之后——**一个事务**，
   * 所以 ⌘Z 一次就整批退掉（`R09-MD-4.4`）。返回新块 id（文档序）。
   */
  insertOutline(afterId: string, drafts: OutlineDraft[]): string[] | null {
    const result = insertOutlineAfter(this.blocks, afterId, drafts)
    if (!result) return null
    this.apply(result.transaction)
    return result.blockIds
  }

  /**
   * T17: inserts AI result Blocks after the last source subtree as one
   * `source:'ai'` transaction; returns the new Block ids.
   */
  insertAiResults(input: AiInsertInput): string[] | null {
    const result = insertAiResults(this.blocks, input)
    if (!result) return null
    this.apply(result.transaction)
    return result.blockIds
  }

  /**
   * `R09-AIPANEL-6b`：把结果存进**新建的页面**（页名 = `pageName`）——建页与插入同一个事务，
   * 一步撤销就能把整页收回去。返回新页 id 与结果块 id（调用方据此打开那一页）。
   */
  /**
   * 导入一份文档：正文草稿树 + 页名 → **一个新页面**（13-导出与媒体设计（已归档） §「导入」）。
   * 页面与正文在**同一个事务**里（一次撤销退回整篇）；标签 id / 属性值由调用方解析好再传进来。
   * `created` / `modified` 是导出物的时间戳**回读**（只覆盖这两个字段，不参与排序，见 `insertOutlineAsPage`）。
   */
  insertDocumentAsPage(drafts: OutlineDraft[], pageName: string, extras: { tags?: string[]; properties?: Block['properties']; created?: number; modified?: number } = {}): { blockIds: string[]; pageId: string } | null {
    const built = insertOutlineAsPage(this.blocks, drafts, pageName, extras)
    if (!built) return null
    this.apply(built.transaction)
    return { blockIds: built.blockIds, pageId: built.pageId }
  }

  insertAiResultsIntoNewPage(input: AiInsertInput & { pageName: string }): { blockIds: string[]; pageId: string } | null {
    const result = insertAiResultsIntoNewPage(this.blocks, input)
    if (!result) return null
    this.apply(result.transaction)
    return { blockIds: result.blockIds, pageId: result.pageId }
  }

  undo(): void {
    const transaction = this.undoStack.pop()
    if (!transaction) return
    const inverse = applyTransaction(this.blocks, { ...transaction, id: `${transaction.id}:undo`, operations: transaction.inverse, inverse: [] })
    this.noteApplied(inverse)
    this.redoStack.push({ ...transaction, inverse: inverse.inverse })
  }

  redo(): void {
    const transaction = this.redoStack.pop()
    if (!transaction) return
    const replay = applyTransaction(this.blocks, { ...transaction, id: `${transaction.id}:redo`, operations: transaction.operations, inverse: [] })
    this.noteApplied(replay)
    this.undoStack.push(replay)
  }
}

export type { Operation, Transaction }
