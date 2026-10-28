import { useState, type MouseEvent } from 'react'
import { Icon, type IconName } from '@moqi/editor'
import { Popover, anchorOf, type AnchorRect } from './Popover'
import type { PropertyDef, PropertyRow, PropertyValue, TagSummary } from './types'
import { propertyNameProblem, RESERVED_PROPERTY_KEYS, type MetadataRegistry } from '@moqi/editor'

/** 毫秒 → `YYYY-MM-DD`（**本地日**；`<input type="date">` 的取值格式，与「时间」行共用）。 */
function isoDateOf(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 属性面的**行构件箱**（ 从 `Property.tsx` 拆出——体量门「按主题拆模块」）：
 * 类型元数据（`PROPERTY_TYPE_META`）、编辑回调契约（`PropertyEditorCallbacks`）、
 * 行解剖与三型行（`PropertyRows` / `CustomRow` / 默认字段行 / 标签行）、行内 ⋯（`RowMenu` / `FieldMenu`）、
 * 类型图标（`TypeGlyph`）、属性名失败文案（`propertyNameToast`）。
 * 桌面摘要条原位展开（`PropertyBrief`）与添加属性弹窗（`AddPropertyDialog`）留在 `Property.tsx`。
 */

/**
 * 五个属性类型的展示元数据（中文名 + 图标）。**单一所有者**：新建弹窗的类型分段（`R09-PADD-2`）、
 * 弹窗列表态的「＋ 添加 · …」、设置页「全局属性管理」的类型列都从这里取；
 * 图标名登记在 `docs/08` §8（属性类型批， T3）。
 * 键的书写顺序 = 类型分段的展示顺序（单选 / 文本 / 数字 / 日期 / 勾选）——加类型只改这一处。
 */
export const PROPERTY_TYPE_META: Record<PropertyDef['type'], { label: string; icon: IconName }> = {
  select: { label: '单选', icon: 'circle-dot' },
  text: { label: '文本', icon: 'type' },
  number: { label: '数字', icon: 'hash' },
  date: { label: '日期', icon: 'calendar' },
  checkbox: { label: '勾选', icon: 'check-square' },
}

/**
 * 建属性 / 改名共用的失败提示：说清是哪一种问题（空 / 保留键 / 重名），别只丢「失败了」。
 * 从外壳搬来（；它讲的是属性名这件小事，住在属性面上）。
 */
export function propertyNameToast(name: string, current: MetadataRegistry, excludeId?: string): string | null {
  const problem = propertyNameProblem(name, current, excludeId)
  if (problem === 'reserved') return `「${name.trim()}」是导出 front-matter 的保留键（${RESERVED_PROPERTY_KEYS.slice(0, 3).join(' / ')} 等），换一个名字`
  if (problem === 'taken') return `已有同名属性「${name.trim()}」——属性名是标签、但键必须唯一（导出时会写进 front-matter）`
  if (problem === 'empty') return '属性名不能为空'
  return null
}

export type PropertyEditorCallbacks = {
  onSetValue: (defId: string, value: PropertyValue | null) => void
  onAddOption: (defId: string, label: string) => void
  onRemoveProperty: (defId: string) => void
  /** 改属性名（定义级，值跟着走；判据与建属性同一套，见 `renamePropertyDef`）。**返回失败原因**（`null` = 成功）——`§0-6`：失败在**就地**说，不弹通知。 */
  onRenameProperty: (defId: string, name: string) => string | null
  /** 「时间」行的值（`§0-12`）：改的是页面的 `created`（`YYYY-MM-DD` 本地日）。 */
  onSetCreated: (value: string) => void
  onAddTag: (name: string) => void
  onRemoveTag: (tagId: string) => void
  /**
   * 「筛这一列」（`13-属性区重规划` §7.1-A3）：值 chip / 标签 chip 的**右键菜单**——把页面库筛选
   * 拨到这个属性=这个值（再点同一值 = 取消）。可选：移动端展开面板暂不接（随 F/G）。
   */
  onFilterOption?: (defId: string, optionId: string) => void
  onFilterTag?: (tagId: string) => void
}

type PropertyRowsProps = PropertyEditorCallbacks & {
  rows: PropertyRow[]
  onOpenAddProperty: (event: MouseEvent<HTMLButtonElement>) => void
  /** 标签取用选择器的数据（§5-12）：全量标签 ＋「用在 N 页」；没接就不出选择器（旧壳）。 */
  tagChoices?: TagSummary[]
  /** 面板头部标题（默认「页面属性」）。 */
  headTitle?: string
  /** 摘要展开面板带 ✕ 收起。 */
  onCollapse?: () => void
}

/** 系统字段 id。 */
const FIELD_ID = { tags: 'sys:tags', created: 'sys:created', edited: 'sys:edited' } as const

/**
 * 属性行组件（docs/09 §4.4）：桌面属性编辑只有一处形态——**摘要条原位展开**；与移动端展开面板**两处同构**，
 * 结构、分区与桌面展开态完全一致。
 * （用户裁决，按新原型）：行解剖 = [类型图标][标签窄栏][值区弹性右置]，零分隔线；
 * **管理收进行内 **⋯**（重命名 / 从本页删除），悬停或聚焦才浮出（触屏常显）；
 * 「＋ 添加属性」从头部挪到**列表末尾一行**。
 */
export function PropertyRows({
  rows, onSetValue, onAddOption, onRemoveProperty, onRenameProperty, onSetCreated, onAddTag, onRemoveTag, onOpenAddProperty, tagChoices, onFilterOption, onFilterTag, headTitle = '页面属性', onCollapse,
}: PropertyRowsProps) {
  const custom = rows.filter((row): row is Extract<PropertyRow, { kind: 'custom' }> => row.kind === 'custom')
  const system = rows.filter((row) => row.kind !== 'custom')
  /** 值/标签 chip 的右键小菜单（§A3「筛这一列」）：一个实例跟着点走。 */
  const [chipMenu, setChipMenu] = useState<{ anchor: AnchorRect; label: string; pick: () => void } | null>(null)
  const openChipMenu = (event: MouseEvent, label: string, pick: () => void) => {
    event.preventDefault()
    const anchor = anchorOf(event.currentTarget as HTMLElement)
    if (anchor) setChipMenu({ anchor, label, pick })
  }

  return (
    <>
      <div className="pe-head">
        {headTitle}
        <div className="ops">
          {onCollapse ? <button type="button" className="pe-x" aria-label="收起属性面板" title="收起" onClick={onCollapse}><Icon name="x" size={16} decorative /></button> : null}
        </div>
      </div>

      {/* 一张表、零分区（`13-属性区重规划` §0-2/§0-7「对外一律叫属性」）：默认字段与用户属性同列；
          空态不再有文案——**页面没有属性就不渲染属性面**（§0-11，由调用方保证）。 */}
      {custom.map((row) => (
        <CustomRow
          key={row.def.id}
          row={row}
          onRename={(name) => onRenameProperty(row.def.id, name)}
          onSetValue={onSetValue}
          onAddOption={onAddOption}
          onRemove={() => onRemoveProperty(row.def.id)}
          onFilterOption={onFilterOption ? (optionId) => onFilterOption(row.def.id, optionId) : undefined}
          openChipMenu={openChipMenu}
        />
      ))}

      {system.map((row) => {
        if (row.kind === 'tags') {
          return (
            <div className="pe-row" key={FIELD_ID.tags}>
              <TypeGlyph type="text" label="多值" icon="brackets" />
              <span className="pe-k">标签</span>
              <div className="pe-opts">
                {row.tags.map((tag) => (
                  <span
                    className="pe-tag"
                    key={tag.id}
                    {...(onFilterTag ? { onContextMenu: (event: MouseEvent) => openChipMenu(event, `#${tag.name}`, () => onFilterTag(tag.id)) } : {})}
                  >
                    #{tag.name}
                    <button type="button" className="x" aria-label={`移除标签 ${tag.name}`} onClick={() => onRemoveTag(tag.id)}><Icon name="x" size={11} decorative /></button>
                  </span>
                ))}
                <TagPicker choices={tagChoices ?? []} active={row.tags.map((tag) => tag.id)} onAdd={onAddTag} onRemove={onRemoveTag} />
              </div>
              <FieldMenu label="标签" onRemove={() => onRemoveProperty(FIELD_ID.tags)} />
            </div>
          )
        }
        if (row.kind === 'time') {
          // **「时间」一行**（`§0-12` 已裁）：值 = 页面创建时间、**用户可改**（`modified` 系统维护、不进面板）；
          // ⋯ 与标签行同构（从本页删除），不再有"单条菜单"。
          return (
            <div className="pe-row" key={FIELD_ID.created}>
              <TypeGlyph type="date" label="日期" />
              <span className="pe-k">时间</span>
              <div className="pe-opts">
                <input
                  className="pe-input"
                  type="date"
                  aria-label="时间"
                  title="页面时间：默认为建这一页的那天，可以改"
                  value={isoDateOf(row.timestamp)}
                  onChange={(event) => { if (event.target.value) onSetCreated(event.target.value) }}
                />
              </div>
              <FieldMenu label="时间" onRemove={() => onRemoveProperty(FIELD_ID.created)} />
            </div>
          )
        }
        return null
      })}

      <button type="button" className="pe-addrow" onClick={onOpenAddProperty}>
        <Icon name="plus" size={16} decorative /> 添加属性
      </button>
      {chipMenu ? (
        <Popover anchor={chipMenu.anchor} align="right" width={208} label={`筛 ${chipMenu.label}`} onClose={() => setChipMenu(null)}>
          <button type="button" onClick={() => { const pick = chipMenu.pick; setChipMenu(null); pick() }}>
            <span className="mi"><Icon name="filter" size={16} decorative /></span>
            <span>筛「{chipMenu.label}」</span>
            <span className="d">在页面库看同值页面</span>
          </button>
        </Popover>
      ) : null}
    </>
  )
}

/** 类型图标（类型自解释；title 里给中文类型名）。导出给 `Property.tsx` 的添加弹窗列表行用。 */
export function TypeGlyph({ type, label, icon }: { type?: PropertyDef['type']; label?: string; icon?: IconName }) {
  const meta = type ? PROPERTY_TYPE_META[type] : null
  return (
    <span className="pe-type" title={`类型：${label ?? meta?.label ?? ''}`}>
      <Icon name={icon ?? meta?.icon ?? 'properties'} size={16} decorative />
    </span>
  )
}

type MenuItem = { key: string; icon: IconName; text: string; meta?: string; title?: string; danger?: boolean; onPick: () => void }

/** 行内 ⋯：管理入口不再占常驻按钮位（ 新设计）。悬停 / 聚焦浮出，触屏常显（`pointer:coarse`）。 */
function RowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [anchor, setAnchor] = useState<AnchorRect | null>(null)
  return (
    <>
      <button
        type="button"
        className="pe-more"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-label={`${label} 的属性操作`}
        title="属性操作"
        onClick={(event) => setAnchor(anchor ? null : anchorOf(event.currentTarget))}
      >
        <Icon name="more" size={16} decorative />
      </button>
      {anchor ? (
        <Popover anchor={anchor} align="right" width={192} label={`${label} 的属性操作`} onClose={() => setAnchor(null)}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              className={item.danger ? 'is-danger' : ''}
              title={item.title}
              onClick={() => { setAnchor(null); item.onPick() }}
            >
              <span className="mi"><Icon name={item.icon} size={16} decorative /></span>
              <span>{item.text}</span>
              {item.meta ? <span className="d">{item.meta}</span> : null}
            </button>
          ))}
        </Popover>
      ) : null}
    </>
  )
}

