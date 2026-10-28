import { useState, type MouseEvent } from 'react'
import { Icon } from '@moqi/editor'
import { Dialog } from './Dialogs'
import { Popover, anchorOf, type AnchorRect } from './Popover'
import type { PropertyDef, PropertyRow, TagSummary } from './types'
import { DEFAULT_FIELD, DEFAULT_FIELDS, propertyNameProblem } from '@moqi/editor'
import { PROPERTY_TYPE_META, PropertyRows, TypeGlyph, type PropertyEditorCallbacks } from './PropertyRows'

/**
 * 属性摘要钉住条（`PropertyBrief`）与添加属性弹窗（`AddPropertyDialog`）。
 * 行构件箱（行解剖 / 行内 ⋯ / 类型元数据 / 属性名反馈）拆在 `PropertyRows.tsx`（2026-10-10，体量门）。
 */

type PropertyBriefProps = PropertyEditorCallbacks & {
  rows: PropertyRow[]
  open: boolean
  onToggle: () => void
  onOpenAddProperty: (event: MouseEvent<HTMLButtonElement>) => void
  /** 标签取用选择器的数据（§5-12）：全量标签 ＋「用在 N 页」。 */
  tagChoices?: TagSummary[]
}

/**
 * 属性摘要条（docs/09 §4.3）：格式栏下方钉住、不随正文滚动；点击原位展开编辑面板，
 * 展开时摘要行隐藏，面板限高内部滚动。
 */
export function PropertyBrief({ rows, open, onToggle, onOpenAddProperty, tagChoices, ...callbacks }: PropertyBriefProps) {
  if (open) {
    return (
      <div className="prop-wrap">
        <div className="prop-edit">
          {/* 与正文列**同一条轴**（`--colw` 居中，两侧留 `.doc-col` 那份内边距——§3.3 的同宽对齐）。 */}
          <div className="prop-inner">
            <PropertyRows rows={rows} tagChoices={tagChoices} onOpenAddProperty={onOpenAddProperty} onCollapse={onToggle} {...callbacks} />
            <button type="button" className="pe-collapse" onClick={onToggle}>收起</button>
          </div>
        </div>
      </div>
    )
  }

  const summary: string[] = []
  for (const row of rows) {
    if (row.kind === 'custom') {
      const label = valueLabel(row)
      if (label) summary.push(`${row.def.name}: ${label}`)
    } else if (row.kind === 'tags' && row.tags.length > 0) {
      summary.push(row.tags.map((tag) => `#${tag.name}`).join('  '))
    }
  }

  return (
    <div className="prop-wrap">
      <button type="button" className="prop-brief" onClick={onToggle} aria-expanded={false} title="点击展开属性编辑">
        {/* 与正文列同一条轴（§3.3）：chevron 落在**正文列右缘**，不再贴编辑栏边缘。 */}
        <span className="prop-inner">
          {summary.map((item, index) => (
            <span key={item}>
              {index > 0 ? <i>·</i> : null}
              <span className="kv">{item.includes(': ') ? <>{item.slice(0, item.indexOf(': ') + 1)} <b>{item.slice(item.indexOf(': ') + 2)}</b></> : item}</span>
            </span>
          ))}
          <span className="pb-arrow"><Icon name="chevron-down" size={13} decorative /></span>
        </span>
      </button>
    </div>
  )
}

function valueLabel(row: Extract<PropertyRow, { kind: 'custom' }>): string {
  const { def, value } = row
  if (!value) return ''
  if (value.type === 'select') return def.options?.find((option) => option.id === value.optionId)?.label ?? ''
  if (value.type === 'checkbox') return value.value ? '已勾选' : ''
  if (value.type === 'date') return value.value
  return String(value.value)
}

type AddPropertyDialogProps = {
  defs: PropertyDef[]
  /** 当前页面已挂载的属性定义 id。 */
  mounted: string[]
  /** 最近挂过的属性定义 id（最新在前；`uiPrefs.recentProperties`）。 */
  recentIds: string[]
  onAdd: (defId: string) => void
  onCreate: (name: string, type: PropertyDef['type']) => void
  onOpenSettings: () => void
  onClose: () => void
}

/**
 * 添加属性弹窗（docs/09 §4.4.1，2026-10-09 轻结构）：顶部搜索 →「最近使用」→「全部属性」
 * （**点了即加即关**）；新建收成**底部一行式**（名字 + 类型 chip + 建并添加）；⚙ 角落入口去设置页。
 */
