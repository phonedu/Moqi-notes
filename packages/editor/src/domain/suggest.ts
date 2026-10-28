/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { orderedRootIds, textContent, type Block, type BlockMap } from './block'
import { owningPageId } from './treeOps'
import { parseRefQuery } from './refOps'

/**
 * 双链建议 · **规则版**（`docs/09` §6.2 `R09-BEDIT-5b`、`11` 的 `SUGGEST-RULE-1`）。
 *
 * 它是 `[[` / `((` 候选菜单**底部**那个「建议」组的数据源：规则版先上（反链补全 / 同标签 /
 * 标题相似 / 同源子树），**每条只给一个主要理由，不给分数**（用户 口径：
 * 「候选给一个主要理由、不给分数」——分数是黑箱，理由是能核对的东西）。
 *
 * 三条硬约束（都是可验收的行为，不是实现细节）：
 * ① **自引用与已删除目标一律过滤**（`SUGGEST-FILTER-1`）：建议自己、或建议一个进了回收站的页面，
 *    都是让用户点了才发现不对——那是把过滤的活推给人。
 * ② **接受才写 ref**（`SUGGEST-ACCEPT-1`）：这个模块只产候选，不写任何 operation；
 *    插入由既有的 `insertReference` 通路完成，拒绝 / 关闭天然不产生 operation。
 * ③ **规则之间不重复出人**：一个页面只出现一次，理由取**优先级最高的那一条**（反链 > 同标签 >
 *    标题 > 同源），免得同一页面在建议组里出现两遍、各带一个理由。
 *
 * 「同源子树」的口径（规范只给了名字，这里说清是什么）：**与当前页引用了同一个页面**的页面——
 * 比如两篇笔记都引用了《产品路线》，它们八成属于同一片知识（这是本产品里「同源」唯一有数据的含义；
 * 页面是根级对象，没有共同的祖先树可依）。
 */
export type SuggestReason = 'backlink' | 'tag' | 'title' | 'shared-ref'

export type Suggestion = {
  /** 候选页面的 id（`[[` 插入的是对象引用，所以只会建议页面）。 */
  pageId: string
  name: string
  reason: SuggestReason
  /** 给用户看的**一句话理由**（唯一理由，不是评分明细）。 */
  reasonText: string
}

/** 检查与排序共用的规则顺序：用户打了字就把「标题命中」放最前（那是他明确的意图）。 */
const BASE_ORDER: SuggestReason[] = ['backlink', 'tag', 'title', 'shared-ref']

/** 一页引用的**页面**集合（对象引用 + 指向页面块的块引用）。 */
function referencedPages(blocks: BlockMap, pageId: string): Set<string> {
  const found = new Set<string>()
  const visit = (id: string) => {
    const block = blocks.get(id)
    if (!block || block.deleted) return
    for (const ref of block.blockRefs) {
      const target = blocks.get(ref.targetBlockId)
      if (target?.isObject) found.add(target.entityId)
    }
    for (const ref of block.objectRefs) found.add(ref)
    for (const childId of block.children) visit(childId)
  }
  visit(pageId)
  return found
}

/** 引用过 `pageId` 的页面集合（`collectBacklinks` 的同一套语义：块引用或对象引用都算）。 */
function pagesReferencing(blocks: BlockMap, pageId: string): Set<string> {
  const found = new Set<string>()
  for (const source of blocks.values()) {
    if (source.deleted || source.entityId === pageId) continue
    const points = source.blockRefs.some((ref) => ref.targetBlockId === pageId) || source.objectRefs.includes(pageId)
    if (!points) continue
    const owner = owningPageId(blocks, source.entityId)
    if (owner && owner !== pageId) found.add(owner)
  }
  return found
}

/** 页面标题：对象名（= 首行派生索引）。 */
function pageName(block: Block): string {
  return (block.objectName ?? textContent(block)).trim() || '未命名页面'
}

/**
 * 产建议。`query` 是触发词后面已经打进正文的那段文字（可能为空——空查询时标题相似不参与，
 * 反链 / 同标签 / 同源仍然成立）。
 */
export function suggestReferences(input: {
  blocks: BlockMap
  /** 从哪个块发起的（光标所在块）：用它反查当前页。 */
  fromId: string
  query: string
  limit?: number
}): Suggestion[] {
  const { blocks, fromId } = input
  // 同一条别名规则（`R09-ALIAS-1`）：`|` 之前才是筛选关键词。
  const query = parseRefQuery(input.query).needle
  const limit = input.limit ?? 5
  const currentPageId = owningPageId(blocks, fromId)
  const current = currentPageId ? blocks.get(currentPageId) : undefined
  if (!currentPageId || !current) return []

  const RULE_ORDER: SuggestReason[] = query.length > 0 ? ['title', 'backlink', 'tag', 'shared-ref'] : BASE_ORDER.filter((reason) => reason !== 'title')
  const byBacklink = pagesReferencing(blocks, currentPageId)
  const currentTags = new Set(current.tags)
  const myRefs = referencedPages(blocks, currentPageId)

  const best = new Map<string, Suggestion>()
  const consider = (page: Block, reason: SuggestReason, reasonText: string) => {
    const pageId = page.entityId
    if (pageId === currentPageId) return                       // 自引用：过滤（SUGGEST-FILTER-1）
    if (page.deleted) return                                   // 已删除目标：过滤
    if (!page.isObject) return                                 // 只建议页面（[[ 插的是对象引用）
    const existing = best.get(pageId)
    if (existing) return   // 每个页面只出一条：理由取最先命中的那条规则（外层按 RULE_ORDER 找）
    best.set(pageId, { pageId, name: pageName(page), reason, reasonText })
  }

  for (const pageId of orderedRootIds(blocks)) {
    const page = blocks.get(pageId)
    if (!page?.isObject || page.deleted) continue
    if (pageId === currentPageId) continue
    // 规则按**用户意图强度**排：打的字命中标题 > 它引用过本篇 > 同标签 > 同源引用。
    // （打了「读书」而目标既同标签又标题命中时，理由该说「标题含读书」，不是「同标签」。）
    const matched = RULE_ORDER.find((reason) => {
      if (reason === 'title') return query.length > 0 && pageName(page).includes(query)
      if (reason === 'backlink') return byBacklink.has(pageId)
      if (reason === 'tag') return page.tags.some((tagId) => currentTags.has(tagId))
      const refs = referencedPages(blocks, pageId)
      return [...myRefs].some((target) => refs.has(target))
    })
    if (!matched) continue
    if (matched === 'shared-ref') {
      const refs = referencedPages(blocks, pageId)
      const common = [...myRefs].find((target) => refs.has(target))
      const target = common ? blocks.get(common) : undefined
      consider(page, 'shared-ref', `都引用了《${target ? pageName(target) : '同一篇'}》`)
      continue
    }
    consider(page, matched, matched === 'title' ? `标题含「${query}」` : matched === 'backlink' ? '已引用本篇' : '同标签')
  }

  const index = (reason: SuggestReason) => RULE_ORDER.indexOf(reason)
  const all = [...best.values()]
  all.sort((left, right) => index(left.reason) - index(right.reason) || left.name.localeCompare(right.name, 'zh-CN'))
  return all.slice(0, limit)
}