/** 默认字段的 ⋯：**从本页删除**（`§0-10`：本页不再显示、数据不动；重命名对默认字段不适用）。 */
function FieldMenu({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <RowMenu
      label={label}
      items={[{
        key: 'remove',
        icon: 'trash',
        text: '从本页删除',
        danger: true,
        title: '本页不再显示这一行（数据不动，可随时用「添加属性」加回来）',
        onPick: onRemove,
      }]}
    />
  )
}

/**
 * 标签取用选择器（`13-属性区重规划` §5-12， 已裁）：搜索 / 创建 + **全量**标签
 * （各自「用在 N 页」）；点一条 = 本页加上、已在本页的再点 = 去掉，**多选不关窗**；
 * 输入即建走 `ensureTagDef`（按名复用同一定义，不产生同名两份）。
 */
function TagPicker({ choices, active, onAdd, onRemove }: { choices: TagSummary[]; active: string[]; onAdd: (name: string) => void; onRemove: (tagId: string) => void }) {
  const [anchor, setAnchor] = useState<AnchorRect | null>(null)
  const [query, setQuery] = useState('')
  const keyword = query.trim().toLocaleLowerCase()
  const shown = choices.filter((choice) => keyword.length === 0 || choice.name.toLocaleLowerCase().includes(keyword))
  const creatable = query.trim().length > 0 && !choices.some((choice) => choice.name === query.trim())
  const close = () => { setAnchor(null); setQuery('') }
  return (
    <>
      <button
        type="button"
        className="pe-tagadd"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-label="添加标签"
        onClick={(event) => setAnchor(anchor ? null : anchorOf(event.currentTarget))}
      >
        ＋ 添加标签
      </button>
      {anchor ? (
        <Popover anchor={anchor} align="left" width={248} label="添加标签" onClose={close}>
          <div className="tp-search">
            <Icon name="search" size={14} decorative />
            <input
              className="tp-search-inp"
              autoFocus
              aria-label="搜索标签"
              placeholder="搜索标签"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {creatable ? (
            <button type="button" onClick={() => { onAdd(query.trim()); setQuery('') }}>
              <span className="mi"><Icon name="plus" size={16} decorative /></span>
              <span>创建「{query.trim()}」</span>
            </button>
          ) : null}
          {shown.map((choice) => {
            const on = active.includes(choice.id)
            return (
              <button key={choice.id} type="button" className={on ? 'is-on' : ''} aria-pressed={on} onClick={() => (on ? onRemove(choice.id) : onAdd(choice.name))}>
                <span>{choice.name}</span>
                <span className="d">用在 {choice.count} 页</span>
              </button>
            )
          })}
        </Popover>
      ) : null}
    </>
  )
}

