import { useMemo } from 'react'

import { orderedRootIds, textContent, type AiAction, type BlockMap, type MetadataRegistry } from '@moqi/editor'
import { activePageSubtreeIds, owningPageId } from '@moqi/editor'
import { backlinkSourceCounts, summarizeBlock } from '@moqi/editor'
import { propertyUsages, tagUsages } from '@moqi/editor'
import { aiPanelGate, type AiPanelGate } from '@moqi/editor'
import type { DomainStore } from '../application/store'
import { AI_UI_OPS } from './aiMenu'
import { applyLibraryFilter, type LibraryFilter } from './libraryFilter'
import { buildPropertyRows, pathOf } from './shellSupport'
import { formatDate, formatDayMonth, formatDeletedAgo, formatRelative, remainingDays } from './format'
import type { BacklinkCard } from './Backlinks'
import type { RefCard } from './Panels'
import type { LibraryCard, NavEntry, TrashEntry } from './types'
import type { UiPrefs } from './uiPrefs'

/**
 * 派生数据（外壳拆分第七刀，）：把「从 snapshot / registry / 选中态算出来的只读视图」
 * 整批收在一处——外壳只把输入接进来、把结果摆出去。每个 memo 的依赖数组与原实现逐条一致，
 * 重算时机不变；这里不持有可变状态、也不认识界面。**页面列 / 卡片 / 反链这些大件都从这走。**
 */
export type DerivedDataInputs = {
  store: DomainStore
  /** 保存队列的落地计数：store 内部原地更新，靠它触发重算。 */
  revision: number
  snapshot: BlockMap
  registry: MetadataRegistry
  prefs: UiPrefs
  libraryFilter: LibraryFilter
  selectedIds: string[]
  activeBlockId: string | null
  activePageId: string | null
  findQuery: string
  includeDeleted: boolean
}

