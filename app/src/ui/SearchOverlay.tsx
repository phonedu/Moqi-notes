import { useEffect, useMemo, useRef, useState } from 'react'
import type { SearchHit, SearchPort } from '../application/search'
import { Dialog } from './Dialogs'
import { Icon } from '@moqi/editor'
import type { TagSummary } from './types'

/**
 * ⌘K 命令面板（`docs/09` §6.3 `R09-SEARCH-1…4`）。
 *
 * 分工：**这里只管「搜什么、怎么看、选中哪一条」**——查询与结果都走 `SearchPort`（桌面 = SQLite FTS5，
 * 浏览器 = 内存子串扫描，语义一致）；**跳转是外壳的事**（`onJump` 复用既有的跨页跳转 + 展开祖先 +
 * 闪烁高亮，见 `R09-SEARCH-3` 与 `REF-JUMP-1` 同一条通路）。
 *
 * 本版**只做真实可用的筛选**：关键词 + `#标签`（chips 来自标签注册表）。`R09-SEARCH-2` 里
 * `状态:进行中` / `时间:本周` 两条 chips 与语法提示**留到筛选面板那一步**（同源条件）——
 * 界面不承诺没有执行者的语法。
 */
export function SearchOverlay({ searchPort, tags, pageNameOf, onJump, onAskAi, onClose }: {
  searchPort: SearchPort
  tags: TagSummary[]
  /** 这条命中在哪一页（块结果右侧显示；跨页搜索时不显示就分不清同名的两句）。 */
  pageNameOf: (hit: SearchHit) => string
  onJump: (blockId: string) => void
  /** V2c 有来源问答：把这次命中的块交给 AI 助手当范围（`11` 的问答行）。 */
  onAskAi?: (sourceIds: string[]) => void
  onClose: () => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [query, setQuery] = useState('')
  const [tagFilter, setTagFilter] = useState<string[]>([])
  const [hits, setHits] = useState<SearchHit[]>([])
  const [index, setIndex] = useState(0)
  /** 竞态闸：只认最后一次请求的结果（端口是异步的，打字时前一次可能后到）。 */
  const requestRef = useRef(0)

  useEffect(() => {
    const request = requestRef.current + 1
    requestRef.current = request
    let cancelled = false
    void searchPort.search(query, { tags: tagFilter }).then((next) => {
      if (cancelled || request !== requestRef.current) return
      setHits(next)
      setIndex(0)
    })
    return () => { cancelled = true }
  }, [searchPort, query, tagFilter])

  const needle = query.trim()
  // 标签分组：注册表里名字含有查询词的标签，点一下就是「按这个标签筛」。
  const tagHits = useMemo(
    () => (needle.length === 0 ? [] : tags.filter((tag) => tag.name.includes(needle)).slice(0, 6)),
    [tags, needle],
  )
  const pages = hits.filter((hit) => hit.isObject)
  const blocks = hits.filter((hit) => !hit.isObject)
  const flat = [...pages, ...blocks]

  const move = (step: number) => {
    if (flat.length === 0) return
    setIndex((current) => (current + step + flat.length) % flat.length)
  }
  const open = (hit: SearchHit | undefined) => {
    if (!hit) return
    onJump(hit.entityId)
    onClose()
  }
  const toggleTag = (tagId: string) => {
    setTagFilter((current) => current.includes(tagId) ? current.filter((item) => item !== tagId) : [...current, tagId])
    inputRef.current?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); return }
    if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); return }
    if (event.key === 'Enter') { event.preventDefault(); open(flat[index]) }
  }

  /** 关键词高亮：只切文本、不改结构（HTML 一律当文本插入）。 */
  const marked = (text: string) => {
    if (needle.length === 0) return text
    const parts = text.split(needle)
    return parts.map((part, at) => (
      <span key={at}>
        {part}
        {at < parts.length - 1 ? <mark>{needle}</mark> : null}
      </span>
    ))
  }

  const row = (hit: SearchHit, flatIndex: number) => (
    <button
      type="button"
      key={hit.entityId}
      className={`sr-row${flatIndex === index ? ' is-active' : ''}`}
      onMouseEnter={() => setIndex(flatIndex)}
      onClick={() => open(hit)}
    >
      <Icon name={hit.isObject ? 'file-text' : 'file'} size={16} decorative />
      <span className="sr-text">{marked(hit.text.length > 0 ? hit.text : '（空块）')}</span>
      <span className="sr-kind">{hit.isObject ? '页面' : (pageNameOf(hit) || '未命名页面')}</span>
    </button>
  )

  return (
    <Dialog
      title="全局搜索"
      initialFocus={inputRef as React.RefObject<HTMLElement | null>}
      onClose={onClose}
      footer={
        <div className="fd-foot sr-foot">
          <span>↑↓ 选择 · ↵ 打开 · Esc 关闭</span>
          {/* 有来源问答的入口：把「这次检索命中的块」当范围，而不是整篇（`11` 的问答行）。 */}
          {onAskAi ? (
            <button type="button" className="sr-ask" disabled={flat.length === 0} title={flat.length === 0 ? '先搜出结果' : '就这些问 AI'} onClick={() => onAskAi(flat.map((hit) => hit.entityId))}>
              就这些问 AI
            </button>
          ) : null}
        </div>
      }
    >
      <div className="sr-body" onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          className="inp sr-input"
          type="text"
          value={query}
          placeholder="搜索…"
          aria-label="搜索关键词"
          onChange={(event) => setQuery(event.target.value)}
        />
        {tagFilter.length > 0 ? (
          <div className="sr-chips">
            {tagFilter.map((tagId) => (
              <button type="button" key={tagId} className="sr-chip" onClick={() => toggleTag(tagId)} title="点一下取消这个筛选">
                #{tags.find((tag) => tag.id === tagId)?.name ?? tagId}<span aria-hidden="true"> ×</span>
              </button>
            ))}
          </div>
        ) : null}

        {needle.length === 0 ? (
          <p className="sr-empty">输入关键词开始搜索。</p>
        ) : flat.length === 0 && tagHits.length === 0 ? (
          <p className="sr-empty">没有找到包含「{needle}」的内容。</p>
        ) : (
          <>
            {tagHits.length > 0 ? (
              <div className="sr-group">
                <h4>标签</h4>
                {tagHits.map((tag) => (
                  <button type="button" key={tag.id} className="sr-row" onClick={() => toggleTag(tag.id)}>
                    <Icon name="hash" size={16} decorative />
                    <span className="sr-text">#{marked(tag.name)}</span>
                    <span className="sr-kind">{tag.count} 处</span>
                  </button>
                ))}
              </div>
            ) : null}
            {pages.length > 0 ? (
              <div className="sr-group">
                <h4>页面</h4>
                {pages.map((hit) => row(hit, flat.indexOf(hit)))}
              </div>
            ) : null}
            {blocks.length > 0 ? (
              <div className="sr-group">
                <h4>块</h4>
                {blocks.map((hit) => row(hit, flat.indexOf(hit)))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </Dialog>
  )
}
