import { useState } from 'react'
import type { LibraryFilter, SortDirection, SortField } from './libraryFilter'
import { filterableProperties } from './libraryFilter'
import { Icon } from '@moqi/editor'
import { Popover } from './Popover'
import type { AnchorRect } from './Popover'
import type { PropertyDef, TagSummary } from './types'

/**
 * 页面库的筛选下拉（`docs/09` §4.2 `R09-FILT-1…9`）。
 *
 * 分工：**判据不在这个文件里**——命中与排序是 `ui/libraryFilter.ts` 的纯函数（有单测），
 * 这里只做两件事：把条件画出来、把「查看 N 条」说出来。面板是**受控**的（条件住外壳，
 * 因为侧栏点标签也要改它，`R09-FILT-7`：两处必须同步）。
 *
 * 本版**只画有执行者的条件**（与 ⌘K 那边同一条纪律）：
 * - 不画「内容类型（图片 / 附件 / 链接）」——这个产品里没有媒体块，行内链接也不按页面聚合，
 *   画出来就是一句没人执行的承诺（`03` §15 的后续项，等真有媒体块再说）。
 * - 「自定义」时间范围与「🔖 保存筛选方案」按规范自身的口径属于后期实现，因此**禁用并可见标注
 *   「后续版本」**（`R09-SCOPE-17` 立的先例：未实现项要让人一眼看出没实现）。
 */
type FilterPanelProps = {
  anchor: AnchorRect
  filter: LibraryFilter
  /** 当前条件下命中的条数——底部按钮读它（`R09-FILT-6`）。 */
  resultCount: number
  totalCount: number
  tags: TagSummary[]
  properties: PropertyDef[]
  onChange: (next: LibraryFilter) => void
  onClose: () => void
}

const STAR_ITEMS: { value: LibraryFilter['star']; label: string }[] = [
  { value: 'any', label: '不限' },
  { value: 'starred', label: '仅星标' },
  { value: 'unstarred', label: '未星标' },
]
const TAG_MODE_ITEMS: { value: LibraryFilter['tagMode']; label: string }[] = [
  { value: 'any', label: '不限' },
  { value: 'include', label: '含所选' },
  { value: 'exclude', label: '排除所选' },
]
const TIME_FIELD_ITEMS: { value: LibraryFilter['timeField']; label: string }[] = [
  { value: 'modified', label: '编辑' },
  { value: 'created', label: '创建' },
]
const TIME_RANGE_ITEMS: { value: LibraryFilter['timeRange']; label: string }[] = [
  { value: 'any', label: '不限' },
  { value: 'today', label: '今天' },
  { value: 'week', label: '近 7 天' },
  { value: 'month', label: '近 30 天' },
  { value: 'thisMonth', label: '本月' },
  { value: 'thisYear', label: '今年' },
]
const BACKLINK_ITEMS: { value: LibraryFilter['backlinks']; label: string }[] = [
  { value: 'any', label: '不限' },
  { value: 'has', label: '有反链' },
  { value: 'none', label: '无反链' },
]
const SORT_FIELDS: { value: SortField | 'default'; label: string }[] = [
  { value: 'default', label: '默认（置顶优先）' },
  { value: 'modified', label: '编辑时间' },
  { value: 'created', label: '创建时间' },
  { value: 'title', label: '标题' },
]

/** 排序入口上那句实时文案（`R09-FILT-2`：显示当前值；按属性时把属性名说出来）。 */
export function sortLabel(filter: LibraryFilter, defs: PropertyDef[] = []): string {
  if (!filter.sort) return '默认（置顶优先）'
  const direction = filter.sort.direction === 'desc'
  if (filter.sort.field === 'property') {
    const name = defs.find((def) => def.id === filter.sort?.defId)?.name ?? '属性'
    return `按属性 · ${name}：${direction ? '从大到小 / Z → A' : '从小到大 / A → Z'}`
  }
  const field = filter.sort.field === 'modified' ? '编辑时间' : filter.sort.field === 'created' ? '创建时间' : '标题'
  if (filter.sort.field === 'title') return `${field}：${direction ? 'Z → A' : 'A → Z'}`
  return `${field}：${direction ? '从新到旧' : '从旧到新'}`
}