function CustomRow({ row, onRename, onSetValue, onAddOption, onRemove, onFilterOption, openChipMenu }: {
  row: Extract<PropertyRow, { kind: 'custom' }>
  /** 改名：**返回失败原因**（`null` = 成功）——调用方就地显示（`§0-6`）。 */
  onRename: (name: string) => string | null
  onSetValue: (defId: string, value: PropertyValue | null) => void
  onAddOption: (defId: string, label: string) => void
  onRemove: () => void
  /** 「筛这一列」（§A3）：右键值 chip → 把页面库拨到这个值；没接回调就不出菜单。 */
  onFilterOption?: (optionId: string) => void
  openChipMenu: (event: MouseEvent, label: string, pick: () => void) => void
}) {
  const { def, value } = row
  const [optionDraft, setOptionDraft] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  /** 改名的失败原因（`§0-6`：就地一句，不弹通知）；行内输入旁显示，改对或取消即清。 */
  const [renameProblem, setRenameProblem] = useState<string | null>(null)

  const commitRename = () => {
    const next = (renaming ?? '').trim()
    if (next.length === 0 || next === def.name) { setRenaming(null); setRenameProblem(null); return }
    const problem = onRename(next)
    if (problem) { setRenameProblem(problem); return }
    setRenaming(null)
    setRenameProblem(null)
  }

  return (
    <div className="pe-row">
      <TypeGlyph type={def.type} />
      {renaming !== null ? (
        <input
          className="pe-input pe-rename"
          autoFocus
          aria-label={`重命名 ${def.name}`}
          value={renaming}
          onChange={(event) => { setRenaming(event.target.value); setRenameProblem(null) }}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === 'Escape') { event.preventDefault(); setRenaming(null); setRenameProblem(null); return }
            if (event.key === 'Enter') { event.preventDefault(); commitRename() }
          }}
        />
      ) : (
        <span className="pe-k" title={def.name}>{def.name}</span>
      )}
      {renameProblem ? (
        /* 就地一句（`§0-6`）：失败在行内说，不弹通知；改对 / 取消即消失。 */
        <span className="pe-problem" title={renameProblem}>{renameProblem}</span>
      ) : null}
      <div className="pe-opts">
        {def.type === 'select' ? (
          <>
            {(def.options ?? []).map((option) => {
              const on = value?.type === 'select' && value.optionId === option.id
              return (
                <button
                  key={option.id}
                  type="button"
                  className={`pe-opt ${on ? 'is-on' : ''}`}
                  aria-pressed={on}
                  onClick={() => onSetValue(def.id, on ? null : { defId: def.id, type: 'select', optionId: option.id })}
                  {...(onFilterOption ? { onContextMenu: (event: MouseEvent) => openChipMenu(event, option.label, () => onFilterOption(option.id)) } : {})}
                >
                  {option.label}
                </button>
              )
            })}
            <input
              className="pe-input"
              style={{ minWidth: 88, width: 100 }}
              value={optionDraft}
              placeholder="＋ 添加取值"
              aria-label={`为 ${def.name} 添加取值`}
              onChange={(event) => setOptionDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                const label = optionDraft.trim()
                if (!label) return
                onAddOption(def.id, label)
                setOptionDraft('')
              }}
            />
          </>
        ) : def.type === 'checkbox' ? (
          <button
            type="button"
            className={`pe-opt ${value?.type === 'checkbox' && value.value ? 'is-on' : ''}`}
            aria-pressed={value?.type === 'checkbox' && value.value}
            onClick={() => onSetValue(def.id, { defId: def.id, type: 'checkbox', value: !(value?.type === 'checkbox' && value.value) })}
          >
            {value?.type === 'checkbox' && value.value ? '已勾选' : '未勾选'}
          </button>
        ) : (
          <input
            className="pe-input"
            type={def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text'}
            aria-label={def.name}
            /* 空值显式「未设置」（灰字占位，不是空输入框——§3.3）；date 型浏览器不给占位，落成原生掩码。 */
            placeholder={value ? undefined : '未设置'}
            value={def.type === 'number' && value?.type === 'number' ? String(value.value) : value && 'value' in value ? String(value.value) : ''}
            onChange={(event) => {
              const raw = event.target.value
              if (raw === '') { onSetValue(def.id, null); return }
              if (def.type === 'number') {
                const parsed = Number(raw)
                onSetValue(def.id, Number.isFinite(parsed) ? { defId: def.id, type: 'number', value: parsed } : null)
                return
              }
              if (def.type === 'date') { onSetValue(def.id, { defId: def.id, type: 'date', value: raw }); return }
              onSetValue(def.id, { defId: def.id, type: 'text', value: raw })
            }}
          />
        )}
        {/* `def.disabled` 只作历史数据兼容（`§0-4` 停用已取消）——**界面不再出现「已停用」字样**。 */}
      </div>
      <RowMenu
        label={def.name}
        items={[
          { key: 'rename', icon: 'type', text: '重命名', title: '改属性名（页面上的取值跟着走，是同一个属性）', onPick: () => setRenaming(def.name) },
          { key: 'remove', icon: 'trash', text: '从本页删除', danger: true, title: '本页不再显示这一行（**值保留**——要清值就把值清空；可随时用「添加属性」加回来）', onPick: onRemove },
        ]}
      />
    </div>
  )
}
