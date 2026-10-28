import type { BlockType } from '@moqi/editor'

/**
 * 关键词检索端口（`docs/03` §15.2）。
 *
 * 与 `StoragePort` / `SyncPort` 同级：**业务代码只认这个接口**，桌面走 SQLite FTS5（`trigram`），
 * 浏览器通道与单测走内存子串扫描——两条实现必须给出**同一套结果语义**（`SEARCH-PARITY-1`：
 * 同一条查询在两端结果一致，见 `11` 的 `3.16`）。
 *
 * 命中范围（两端一致）：正文、标签、属性、**页面名**。已删的块不进结果。
 * 页面（对象块）命中时 `text` 给**名字**——⌘K 的结果按「页面 / 块 / 标签」分组（`R09-SEARCH-2`），
 * 页面那一组要显示名字，不是一个空正文。
 *
 * **本文件只放端口契约**（类型 ＋ `SEARCH_LIMIT`）：主包常驻，且不拖 `pinyin-pro`。浏览器通道那份
 * 实现（`substringHits`）住在 `searchSubstring.ts`、由 `BrowserSearchPort` 按需装入（性能批 ⓒ ①）。
 */
export type SearchHit = {
  entityId: string
  blockType: BlockType
  isObject: boolean
  objectName: string | null
  /** 所在页面（跳转与分组用）；页面自己命中时是它自己。 */
  parentId: string | null
  /** 命中文本：页面给名字，其余给正文。 */
  text: string
  /** 标签 id（⌘K 的 chips 按它筛选；名字→id 的换算在界面侧用标签注册表做）。 */
  tags: string[]
  modified: number
}

export type SearchFilter = {
  /** 只保留含这些标签的块（标签 id）。 */
  tags?: string[]
  /** 只保留这些块类型。 */
  kinds?: BlockType[]
  limit?: number
}

export interface SearchPort {
  search(query: string, filter?: SearchFilter): Promise<SearchHit[]>
  /** 索引状态（`09-桌面端交互规范` `R09-SEARCH-6`）：设置里那一行读它——**降级要看得见**，不是静默少一块能力。 */
  status(): Promise<SearchIndexStatus>
  /**
   * V2c 路线 B：把「前端算好的拼音」写进索引（启动回填 / 每批保存后刷新）。
   * 桌面走 command；浏览器通道**天然不需要**（它按需在内存里算），实现为 no-op 返回 0。
   */
  updatePinyinIndex(entries: PinyinIndexEntry[]): Promise<number>
}

export type PinyinIndexEntry = { entityId: string; full: string; initials: string }

/**
 * 索引状态（`R09-SEARCH-6` / `R09-SET-13`）。
 *
 * `engine` 如实说明用的是哪条通路：`fts5-trigram`（桌面 / Android 的 SQLite 索引）
 * 或 `memory-scan`（浏览器通道对内存块图扫描——没有索引这回事，别假装有）。
 * `failures` 在两条通路上都恒为 0，理由不同但都成立：FTS 与 `blocks` 同事务写；内存扫描没有写入环节。
 */
export type SearchIndexStatus = {
  engine: 'fts5-trigram' | 'memory-scan'
  indexed: number
  rebuiltAt: number | null
  /**
   * V2c 路线 B：**算过拼音的块数**（判据是索引里的 `pinyin_at` 标记，不是「拼音非空」）。
   * 老库升级后由前端回填前，它小于 `indexed`；空块与纯标点块算完照样计入覆盖——
   * 它们的拼音合法地是空串，拿非空当判据会让覆盖率永远差几块（2026-10-04 真机验收抓到的坑）。
   */
  pinyinIndexed: number
  failures: number
}

/** 默认返回条数：⌘K 一屏 + 滚动余量；两端一致（存储层的 command 也默认 50）。 */
export const SEARCH_LIMIT = 50