export function LibraryFilterPanel({ anchor, filter, resultCount, totalCount, tags, properties, onChange, onClose }: FilterPanelProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [sortOpen, setSortOpen] = useState(false)
  const [keywordDraft, setKeywordDraft] = useState('')
  const set = (patch: Partial<LibraryFilter>) => onChange({ ...filter, ...patch })
  const toggleTag = (tagId: string) => set({ tagIds: filter.tagIds.includes(tagId) ? filter.tagIds.filter((id) => id !== tagId) : [...filter.tagIds, tagId] })
  const toggleOption = (defId: string, optionId: string) => {
    const group = filter.propertyOptions.find((item) => item.defId === defId)
    const optionIds = group?.optionIds ?? []
    const next = optionIds.includes(optionId) ? optionIds.filter((id) => id !== optionId) : [...optionIds, optionId]
    // 点选项即离开「未设置」档（两档互斥：同一条属性不可能同时"是某值"与"没有值"）。
    set({ propertyOptions: [...filter.propertyOptions.filter((item) => item.defId !== defId), { defId, optionIds: next }] })
  }
  /** 「未设置」（§A4）：整组拨到"没有值"档（清掉这组已选选项——两档互斥）；再点取消。 */
  const toggleUnset = (defId: string) => {
    const group = filter.propertyOptions.find((item) => item.defId === defId)
    const next = !(group?.unset === true)
    set({ propertyOptions: [...filter.propertyOptions.filter((item) => item.defId !== defId), { defId, optionIds: [], unset: next }] })
  }
  const addKeyword = () => {
    const value = keywordDraft.trim()
    if (value.length === 0 || filter.keywords.includes(value)) { setKeywordDraft(''); return }
    set({ keywords: [...filter.keywords, value] })
    setKeywordDraft('')
  }
  const setSort = (value: SortField | 'default', defId?: string) => {
    if (value === 'default') { set({ sort: null }); return }
    const current = filter.sort
    const direction: SortDirection = current && current.field === value ? current.direction : 'desc'
    if (value === 'property') {
      set({ sort: { field: 'property', defId: defId ?? current?.defId ?? filterableProperties(properties)[0]?.id, direction } })
      return
    }
    set({ sort: { field: value, direction } })
  }
  const flipDirection = () => {
    if (!filter.sort) { set({ sort: { field: 'modified', direction: 'asc' } }); return }
    set({ sort: { field: filter.sort.field, direction: filter.sort.direction === 'desc' ? 'asc' : 'desc' } })
  }

  /** 单选组：选中态是描边式（`R09-FILT-5`），「不限」永远是首项兜底。 */
  const group = <T extends string>(items: { value: T; label: string }[], value: T, onPick: (next: T) => void, label: string) => (
    <div className="fp-seg" role="group" aria-label={label}>
      {items.map((item) => (
        <button type="button" key={item.value} className={item.value === value ? 'fp-chip is-on' : 'fp-chip'} onClick={() => onPick(item.value)}>
          {item.label}
        </button>
      ))}
    </div>
  )

  return (
    <Popover anchor={anchor} align="right" width={352} maxHeight={460} className="fp" label="筛选" onClose={onClose}>
      <div className="fp-head">
        <span className="fp-title">筛选</span>
        {/* 计数从「查看 N 条」按钮搬到这里（批 η ①）：信息保住、按钮不再被文案撑动（用户原话「里面的计数就删掉」）。 */}
        <span className="fp-count">{resultCount === 0 ? '没有命中' : `命中 ${resultCount} 条`}</span>
        <span style={{ flex: 1 }} />
        {/* 排序入口：实时显示当前值，点它展开排序下拉（`R09-FILT-2` / `R09-FILT-8`） */}
        <button type="button" className="fp-sort" aria-expanded={sortOpen} onClick={() => setSortOpen((open) => !open)}>
          <Icon name="list" size={16} decorative /><span>{sortLabel(filter, properties)}</span>
        </button>
        {/* B 批（`R09-STATE-5` / "隐藏优于灰着"）：原「保存」按钮（禁用 + 「后续版本」标注）**已删**——
            它依赖「保存筛选」功能本身（`05` 待审 #21），保留只会占位并解释一遍“为什么不能点”。 */}
      </div>
      {sortOpen ? (
        /* 排序是**替换内容**的子视图，不是叠在条件上的浮层：352px 宽的面板里再浮一层会互相压字
           （ 实测：说明文字被挤成一列、标题折行）。 */
        <div className="fp-sort-view" role="group" aria-label="排序">
          {SORT_FIELDS.map((item) => (
            <button type="button" key={item.value} className={(!filter.sort && item.value === 'default') || filter.sort?.field === item.value ? 'fp-sort-row is-on' : 'fp-sort-row'} onClick={() => setSort(item.value)}>
              {item.label}
            </button>
          ))}
          {/* 按属性（`13-属性区重规划` §7.1-A4「排序扩一档」）：选一个属性当排序键；
              未设置的页面不论升降都排最后（判据在 `libraryFilter` 的 `applyLibraryFilter`）。 */}
          {filterableProperties(properties).length > 0 ? (
            <div className="fp-row" style={{ padding: '6px 0 0' }}>
              <span className="fp-label">按属性</span>
              <div className="fp-seg" role="group" aria-label="按属性排序">
                {filterableProperties(properties).map((def) => (
                  <button
                    type="button"
                    key={def.id}
                    className={filter.sort?.field === 'property' && filter.sort.defId === def.id ? 'fp-chip is-on' : 'fp-chip'}
                    onClick={() => setSort('property', def.id)}
                  >
                    {def.name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
          <div className="fp-sort-foot">
            <span className="fp-note">排序只调顺序，不改筛选结果</span>
            <button type="button" className="fp-flip" onClick={flipDirection} disabled={!filter.sort}>
              {filter.sort?.direction === 'asc' ? '从旧到新 / A → Z' : '从新到旧 / Z → A'}
            </button>
          </div>
        </div>
      ) : (
      <div className="fp-body">
        <div className="fp-row"><span className="fp-label">星标</span>{group(STAR_ITEMS, filter.star, (value) => set({ star: value }), '星标')}</div>
        <div className="fp-row"><span className="fp-label">标签模式</span>{group(TAG_MODE_ITEMS, filter.tagMode, (value) => set({ tagMode: value }), '标签模式')}</div>
        <div className="fp-tags">
          {tags.length === 0 ? <span className="fp-note">还没有标签</span> : tags.map((tag) => (
            <button
              type="button"
              key={tag.id}
              className={filter.tagIds.includes(tag.id) ? 'fp-chip fp-tag is-on' : 'fp-chip fp-tag'}
              disabled={filter.tagMode === 'any'}
              onClick={() => toggleTag(tag.id)}
            >
              #{tag.name}
            </button>
          ))}
        </div>
        <div className="fp-row"><span className="fp-label">时间类型</span>{group(TIME_FIELD_ITEMS, filter.timeField, (value) => set({ timeField: value }), '时间类型')}</div>
        <div className="fp-row"><span className="fp-label">时间范围</span>{group(TIME_RANGE_ITEMS, filter.timeRange, (value) => set({ timeRange: value }), '时间范围')}</div>
        <button type="button" className="fp-adv-toggle" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((open) => !open)}>
          <Icon name={advancedOpen ? 'chevron-up' : 'chevron-down'} size={13} decorative />高级筛选
        </button>
        {advancedOpen ? (
          <div className="fp-adv">
            {filterableProperties(properties).length === 0 ? (
              <span className="fp-note">属性库还没有属性</span>
            ) : filterableProperties(properties).map((def) => {
              const group = filter.propertyOptions.find((item) => item.defId === def.id)
              return (
                <div className="fp-row" key={def.id}>
                  <span className="fp-label">{def.name}</span>
                  <div className="fp-seg" role="group" aria-label={def.name}>
                    {(def.options ?? []).map((option) => {
                      const picked = group?.optionIds.includes(option.id) ?? false
                      return (
                        <button type="button" key={option.id} className={picked ? 'fp-chip is-on' : 'fp-chip'} onClick={() => toggleOption(def.id, option.id)}>
                          {option.label}
                        </button>
                      )
                    })}
                    {/* 「未设置」对**所有类型**的属性都成立（文本 / 数字 / 日期原先没有任何条件可表达）。 */}
                    <button type="button" className={group?.unset === true ? 'fp-chip is-on' : 'fp-chip'} onClick={() => toggleUnset(def.id)}>
                      未设置
                    </button>
                  </div>
                </div>
              )
            })}
            <div className="fp-row">
              <span className="fp-label">关键词</span>
              <div className="fp-keywords">
                <input
                  className="inp fp-kw-input"
                  placeholder="加一个关键词，回车添加"
                  aria-label="筛选关键词"
                  value={keywordDraft}
                  onChange={(event) => setKeywordDraft(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addKeyword() } }}
                />
                <button type="button" className="fp-kw-add" onClick={addKeyword} disabled={keywordDraft.trim().length === 0}>添加</button>
              </div>
            </div>
            {filter.keywords.length > 0 ? (
              <div className="fp-tags">
                {filter.keywords.map((keyword) => (
                  <button type="button" key={keyword} className="fp-chip is-on" title="点一下移除" onClick={() => set({ keywords: filter.keywords.filter((item) => item !== keyword) })}>
                    {keyword}<span aria-hidden="true"> ×</span>
                  </button>
                ))}
              </div>
            ) : null}
            <div className="fp-row"><span className="fp-label">反向链接</span>{group(BACKLINK_ITEMS, filter.backlinks, (value) => set({ backlinks: value }), '反向链接')}</div>
          </div>
        ) : null}
      </div>
      )}

      <div className="fp-foot">
        <button type="button" className="fp-reset" onClick={() => onChange({ ...filter, star: 'any', tagMode: 'any', tagIds: [], timeRange: 'any', propertyOptions: [], keywords: [], backlinks: 'any' })}>重置</button>
        <button type="button" className="fp-done" onClick={onClose}>完成</button>
      </div>
      {resultCount === 0 && totalCount > 0 ? <p className="fp-empty">当前条件没有命中的页面——放松一点条件试试。</p> : null}
    </Popover>
  )
}