export function AddPropertyDialog({ defs, mounted, recentIds, onAdd, onCreate, onOpenSettings, onClose }: AddPropertyDialogProps) {
  const [query, setQuery] = useState('')
  const [name, setName] = useState('')
  const [type, setType] = useState<PropertyDef['type']>('select')
  const [typeAnchor, setTypeAnchor] = useState<AnchorRect | null>(null)

  const keyword = query.trim().toLocaleLowerCase()
  const matches = (def: PropertyDef) => keyword.length === 0 || def.name.toLocaleLowerCase().includes(keyword)
  const recent = recentIds
    .map((id) => defs.find((def) => def.id === id))
    .filter((def): def is PropertyDef => Boolean(def))
    .filter(matches)
  const all = defs.filter(matches)
  // 校验前移（§3.5）：重名 / 保留键在输入行**就地**给最短一句；有问题时「建并添加」点不动。
  const nameProblem = name.trim().length === 0 ? null : propertyNameProblem(name, { properties: defs, tags: [] })
  const problemText = nameProblem === 'taken' ? '已有同名属性' : nameProblem === 'reserved' ? '保留键，换一个名字' : null

  const submit = () => {
    const value = name.trim()
    if (!value || problemText !== null) return
    onCreate(value, type)
    setName('')
    // 建完即关（与列表行「点了即加即关」同一口径）；重名等失败由 toast 说明，属性面板里保持不变。
    onClose()
  }

  // 添加**不做限制**（`§0-3`）：已添加的仍可点（幂等），只作提示——不再是被禁用的灰态行；
  // 「停用」随 §0-4 消失（状态收敛为 在用 / 已删除）。
  const rowOf = (def: PropertyDef) => {
    const added = mounted.includes(def.id)
    return (
      <button
        key={def.id}
        type="button"
        className="ap-row"
        onClick={() => onAdd(def.id)}
        title={added ? '当前页面已添加' : '添加到当前页面'}
      >
        <TypeGlyph type={def.type} />
        <span className="t">{def.name}</span>
        <span className="tp">
          {PROPERTY_TYPE_META[def.type].label}
          {def.options && def.options.length > 0 ? ` · ${def.options.map((option) => option.label).join(' / ')}` : ''}
        </span>
        <span className="ap-done">{added ? '已添加' : ''}</span>
      </button>
    )
  }

  // **默认字段**（标签 / 创建时间 / 编辑时间）与用户属性同列一张表、零分类名（`§0-7`）；
  // 它们默认不在任何页面上，靠这一列「添加」出现（`§0-1`）。
  const defaultRow = (id: string, label: string, hint: string) => {
    const added = mounted.includes(id)
    return (
      <button
        key={id}
        type="button"
        className="ap-row"
        onClick={() => onAdd(id)}
        title={added ? '当前页面已添加' : '添加到当前页面'}
      >
        <TypeGlyph icon={id === DEFAULT_FIELD.tags ? 'brackets' : 'calendar'} label={hint} />
        <span className="t">{label}</span>
        <span className="tp">{hint}</span>
        <span className="ap-done">{added ? '已添加' : ''}</span>
      </button>
    )
  }
  const defaultEntries = DEFAULT_FIELDS.filter((field) => keyword.length === 0 || field.name.toLocaleLowerCase().includes(keyword))

  return (
    <Dialog
      title="添加属性"
      small
      onClose={onClose}
      footer={<button type="button" className="btn-plain" onClick={onClose}>完成</button>}
    >
      <div className="dlg-b">
        <div className="ap-search">
          <Icon name="search" size={16} decorative />
          <input
            className="ap-search-inp"
            aria-label="搜索属性"
            placeholder="搜索属性"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {recent.length > 0 ? (
          <>
            <div className="ap-cap">最近使用</div>
            {recent.map(rowOf)}
          </>
        ) : null}
        <div className="ap-cap">全部属性</div>
        {defaultEntries.length === 0 && all.length === 0 ? (
          <p className="rp-empty">没有匹配的属性</p>
        ) : null}
        {defaultEntries.map((field) => defaultRow(field.id, field.name, field.id === DEFAULT_FIELD.tags ? '多值' : '日期'))}
        {all.map(rowOf)}
        <div className="ap-newline">
          <input
            id="add-prop-name"
            className="inp"
            value={name}
            placeholder="新建属性名，如 状态"
            aria-label="新建属性名"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit() } }}
          />
          <button
            type="button"
            className="tp-chip"
            aria-haspopup="menu"
            aria-expanded={typeAnchor !== null}
            aria-label={`新属性类型：${PROPERTY_TYPE_META[type].label}`}
            title="选择新属性的类型"
            onClick={(event) => setTypeAnchor(typeAnchor ? null : anchorOf(event.currentTarget))}
          >
            <Icon name={PROPERTY_TYPE_META[type].icon} size={16} decorative />
            {PROPERTY_TYPE_META[type].label}
          </button>
          {typeAnchor ? (
            <Popover anchor={typeAnchor} align="right" width={160} label="属性类型" onClose={() => setTypeAnchor(null)}>
              {(Object.keys(PROPERTY_TYPE_META) as PropertyDef['type'][]).map((option) => (
                <button
                  key={option}
                  type="button"
                  className={type === option ? 'is-on' : ''}
                  onClick={() => { setTypeAnchor(null); setType(option) }}
                >
                  <span className="mi"><Icon name={PROPERTY_TYPE_META[option].icon} size={16} decorative /></span>
                  <span>{PROPERTY_TYPE_META[option].label}</span>
                </button>
              ))}
            </Popover>
          ) : null}
          <button type="button" className="go" disabled={name.trim().length === 0 || problemText !== null} onClick={submit}>建并添加</button>
        </div>
        {problemText ? <div className="ap-problem">{problemText}</div> : null}
        <button type="button" className="ap-goset" onClick={onOpenSettings}>
          <Icon name="settings" size={16} decorative /> 属性库
        </button>
      </div>
    </Dialog>
  )
}