export function useDerivedData(inputs: DerivedDataInputs) {
  const { store, revision, snapshot, registry, libraryFilter, selectedIds, activeBlockId, activePageId, findQuery, includeDeleted } = inputs

  const trashEntries = useMemo<TrashEntry[]>(() => store.deletedRoots().map((block) => ({
    id: block.entityId,
    name: block.isObject ? (block.objectName ?? '未命名页面') : summarizeBlock(block),
    deletedLabel: formatDeletedAgo(block.deletedAt ?? block.modified),
    remainingDays: remainingDays(block.deletedAt ?? block.modified),
    childCount: block.children.length,
    backlinkCount: store.backlinks(block.entityId, true).length,
    // revision 不被回调体读取，但它是可变 store 的失效键：缺了它这份 memo 永不重算（陈旧 UI）——刻意保留。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  })), [store, revision])

  const libraryCards = useMemo<LibraryCard[]>(() => {
    // 反链数走全库一次扫描的索引（`backlinkSourceCounts`）：逐卡调 `store.backlinks`
    // 是「页数 × 全库」的扫描（性能批 ⓒ ② 实测占每次变动的可观一块）。
    const backlinkCounts = backlinkSourceCounts(snapshot)
    const cards: LibraryCard[] = []
    for (const pageId of orderedRootIds(snapshot)) {
      const page = snapshot.get(pageId)
      if (!page?.isObject) continue
      const paragraphs: string[] = []
      // 页面根块（isObject）的正文**就是页面名**，卡片标题已经显示一次了——摘要从子块开始，
   // 否则卡片里「页面名」出现两遍（ 视觉批 ⓓ：截图实锤的重复行）。
      for (const childId of page.children) {
        const child = snapshot.get(childId)
        if (!child || child.deleted) continue
        const text = textContent(child).replace(/\s+/g, ' ').trim()
        if (text) paragraphs.push(text)
        if (paragraphs.length >= 8) break
      }
      cards.push({
        id: pageId,
        name: page.objectName ?? '未命名页面',
        paragraphs,
        createdLabel: formatDayMonth(page.created),
        updatedLabel: formatRelative(page.modified),
        backlinkCount: backlinkCounts.get(pageId) ?? 0,
        pinned: page.pinned,
        starred: page.starred,
        // V2c 筛选面板要的结构化字段（`09-桌面端UI规范` §4.2）：标签 id 与单选属性的选中项——
        // 展示文案与筛选字段分开，筛选不能去解析文案。
        created: page.created,
        modified: page.modified,
        tagIds: [...page.tags],
        properties: page.properties.map((item) => ({ ...item })),
      })
    }
    return cards
    // store 同上：稳定可变对象，与 snapshot 同列是失效语义的一部分——刻意保留
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, store])

  /**
   * V2c：筛选后的卡片（`09-桌面端UI规范` §4.2）。**命中判据在 `ui/libraryFilter.ts`**（纯函数，有单测）——
   * 这里只把条件喂给它。侧栏标签点击与筛选面板改的是同一份条件（`R09-FILT-7`）。
   */
  // Date.now() 是刻意的采样：判「最近」的截止时间随输入变化时刷新，不追求逐帧准确（真使其响应时间流动要另立触发点）。
  // eslint-disable-next-line react-hooks/purity
  const visibleCards = useMemo(() => applyLibraryFilter(libraryCards, libraryFilter, Date.now(), registry.properties), [libraryCards, libraryFilter, registry])

  /**
   * 编辑器空态用的「最近编辑」（docs/09 §八）：没有页面被打开时右栏不能是空白，
   * 但也不能写假内容——这里列的是真实页面与更新时间，点一条就打开它。
   */
  const recentPages = useMemo(() => {
    const pages = [...snapshot.values()].filter((block) => block.isObject && !block.deleted)
    pages.sort((left, right) => right.modified - left.modified)
    return pages.slice(0, 5).map((page) => ({ id: page.entityId, name: page.objectName ?? '未命名页面', label: formatRelative(page.modified) }))
  }, [snapshot])

  const activePage = activePageId ? snapshot.get(activePageId) : undefined
  const activeBlock = activeBlockId ? snapshot.get(activeBlockId) : undefined

  /**
   * 面板改写型指令（`R09-AIPANEL-3c`）此刻的作用目标：**单块选中 > 光标块**，**多块选中 = 没有目标**
   * （一次只改一段）；页面容器 / 已删除 / 跨页都不算。渲染期给按钮禁用态用；点击那一刻由
   * `aiPanelGate` 用实时光标再算一次（两处同源：都走「本页、非容器、未删除」这一套过滤）。
   */
  const singleTargetBlockId = useMemo(() => {
    if (!activePageId) return null
    const candidate = selectedIds.length === 1 ? selectedIds[0] : selectedIds.length === 0 ? activeBlockId : null
    const block = candidate ? snapshot.get(candidate) : undefined
    if (!block || block.isObject || block.deleted) return null
    return owningPageId(snapshot, block.entityId) === activePageId ? block.entityId : null
  }, [selectedIds, activeBlockId, activePageId, snapshot])

  /** 宫格六项此刻的「能不能跑 / 为什么不能」（`R09-AIPANEL-3c`）——按钮禁用与执行共用同一个纯函数。 */
  const aiGridGates = useMemo(() => {
    const gates: Partial<Record<AiAction, AiPanelGate>> = {}
    for (const item of AI_UI_OPS) {
      if (!item.action) continue
      gates[item.action] = aiPanelGate({ action: item.action, selectedBlocks: selectedIds, caretBlockId: singleTargetBlockId, pageId: activePageId })
    }
    return gates
  }, [selectedIds, singleTargetBlockId, activePageId])

  const outlineEntries = useMemo<NavEntry[]>(() => {
    if (!activePage) return []
    const entries: NavEntry[] = []
    const visit = (id: string, depth: number) => {
      const block = snapshot.get(id)
      if (!block || block.deleted) return
      if (block.type.startsWith('heading')) {
        const level = block.type === 'heading1' ? 0 : block.type === 'heading2' ? 1 : 2
        entries.push({ id, label: summarizeBlock(block), depth: level, kind: 'block' })
      }
      for (const childId of block.children) {
        const child = snapshot.get(childId)
        if (child && !child.deleted) visit(childId, Math.min(2, depth + 1))
      }
    }
    visit(activePage.entityId, -1)
    return entries
  }, [activePage, snapshot])

  const findHits = useMemo(() => {
    const needle = findQuery.trim().toLowerCase()
    if (!activePage || needle.length === 0) return []
    const hits: { blockId: string; label: string; preview: string }[] = []
    for (const id of activePageSubtreeIds(snapshot, activePage.entityId)) {
      const block = snapshot.get(id)
      if (!block) continue
      const text = textContent(block).trim()
      if (!text || !text.toLowerCase().includes(needle)) continue
      const at = text.toLowerCase().indexOf(needle)
      const from = Math.max(0, at - 18)
      hits.push({ blockId: id, label: block.type, preview: `${from > 0 ? '…' : ''}${text.slice(from, from + 80)}` })
    }
    return hits
  }, [activePage, findQuery, snapshot])

  const propertyRows = useMemo(() => {
    if (!activePage) return []
    return buildPropertyRows(activePage, registry)
  }, [activePage, registry])

  /** 标签用量读数（`属性区重规划（已归档）` §5-12）：全量标签 ＋「用在 N 页」——取用选择器的数据源。 */
  const tagUsage = useMemo(() => tagUsages(snapshot.values(), registry.tags), [snapshot, registry])

  /** 属性库用量读数（§3.6「用在 N 页」/ §3.2 删除影响清单）：每个定义 `{ pages, values }`。 */
  const propertyUsage = useMemo(() => propertyUsages(snapshot.values(), registry.properties), [snapshot, registry])

  const backlinkCards = useMemo<BacklinkCard[]>(() => {
    if (!activePage) return []
    const seen = new Set<string>()
    const cards: BacklinkCard[] = []
    for (const id of activePageSubtreeIds(snapshot, activePage.entityId)) {
      for (const entry of store.backlinks(id, includeDeleted)) {
        if (seen.has(entry.sourceId)) continue
        seen.add(entry.sourceId)
        const source = snapshot.get(entry.sourceId)
        if (!source) continue
        cards.push({
          sourceId: entry.sourceId,
          path: pathOf(snapshot, source),
          preview: summarizeBlock(source),
          kind: entry.kind,
        })
      }
    }
    return cards
  }, [activePage, includeDeleted, snapshot, store])

  const outgoingCards = useMemo<RefCard[]>(() => {
    if (!activePage) return []
    const cards: RefCard[] = []
    const seen = new Set<string>()
    for (const id of activePageSubtreeIds(snapshot, activePage.entityId)) {
      const block = snapshot.get(id)
      if (!block) continue
      for (const targetId of block.objectRefs) {
        if (seen.has(targetId)) continue
        seen.add(targetId)
        const target = snapshot.get(targetId)
        if (!target) continue
        cards.push({
          id: targetId,
          title: target.objectName ?? summarizeBlock(target),
          meta: `页面 · ${formatRelative(target.modified)}`,
          preview: summarizeBlock(target),
          isBlock: false,
        })
      }
      for (const ref of block.blockRefs) {
        if (seen.has(ref.targetBlockId)) continue
        seen.add(ref.targetBlockId)
        const target = snapshot.get(ref.targetBlockId)
        if (!target) continue
        cards.push({
          id: ref.targetBlockId,
          title: pathOf(snapshot, target),
          meta: `块 · ${formatRelative(target.modified)}`,
          preview: summarizeBlock(target),
          isBlock: true,
        })
      }
    }
    return cards
  }, [activePage, snapshot])

  const pageStats = useMemo(() => {
    if (!activePage) return { blocks: 0, backlinks: 0, words: 0, createdLabel: '-' }
    const ids = activePageSubtreeIds(snapshot, activePage.entityId)
    let words = 0
    for (const id of ids) words += textContent(snapshot.get(id)!).replace(/\s+/g, '').length
    return {
      blocks: ids.length,
      backlinks: store.backlinks(activePage.entityId, false).length,
      words,
      createdLabel: formatDate(activePage.created),
    }
  }, [activePage, snapshot, store])

  return {
    trashEntries, libraryCards, visibleCards, recentPages,
    activePage, activeBlock, singleTargetBlockId, aiGridGates,
    outlineEntries, findHits, propertyRows, tagUsage, propertyUsage, backlinkCards, outgoingCards, pageStats,
  }
}
