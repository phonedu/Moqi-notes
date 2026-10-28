import { useRef, useState, type KeyboardEvent } from 'react'
import { Icon } from '@moqi/editor'
import { ConfirmDialog } from './Dialogs'
import { PROPERTY_TYPE_META, TypeGlyph } from './PropertyRows'
import type { PropertyDef } from './types'
import { PageHead } from './SettingsData'

/**
 * 设置 · **全局属性管理**（`09-桌面端UI规范` §十五 θ4 重设计 · 条文 `R09-SET-5b`）：
 * **行式列表**（把手 / 类型字形 / 名称 / 类型 / 行尾 `✏` `🗑`）＋「**就地展开 ＋ 完成**」一套管两件事——
 * 添加（`＋ 添加属性` ▸ 名称 ▸ 类型 chips ▸ 完成）与二次编辑（名称 / 类型只读 / 选项维护 / 用量）。
 * **删除只有一处（行尾 `🗑`）**；**编辑只走行尾 `✏`**（行体不可点，`R04-TOOL-1` 一个动作一个位置）；
 * **进编辑态 ⇒ 行尾只剩 `✓ 完成`**——编辑时没有人会删（用户 修正：砍掉面板里那个重复的删除按钮）。
 *
 * 三条边界的所在：**类型创建时定死**（编辑态只读）；改名不动数据（值按 `defId` 挂，判据在域层，
 * 失败**就地一句**不弹通知，`§0-6`）；删除的两步与影响清单照 `R09-SET-5` 的现行口径
 * （第 ① 步在动作层清全库取值、可 ⌘Z）。删选项同款：先在域层清掉引用它的取值，再移除选项。
 *
 * 顺序 = 数据（θ4 ④）：`registry.properties` 与 `def.options` 的**数组序**就是真源，
 * 摘要条属性行与卡片属性行同序；桌面「把手」拖拽改它，窄档押后（`10` §4.8 第二屏不含排序）。
 */
