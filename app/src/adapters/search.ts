import { SEARCH_LIMIT, type PinyinIndexEntry, type SearchFilter, type SearchHit, type SearchIndexStatus, type SearchPort } from '../application/search'
import type { BlockMap, MetadataRegistry } from '@moqi/editor'
import { invoke } from '@tauri-apps/api/core'

/**
 * 关键词检索的两条实现（`docs/03` §15.2 的端口）：
 * - `TauriSearchPort`：桌面 / Android，走 SQLite FTS5（`trigram`；1–2 字的查询由存储层兜底成扫描）。
 * - `BrowserSearchPort`：浏览器通道（开发、验收、单测），对内存里的块图做子串扫描。
 *
 * **结果语义必须一致**（`SEARCH-PARITY-1`）：命中范围（正文 / 标签 / 属性 / 页面名）、
 * 排除已删、页面在前 + 按修改时间倒序、默认 50 条——这些在两边是同一条规则，
 * 只是桌面那份由 SQL 执行、这份由 `substringHits` 执行。
 *
 * 浏览器那份实现在 `application/searchSubstring.ts`、**按需装入**（性能批 ⓒ ①）：它拖着
 * `pinyin-pro`（≈300 KB），而桌面 / Android 渠道永远不会走到它——不该为它付启动解析费。
 */
export class TauriSearchPort implements SearchPort {
  async search(query: string, filter: SearchFilter = {}): Promise<SearchHit[]> {
    const hits = await invoke<SearchHit[]>('search_blocks', { query, limit: filter.limit ?? SEARCH_LIMIT })
    // 标签 / 类型筛不在 SQL 里做：结果是几十条，过滤在这里做比把条件塞进两条 SQL 通路更省心
    // （FTS 那条还要兼顾 1–2 字的兜底通路，条件写在两处容易漂移）。
    return filterHits(hits, filter)
  }

  async status(): Promise<SearchIndexStatus> {
    return invoke<SearchIndexStatus>('index_status')
  }

  async updatePinyinIndex(entries: PinyinIndexEntry[]): Promise<number> {
    if (entries.length === 0) return 0
    return invoke<number>('update_pinyin_index', { entries })
  }
}

export class BrowserSearchPort implements SearchPort {
  /**
   * 读的是**当下的**块图（外壳按 revision 缓存的快照），不是端口内部的副本；
   * 注册表同样读当下的（A2：属性名 / 选项名 / 标签名要当场解析得出来）。
   */
  constructor(
    private readonly blocks: () => BlockMap,
    private readonly registry: () => MetadataRegistry | null = () => null,
  ) {}

  async search(query: string, filter: SearchFilter = {}): Promise<SearchHit[]> {
    const { substringHits } = await import('../application/searchSubstring')
    return substringHits(this.blocks(), query, filter, this.registry())
  }

  /**
   * 浏览器通道**没有索引**——如实说（`engine: 'memory-scan'`），规模报存活块数。
   * 不假装有索引、也不发明一个「重建时间」：那一栏在界面显示「不适用」。
   */
  async status(): Promise<SearchIndexStatus> {
    let indexed = 0
    for (const block of this.blocks().values()) if (!block.deleted) indexed += 1
    // 内存通路没有「写入拼音」这一步（查询时就地算），所以拼音覆盖率就等于规模。
    return { engine: 'memory-scan', indexed, rebuiltAt: null, pinyinIndexed: indexed, failures: 0 }
  }

  /** 内存通路不需要写拼音索引——查询时按需算（实现成 no-op，调用方不用分端判断）。 */
  async updatePinyinIndex(): Promise<number> {
    return 0
  }
}

/**
 * 标签与块类型的筛选：两条实现共用（`TauriSearchPort` 从 SQL 拿到结果后再过一遍，
 * 让「筛」只有一处规则——FTS 那条还有 1–2 字的兜底通路，条件写进两条 SQL 迟早漂移）。
 * `filter.tags` 是**标签 id 列表**，全部命中才算（AND 语义）。
 */
export function filterHits(hits: SearchHit[], filter: SearchFilter): SearchHit[] {
  const kinds = filter.kinds && filter.kinds.length > 0 ? filter.kinds : null
  const tags = filter.tags && filter.tags.length > 0 ? filter.tags : null
  if (!kinds && !tags) return hits
  return hits.filter((hit) => (!kinds || kinds.includes(hit.blockType)) && (!tags || tags.every((tag) => hit.tags.includes(tag))))
}

export function createDefaultSearchPort(blocks: () => BlockMap, registry: () => MetadataRegistry | null = () => null): SearchPort {
  const tauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  return tauri ? new TauriSearchPort() : new BrowserSearchPort(blocks, registry)
}
