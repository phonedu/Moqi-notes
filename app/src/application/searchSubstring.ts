import { textContent, type Block, type BlockMap, type MetadataRegistry, type PropertyDef, type PropertyValue } from '@moqi/editor'
import { cachedPinyinIndex, isPinyinQuery, pinyinMatches, pinyinSourceText } from './pinyinSearch'
import { SEARCH_LIMIT, type SearchFilter, type SearchHit } from './search'

/**
 * A2（`13-属性区重规划` §7.1-A2）：一条属性值的**显示文本**——与 Rust 侧
 * `storage_model.rs` 的 `property_display_text` / `apply_search_text` **同一套口径**
 * （`SEARCH-PARITY-1`）：定义缺失退回裸值（select 退回 `optionId`）、显示值为空整条跳过。
 */
function propertyDisplayText(value: PropertyValue, def: PropertyDef | undefined): string {
  switch (value.type) {
    case 'checkbox': return value.value ? '已完成' : '未完成'
    case 'select': return def?.options?.find((option) => option.id === value.optionId)?.label ?? value.optionId
    case 'number': return String(value.value)
    case 'date':
    case 'text': return value.value
  }
}

/** 属性段的检索文本：每条写「名称: 显示值」；定义缺失时只写显示值（与 Rust 侧同口径）。 */
function propertySearchText(block: Block, registry: MetadataRegistry | null): string {
  const lines: string[] = []
  for (const value of block.properties) {
    const def = registry?.properties.find((item) => item.id === value.defId)
    const display = propertyDisplayText(value, def)
    if (display.length === 0) continue
    lines.push(def ? `${def.name}: ${display}` : display)
  }
  return lines.join('\n')
}

/** 标签段的检索文本：按**名字**（注册表解析不到就退回 id）——此前存的是 id，名字搜不到。 */
function tagSearchText(block: Block, registry: MetadataRegistry | null): string {
  return block.tags.map((id) => registry?.tags.find((tag) => tag.id === id)?.name ?? id).join(',')
}

/**
 * 内存子串扫描：浏览器通道与单测的实现，也是**结果语义的参照**（桌面那条要跟它对齐）。
 *
 * **为什么单独一份文件**（性能批 ⓒ ①）：它拖着 `pinyin-pro`（≈300 KB ≈ 主包四分之一），
 * 而桌面 / Android 渠道压根不走它（走 SQLite FTS5）——只在浏览器通道被用到时才该装进来。
 * 所以从 `search.ts` 拆出，由 `adapters/search.ts` 的 `BrowserSearchPort` **动态 import**；
 * 端口契约（类型 ＋ `SEARCH_LIMIT`）留在 `search.ts`：主包常驻、不拖拼音。单测照旧静态 import
 * 本文件（node 里没有分包这回事）。口径见 `03` §11.4 第 1 行。
 *
 * 为什么不做「≥3 字 / <3 字」两段式：那是 SQLite `trigram` 索引的约束（三字一组才建索引），
 * 内存里没有索引，一次 `includes` 覆盖全部长度——**语义上比 FTS 更宽**，所以只有桌面侧需要
 * 那条兜底；两端在这一层不该有差别（`03` §15.2 的缺口 ② 解释的就是这个约束）。
 */
export function substringHits(blocks: BlockMap, query: string, filter: SearchFilter = {}, registry: MetadataRegistry | null = null): SearchHit[] {
  const needle = query.trim()
  if (needle.length === 0) return []
  // 拼音通路（路线 B）：查询串是纯字母时，额外按「拼音 + 首字母」匹配——中文原文命中仍然照旧。
  const pinyinQuery = isPinyinQuery(needle)
  const limit = filter.limit ?? SEARCH_LIMIT
  const hits: SearchHit[] = []
  for (const block of blocks.values()) {
    if (block.deleted) continue
    if (filter.kinds && !filter.kinds.includes(block.type)) continue
    if (filter.tags && filter.tags.length > 0 && !filter.tags.every((tag) => block.tags.includes(tag))) continue
    const text = block.isObject ? (block.objectName ?? '') : textContent(block)
    // A2：属性与标签按**可读文本**参与命中（「名称: 显示值」/ 标签名）——与桌面索引同一套口径。
    const haystack = [text, block.objectName ?? '', tagSearchText(block, registry), propertySearchText(block, registry)]
    const textHit = haystack.some((part) => part.includes(needle))
    const pinyinHit = pinyinQuery && pinyinMatches(cachedPinyinIndex(block.entityId, block.modified, pinyinSourceText(block)), needle)
    if (!textHit && !pinyinHit) continue
    hits.push({
      entityId: block.entityId,
      blockType: block.type,
      isObject: block.isObject,
      objectName: block.objectName,
      parentId: block.parent,
      text,
      tags: [...block.tags],
      modified: block.modified,
    })
  }
  // 与存储层同序：页面在前，然后按修改时间倒序；到限就截断。
  hits.sort((left, right) => Number(right.isObject) - Number(left.isObject) || right.modified - left.modified)
  return hits.slice(0, limit)
}