export function SettingsProperties({
  properties, usage, onCreateProperty, onRenameProperty, onDeleteProperty, onNameProblem, ops,
}: {
  properties: PropertyDef[]
  /** 每个定义的用量读数（`§3.6`「用在 N 页」/ `§3.2` 删除影响清单）；`options` = 每个选项的用量（θ4 删选项用）。 */
  usage: Record<string, { pages: number; values: number; options: Record<string, number> }>
  onCreateProperty: (name: string, type: PropertyDef['type']) => void
  /** 改名：**返回失败原因**（`null` = 成功）——就地显示，不弹通知（`§0-6`）。 */
  onRenameProperty: (defId: string, name: string) => string | null
  /** 删除用户属性（§3.2：两步，确认框里的影响清单由本组件给）。 */
  onDeleteProperty: (defId: string) => void
  /** 名称判据（`propertyNameProblem` ＋ 人话）——「完成」的可点性与就地一句都走它，判据只有一份。 */
  onNameProblem: (name: string, excludeId?: string) => string | null
  /** θ4 选项维护（单选型）：改名（返回是否成功）/ 删除（动作层清值 → 移除选项）/ 排序（数组序 = 数据）。 */
  ops: {
    onAddOption: (defId: string, label: string) => void
    onRenameOption: (defId: string, optionId: string, label: string) => boolean
    onRemoveOption: (defId: string, optionId: string) => void
    onMoveOption: (defId: string, optionId: string, toIndex: number) => void
    onMoveProperty: (defId: string, toIndex: number) => void
  }
}) {
  const [query, setQuery] = useState('')
  /** 就地展开（θ4）：`null` = 都收着 · `'add'` = 添加态 · 其余 = 编辑态（该定义 id）。**互斥**：一次只开一个。 */
  const [open, setOpen] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<PropertyDef['type']>('text')
  /** 编辑态的名称草稿与就地失败原因；提交时机 = Enter / 失焦 /「完成」。 */
  const [nameDraft, setNameDraft] = useState('')
  const [nameProblem, setNameProblem] = useState<string | null>(null)
  /** 选项维护：一次一行的改名草稿（null = 全在只读态）＋ 选项失败原因 ＋ 添加选项草稿。 */
  const [optionDraft, setOptionDraft] = useState<{ optionId: string; value: string } | null>(null)
  const [optionProblem, setOptionProblem] = useState<string | null>(null)
  const [optionNew, setOptionNew] = useState('')
  /** 删除：两步的第一段——先弹影响清单（属性 §3.2 / 选项同款），确认才真删。 */
  const [deleting, setDeleting] = useState<PropertyDef | null>(null)
  const [removingOption, setRemovingOption] = useState<{ def: PropertyDef; optionId: string; label: string } | null>(null)
  /** 把手拖拽（θ4 ④）：**事实走 ref**（dragstart 与 drop 可能落在同一帧，state 读不到最新值——
      真实拖拽有间隔、脚本化拖拽没有；ref 两边都稳），state 只负责高亮「落在第几行」。 */
  const dragIdRef = useRef<string | null>(null)
  const dragOverRef = useRef<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const optionDragRef = useRef<{ optionId: string; over: number } | null>(null)
  const [optionDragOver, setOptionDragOver] = useState<number | null>(null)

  /** Esc 的**面板级**退出（捕获阶段拦下，`R09-KEY-13` 逐层退出的精神）：先收面板，不落到设置弹窗上。 */
  const escPanel = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    setOpen(null)
    setNameProblem(null)
  }

  const keyword = query.trim().toLocaleLowerCase()
  const filtered = keyword ? properties.filter((def) => def.name.toLocaleLowerCase().includes(keyword)) : properties
  /* 刚展开还不喊（空名是「还没开始填」，不是「填错了」）；打了字才判、或点「完成」时判。 */
  const [addTried, setAddTried] = useState(false)
  const addProblem = open === 'add' && (newName.trim().length > 0 || addTried) ? onNameProblem(newName) : null

  const openEdit = (def: PropertyDef) => {
    const next = open === def.id ? null : def.id
    setOpen(next)
    setNameDraft(def.name)
    setNameProblem(null)
    setOptionDraft(null)
    setOptionProblem(null)
    setOptionNew('')
  }

  /** 提交改名：失败**不收输入框**、就地显示原因（可以接着改）；成功 = 清问题。 */
  const commitName = (def: PropertyDef): boolean => {
    if (nameDraft.trim() === def.name) { setNameProblem(null); return true }
    const problem = onRenameProperty(def.id, nameDraft)
    setNameProblem(problem)
    return problem === null
  }

  /** 「完成」：添加态 = 建并收起；编辑态 = 提交改名后收起（改不动就不收）。 */
  const commitPanel = (def: PropertyDef | null) => {
    if (open === 'add') {
      if (newName.trim().length === 0 || addProblem) { setAddTried(true); return }
      onCreateProperty(newName.trim(), newType)
      setNewName('')
      setNewType('text')
      setOpen(null)
      return
    }
    if (def && !commitName(def)) return
    setOpen(null)
    setNameProblem(null)
  }

  return (
    <>
      <PageHead title="属性" meta={`共 ${properties.length} 条`} />
      <div
        className="set-card"
        /* 「点空白 = 收起」（θ4 规格原文）：行内（含展开面板 / 按钮）不收起，其余空白处收。 */
        onClick={(event) => { if ((event.target as HTMLElement).closest('.pmr, .pmr-foot, .pmr-panel')) return; setOpen(null); setNameProblem(null) }}
      >
        <h3><Icon name="properties" size={16} decorative />属性字典<span className="sub">所有页面的属性都从这里取值</span></h3>
        {/* 搜索行（θ4 ③）：列表上方一行；无命中给一句状态陈述（空态不给说明文字，`R09-STATE-5`）。 */}
        <div className="pmr-search">
          <Icon name="search" size={14} decorative />
          <input className="inp" aria-label="搜索属性" placeholder="搜索属性" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <div className="pmr-list">
          {filtered.map((def, index) => (
            <div
              key={def.id}
              className={`pm-row pmr${open === def.id ? ' is-open' : ''}${dragOver === index ? ' is-over' : ''}`}
              onDragOver={(event) => { if (!dragIdRef.current || dragIdRef.current === def.id) return; event.preventDefault(); dragOverRef.current = index; setDragOver(index) }}
              onDrop={(event) => { event.preventDefault(); if (dragIdRef.current !== null && dragOverRef.current !== null) ops.onMoveProperty(dragIdRef.current, dragOverRef.current); dragIdRef.current = null; dragOverRef.current = null; setDragOver(null) }}
            >
              {/* 行式（θ4 ①）：把手拖动排序（落数据）/ 类型字形 / 名称 / 类型 / 🗑；点行尾 ✏ = 就地展开编辑区。 */}
              <span
                className="pmr-grip"
                role="button"
                tabIndex={0}
                draggable
                aria-label={`拖动排序 ${def.name}`}
                title="拖动排序（落数据：摘要条与卡片属性行同序）"
                onDragStart={(event) => { dragIdRef.current = def.id; event.dataTransfer.effectAllowed = 'move' }}
                onDragEnd={() => { dragIdRef.current = null; dragOverRef.current = null; setDragOver(null) }}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
              ><Icon name="grip" size={14} decorative /></span>
              {/* 行体不可点：**一个动作一个位置**（`R04-TOOL-1`）——编辑只走行尾 `✏`，删除只走行尾 `🗑`。 */}
              <span className="pmr-main">
                <TypeGlyph type={def.type} />
                <span className="pmr-text">
                  <span className="k">{def.name}</span>
                  <span className="tp">{PROPERTY_TYPE_META[def.type].label}</span>
                </span>
              </span>
              {open === def.id ? (
                /* 编辑态：行尾只剩 `✓ 完成`（**编辑时没有人会删** ⇒ ✏ 与 🗑 一并隐去）。 */
                <button type="button" className="pmr-done" aria-label={`完成编辑 ${def.name}`} title="完成（收起）" onClick={() => commitPanel(def)}>
                  <Icon name="check" size={16} decorative />
                </button>
              ) : (
                <span className="pmr-row-ops">
                  <button type="button" className="pmr-icon" aria-label={`编辑属性 ${def.name}`} title="编辑名称与选项" onClick={() => openEdit(def)}>
                    <Icon name="pen-line" size={15} decorative />
                  </button>
                  <button type="button" className="pmr-del" aria-label={`删除属性 ${def.name}`} title="删除属性（两步确认 ＋ 影响清单）" onClick={() => setDeleting(def)}>
                    <Icon name="trash" size={15} decorative />
                  </button>
                </span>
              )}

              {open === def.id ? (
                <div className="pmr-panel" data-esc-claim="" onKeyDownCapture={escPanel}>
                  <div className="frow">
                    <label>名称</label>
                    <div className="ctl">
                      <input
                        className="inp"
                        autoFocus
                        aria-label={`属性名 ${def.name}`}
                        value={nameDraft}
                        onChange={(event) => { setNameDraft(event.target.value); setNameProblem(null) }}
                        onBlur={() => commitName(def)}
                        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitName(def) } }}
                      />
                      {nameProblem ? <span className="pe-problem" title={nameProblem}>{nameProblem}</span> : null}
                    </div>
                  </div>
                  <div className="frow">
                    <label>类型</label>
                    <div className="ctl"><span className="note">{PROPERTY_TYPE_META[def.type].label}（创建时定死，不可改）</span></div>
                  </div>
                  {def.type === 'select' ? (
                    <div className="frow">
                      <label>选项</label>
                      <div className="ctl pmr-opts">
                        {(def.options ?? []).map((option, optionIndex) => (
                          <div
                            key={option.id}
                            className={`pmr-opt${optionDragOver === optionIndex ? ' is-over' : ''}`}
                            onDragOver={(event) => { if (!optionDragRef.current || optionDragRef.current.optionId === option.id) return; event.preventDefault(); optionDragRef.current = { optionId: optionDragRef.current.optionId, over: optionIndex }; setOptionDragOver(optionIndex) }}
                            onDrop={(event) => { event.preventDefault(); if (optionDragRef.current) ops.onMoveOption(def.id, optionDragRef.current.optionId, optionIndex); optionDragRef.current = null; setOptionDragOver(null) }}
                          >
                            <span
                              className="pmr-grip"
                              role="button"
                              tabIndex={0}
                              draggable
                              aria-label={`拖动排序选项 ${option.label}`}
                              title="拖动排序（落数据）"
                              onDragStart={(event) => { optionDragRef.current = { optionId: option.id, over: optionIndex }; event.dataTransfer.effectAllowed = 'move' }}
                              onDragEnd={() => { optionDragRef.current = null; setOptionDragOver(null) }}
                            ><Icon name="grip" size={13} decorative /></span>
                            {optionDraft?.optionId === option.id ? (
                              <input
                                className="inp"
                                autoFocus
                                aria-label={`选项名 ${option.label}`}
                                value={optionDraft.value}
                                onChange={(event) => { setOptionDraft({ optionId: option.id, value: event.target.value }); setOptionProblem(null) }}
                                onKeyDown={(event) => {
                                  if (event.key !== 'Enter') return
                                  event.preventDefault()
                                  const label = optionDraft.value.trim()
                                  if (!label) return
                                  if (ops.onRenameOption(def.id, option.id, label)) { setOptionDraft(null); setOptionProblem(null) }
                                  else setOptionProblem(`已有同名选项「${label}」——同一属性下选项名必须唯一`)
                                }}
                              />
                            ) : (
                              <button type="button" className="pmr-optname" title="点一下改名" onClick={() => { setOptionDraft({ optionId: option.id, value: option.label }); setOptionProblem(null) }}>{option.label}</button>
                            )}
                            <span className="pmr-optuse">用在 {usage[def.id]?.options?.[option.id] ?? 0} 页</span>
                            <button type="button" className="pmr-del" aria-label={`删除选项 ${option.label}`} title="删除选项（两步确认 ＋ 影响清单）" onClick={() => setRemovingOption({ def, optionId: option.id, label: option.label })}>
                              <Icon name="x" size={13} decorative />
                            </button>
                          </div>
                        ))}
                        <div className="pmr-optadd">
                          <input
                            className="inp"
                            aria-label={`为 ${def.name} 添加选项`}
                            placeholder="＋ 添加选项"
                            value={optionNew}
                            onChange={(event) => { setOptionNew(event.target.value); setOptionProblem(null) }}
                            onKeyDown={(event) => {
                              if (event.key !== 'Enter') return
                              event.preventDefault()
                              const label = optionNew.trim()
                              if (!label) return
                              ops.onAddOption(def.id, label)
                              setOptionNew('')
                            }}
                          />
                        </div>
                        {optionProblem ? <span className="pe-problem" title={optionProblem}>{optionProblem}</span> : null}
                      </div>
                    </div>
                  ) : null}
                  <div className="frow">
                    <label>用量</label>
                    <div className="ctl"><span className="note">用在 {usage[def.id]?.pages ?? 0} 页 · 共 {usage[def.id]?.values ?? 0} 个值</span></div>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
          {filtered.length === 0 ? (
            <div className="frow"><label>属性</label><div className="ctl"><span className="note">{keyword ? `没有匹配「${query.trim()}」的属性` : '还没有自定义属性，可从下方添加。'}</span></div></div>
          ) : null}
        </div>

        {/* 添加入口与「完成」同排相邻（θ4 的维护者点名形态）；添加态就地展开在它下面。 */}
        <div className="pmr-foot">
          <button type="button" className="btn" aria-expanded={open === 'add'} onClick={() => { setOpen(open === 'add' ? null : 'add'); setAddTried(false); setNameProblem(null) }}>＋ 添加属性</button>
          {open === 'add' ? (
            /* 添加态：入口与「完成」同排相邻（θ4 的维护者点名形态）；**编辑态的完成在行尾 `✓`**。 */
            <button
              type="button"
              className="btn btn-brand"
              disabled={Boolean(addProblem) || newName.trim().length === 0}
              onClick={() => commitPanel(null)}
            >
              完成
            </button>
          ) : null}
        </div>

        {open === 'add' ? (
          <div className="pmr-panel is-add" data-esc-claim="" onKeyDownCapture={escPanel}>
            <div className="frow">
              <label>属性名称</label>
              <div className="ctl">
                <input
                  className="inp"
                  autoFocus
                  aria-label="属性名"
                  placeholder="属性名，如 状态"
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitPanel(null) } }}
                />
                {addProblem ? <span className="pe-problem" title={addProblem}>{addProblem}</span> : null}
              </div>
            </div>
            <div className="frow">
              <label>属性类型</label>
              <div className="ctl">
                {/* chips 五型（θ4 ⑤ 字形与列表行同源）；参考图的链接 / 多选 / 评分三型登记后续、不进本窗口。
                    包一层 `.pmr-chips`：窄档 `.frow .ctl` 是竖排，直接放 chips 会被拉成一行一个（真机 / 窄档实测）。 */}
                <div className="pmr-chips">
                {(['text', 'number', 'select', 'date', 'checkbox'] as PropertyDef['type'][]).map((type) => (
                  <button
                    key={type}
                    type="button"
                    className={`pmr-chip${newType === type ? ' is-on' : ''}`}
                    aria-pressed={newType === type}
                    onClick={() => setNewType(type)}
                  >
                    <TypeGlyph type={type} /><span className="pmr-chip-label">{PROPERTY_TYPE_META[type].label}</span>
                  </button>
                ))}
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {deleting ? (
        <ConfirmDialog
          title="删除属性"
          confirmLabel="删除属性"
          danger
          body={<>
            <p>「<b>{deleting.name}</b>」用在 {usage[deleting.id]?.pages ?? 0} 页 · 共 {usage[deleting.id]?.values ?? 0} 个值。</p>
            <p>删除后：全库取值一并清掉（可 ⌘Z 撤销），属性定义从属性库移除。</p>
            <p className="dlg-note">建议先到「数据与备份」导出整库。</p>
          </>}
          onConfirm={() => { onDeleteProperty(deleting.id); setDeleting(null) }}
          onClose={() => setDeleting(null)}
        />
      ) : null}

      {removingOption ? (
        <ConfirmDialog
          title="删除选项"
          confirmLabel="删除选项"
          danger
          body={<>
            <p>「<b>{removingOption.def.name}</b>」的选项「<b>{removingOption.label}</b>」用在 {usage[removingOption.def.id]?.options?.[removingOption.optionId] ?? 0} 页。</p>
            <p>删除后：引用这个选项的页面取值一并清掉（可 ⌘Z 撤销），选项从列表移除。</p>
          </>}
          onConfirm={() => { ops.onRemoveOption(removingOption.def.id, removingOption.optionId); setRemovingOption(null) }}
          onClose={() => setRemovingOption(null)}
        />
      ) : null}
    </>
  )
}
