import type { Block, MetadataRegistry, PropertyDef, PropertyOption, PropertyType, PropertyValue, TagDef } from './block'

export type { MetadataRegistry, PropertyDef, PropertyOption, PropertyType, PropertyValue, TagDef } from './block'

export function emptyRegistry(): MetadataRegistry {
  return { properties: [], tags: [] }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/

export function isIsoDate(value: string): boolean {
  return ISO_DATE.test(value) && !Number.isNaN(Date.parse(value))
}

/**
 * T15: turns a raw panel input into a typed value. `null` means "clear/unset",
 * which is distinct from a `checkbox` false that stays present in the list.
 */
export function coercePropertyValue(def: PropertyDef, raw: unknown): PropertyValue | null {
  if (raw === undefined || raw === null) return null
  switch (def.type) {
    case 'checkbox':
      if (typeof raw === 'boolean') return { defId: def.id, type: 'checkbox', value: raw }
      return null
    case 'number': {
      const value = typeof raw === 'number' ? raw : Number(String(raw).trim())
      if (!Number.isFinite(value) || String(raw).trim() === '') return null
      return { defId: def.id, type: 'number', value }
    }
    case 'date': {
      const value = String(raw).trim()
      if (!isIsoDate(value)) return null
      return { defId: def.id, type: 'date', value }
    }
    case 'select': {
      const optionId = String(raw).trim()
      if (!def.options?.some((option) => option.id === optionId)) return null
      return { defId: def.id, type: 'select', optionId }
    }
    case 'text': {
      const value = String(raw)
      if (value.length === 0) return null
      return { defId: def.id, type: 'text', value }
    }
  }
}

export function propertyEquals(left: PropertyValue, right: PropertyValue): boolean {
  if (left.defId !== right.defId || left.type !== right.type) return false
  if (left.type === 'select' && right.type === 'select') return left.optionId === right.optionId
  if (left.type === 'number' && right.type === 'number') return left.value === right.value
  if (left.type === 'checkbox' && right.type === 'checkbox') return left.value === right.value
  if (left.type === 'date' && right.type === 'date') return left.value === right.value
  if (left.type === 'text' && right.type === 'text') return left.value === right.value
  return false
}

/** Returns the updated list, or `null` when the change is a no-op. */
export function applyPropertyValue(properties: PropertyValue[], value: PropertyValue | null, defId: string): PropertyValue[] | null {
  const without = properties.filter((item) => item.defId !== defId)
  const next = value ? [...without, value] : without
  const before = properties
  const unchanged = next.length === before.length && next.every((item) => {
    const previous = before.find((entry) => entry.defId === item.defId)
    return previous ? propertyEquals(item, previous) : false
  })
  return unchanged ? null : next
}

export function getPropertyValue(properties: PropertyValue[], defId: string): PropertyValue | undefined {
  return properties.find((item) => item.defId === defId)
}

/** A value is "set" when an entry exists; `checkbox false` counts as set. */
export function isPropertySet(properties: PropertyValue[], defId: string): boolean {
  return properties.some((item) => item.defId === defId)
}

export function resolvePropertyText(def: PropertyDef, value: PropertyValue | undefined, registry: MetadataRegistry): string {
  if (!value) return ''
  switch (value.type) {
    case 'checkbox': return value.value ? '已完成' : '未完成'
    case 'select': return registry.properties.find((item) => item.id === def.id)?.options?.find((option) => option.id === value.optionId)?.label ?? value.optionId
    case 'number': return String(value.value)
    case 'date':
    case 'text': return value.value
  }
}

export function resolveTagName(tagId: string, registry: MetadataRegistry): string {
  return registry.tags.find((tag) => tag.id === tagId)?.name ?? tagId
}

/**
 * **默认字段**（内部术语；界面一律只出现「属性」，不出现分类名——`13-属性区重规划` §0-7）。
 * 标签 / 时间的数据住在 Block 自身（`tags` / `created`），**不在 registry**；
 * 这里只给一套稳定 id 与对外显示名，供「添加属性」列表与面板行共用（图标映射在 UI 侧）。
 * 星标**不在其列**（§0-8 已裁：归「更多」菜单，不进属性面）。
 *
 * **「时间」是一行**（§0-12 已裁）：对外叫「时间」、值 = `created`（**用户可改**）；
 * `modified` 由系统维护、不进面板。行 id 沿用 `sys:created`——存量页面的 `propertyShown/hidden`
 * 里的它照旧生效；`sys:edited` 只作**历史数据兼容**（旧集合里可能还留着，不再渲染、不必清）。
 */
export const DEFAULT_FIELD = { tags: 'sys:tags', created: 'sys:created', edited: 'sys:edited' } as const

export const DEFAULT_FIELDS: { id: string; name: string }[] = [
  { id: DEFAULT_FIELD.tags, name: '标签' },
  { id: DEFAULT_FIELD.created, name: '时间' },
]

export function isDefaultField(id: string): boolean {
  return DEFAULT_FIELDS.some((field) => field.id === id)
}

/**
 * 属性面板里一行**该不该显示**——`13-属性区重规划` 的四条裁决收成一句
 * （§0-1/§0-2 默认属性要加才出现 · §0-3 添加不设限 · §0-10「从本页删除」= 不显示、值保留）：
 *
 * **`(键 ∈ propertyShown ∨ 有值) ∧ 键 ∉ propertyHidden`**
 *
 * - 默认字段：缺省不在 `shown` ⇒ 不显示；「添加属性 → 默认属性」入 `shown` ⇒ 显示（§0-9 的标签直落同走这条）。
 * - 用户属性：有值就显示（现有行为，零迁移）；「从本页删除」入 `hidden` ⇒ 不再显示而**值还在**；
 *   再加回来 = 出列（有值时立刻回来，无值则显示「未设置」行）。
 */
export function propertyRowVisible(input: { id: string; hasValue: boolean; shown: string[]; hidden: string[] }): boolean {
  if (input.hidden.includes(input.id)) return false
  return input.shown.includes(input.id) || input.hasValue
}

/**
 * 属性的**用量读数**（`13-属性区重规划` §3.6「用在 N 页」/ §3.2 删除影响清单）：每个定义一份
 * `{ pages, values }`——`values` = 全库未删除页面里的值条目数（`checkbox false` 算一条）；
 * `pages` = 有值条目、或只在 `propertyShown` 里挂着的页面数（口径与面板行出现规则同源，§0-1）。
 */
export function propertyUsages(blocks: Iterable<Block>, defs: PropertyDef[]): Record<string, { pages: number; values: number; options: Record<string, number> }> {
  const usage: Record<string, { pages: number; values: number; options: Record<string, number> }> = {}
  const known = new Set<string>()
  for (const def of defs) {
    usage[def.id] = { pages: 0, values: 0, options: {} }
    known.add(def.id)
  }
  for (const block of blocks) {
    if (block.deleted) continue
    const seen = new Set<string>()
    for (const value of block.properties) {
      if (!known.has(value.defId)) continue
      usage[value.defId].values += 1
      /* 每个选项的用量（θ4：删选项的影响清单「用在 N 页」）——按 `optionId` 计，与值的挂法同源。 */
      if (value.type === 'select') usage[value.defId].options[value.optionId] = (usage[value.defId].options[value.optionId] ?? 0) + 1
      seen.add(value.defId)
    }
    for (const key of block.propertyShown ?? []) if (known.has(key)) seen.add(key)
    for (const key of seen) usage[key].pages += 1
  }
  return usage
}

/** Adds a tag by name, reusing an existing definition; returns the TagDef id. */
export function ensureTagDef(name: string, registry: MetadataRegistry, now = Date.now()): { id: string; registry: MetadataRegistry } {
  const trimmed = name.trim()
  const existing = registry.tags.find((tag) => tag.name === trimmed)
  if (existing) return { id: existing.id, registry }
  const tag: TagDef = { id: crypto.randomUUID(), name: trimmed, created: now, modified: now }
  return { id: tag.id, registry: { ...registry, tags: [...registry.tags, tag] } }
}

/**
 * front-matter 的**保留键**（导出时不能与它们撞名）：13-导出与媒体设计（已归档） §5「键唯一」——
 * 前三个是我们自己写的（标签 / 时间戳），后五个是 Obsidian 的默认属性名与旧默认名（它认得它们）。
 * 这里是**唯一所有者**：属性管理（建 / 改名）与导出器都引用这一份。
 */
export const RESERVED_PROPERTY_KEYS = ['tags', 'created', 'modified', 'aliases', 'cssclasses', 'tag', 'alias', 'cssclass'] as const

export type PropertyNameProblem = 'empty' | 'reserved' | 'taken'

/**
 * 属性名能不能用（**建与改名共用同一套判据**；`excludeId` 供改名排除自己）：
 * 空 → `empty`；与保留键同名（忽略大小写）→ `reserved`；与别的定义同名（忽略首尾空白与大小写）→ `taken`。
 * 返回 `null` = 可以用。界面拿它说清原因，域层动作拿它挡动作——判据只有这一份。
 */
export function propertyNameProblem(name: string, registry: MetadataRegistry, excludeId?: string): PropertyNameProblem | null {
  const trimmed = name.trim()
  if (!trimmed) return 'empty'
  const lower = trimmed.toLocaleLowerCase()
  if ((RESERVED_PROPERTY_KEYS as readonly string[]).some((key) => key.toLocaleLowerCase() === lower)) return 'reserved'
  const taken = registry.properties.some((def) => def.id !== excludeId && def.name.trim().toLocaleLowerCase() === lower)
  return taken ? 'taken' : null
}

/**
 * 建属性定义（属性名唯一，2026-10-06）：名字是标签、**键必须唯一**——同名定义会让导出物出现
 * 重复的 front-matter 键（YAML 非法、Obsidian 也明说同一篇不许属性重名），所以闸门放在这里：
 * 空 / 保留键 / 重名（忽略首尾空白与大小写）一律返回 `null`，界面据此说清原因并不创建。
 * 属性**类型**同样在这一刻定死——`registry.properties` 的写入路径只有「建 / 改名 / 停用 / 加选项」，
 * 导出侧的「类型 → 语法」映射因此是一次定死的契约（13-导出与媒体设计（已归档） §5）。
 */
export function createPropertyDef(name: string, type: PropertyDef['type'], registry: MetadataRegistry, now = Date.now()): { def: PropertyDef; registry: MetadataRegistry } | null {
  if (propertyNameProblem(name, registry) !== null) return null
  const def: PropertyDef = {
    id: crypto.randomUUID(),
    name: name.trim(),
    type,
    options: type === 'select' ? [] : undefined,
    created: now,
    modified: now,
  }
  return { def, registry: { ...registry, properties: [...registry.properties, def] } }
}

/**
 * 改属性名（2026-10-06）：**与建属性共用同一套判据**（`propertyNameProblem`）——名字是标签，但键必须唯一。
 * 值不动：页面上的取值按 `defId` 挂，改名只影响导出时写出的键名与新编辑（`PropertyValue.defId` 不变）。
 * 类型不可改（那条是契约）；改成自己的名字 = 无操作（返回 `null`，界面不必提示）。
 */
export function renamePropertyDef(defId: string, name: string, registry: MetadataRegistry, now = Date.now()): MetadataRegistry | null {
  const target = registry.properties.find((def) => def.id === defId)
  if (!target) return null
  const trimmed = name.trim()
  if (trimmed === target.name) return null
  if (propertyNameProblem(trimmed, registry, defId) !== null) return null
  return {
    ...registry,
    properties: registry.properties.map((def) => (def.id === defId ? { ...def, name: trimmed, modified: now } : def)),
  }
}

/**
 * 删属性定义（`13-属性区重规划` §3.2 删除第 ② 步；**仅用户建的**——默认字段不在 registry，天然不可删，§0-2）。
 * 页面上的取值与显示集合由调用方先清（第 ① 步＝一块块级事务、可 ⌘Z 撤销）；这里只动注册表。
 */
export function deletePropertyDef(defId: string, registry: MetadataRegistry): MetadataRegistry | null {
  if (!registry.properties.some((def) => def.id === defId)) return null
  return { ...registry, properties: registry.properties.filter((def) => def.id !== defId) }
}

/**
 * **导入时**按 front-matter 的写法反解属性类型（2026-10-10「Obsidian 互通」批）：
 * 导出侧的类型矩阵（13-导出与媒体设计（已归档） §5）是**一次定死的契约**，反解就照同一张表读：
 * `checkbox` 裸 `true`/`false`、`number` 裸数字、`date` 裸 `YYYY-MM-DD`、其余（含**引号化**的值）
 * 都是 `text`——导出侧对 `text` 一律引号化，所以「有引号 = 文本」这条判据不会有歧义
 * （否则 `"5"` 会被猜成数字，类型在往返里漂移）。
 *
 * `select` **猜不出来**（值是显示名，和文本同形）：库里已有定义时按定义走（调用方按名对定义），
 * 只有「库里没有这个键」时才落到这里——那时按文本建一个定义，值仍逐字保住。
 */
export function inferPropertyType(raw: string, quoted = false): PropertyType {
  if (quoted) return 'text'
  const value = raw.trim()
  if (value === 'true' || value === 'false') return 'checkbox'
  if (value.length > 0 && Number.isFinite(Number(value))) return 'number'
  if (isIsoDate(value) && /^\d{4}-\d{2}-\d{2}$/.test(value)) return 'date'
  return 'text'
}

/** T15/§4.4: disabling keeps the def and its historical values readable but frozen. */export function disablePropertyDef(defId: string, registry: MetadataRegistry, now = Date.now()): MetadataRegistry | null {
  const target = registry.properties.find((def) => def.id === defId)
  if (!target || target.disabled) return null
  return {
    ...registry,
    properties: registry.properties.map((def) => (def.id === defId ? { ...def, disabled: true, modified: now } : def)),
  }
}

/** Adds a select option by label, reusing an existing label; returns the option id. */
export function addPropertyOption(
  defId: string,
  label: string,
  registry: MetadataRegistry,
  now = Date.now(),
): { optionId: string; registry: MetadataRegistry } | null {
  const target = registry.properties.find((def) => def.id === defId)
  if (!target || target.type !== 'select' || target.disabled) return null
  const trimmed = label.trim()
  if (!trimmed) return null
  const existing = target.options?.find((option) => option.label === trimmed)
  if (existing) return { optionId: existing.id, registry }
  const option: PropertyOption = { id: crypto.randomUUID(), label: trimmed }
  return {
    optionId: option.id,
    registry: {
      ...registry,
      properties: registry.properties.map((def) =>
        def.id === defId ? { ...def, options: [...(def.options ?? []), option], modified: now } : def,
      ),
    },
  }
}

/**
 * 选项：**改名**（θ4 · `R09-SET-5b`）：**值不动**——页面上的取值按 `optionId` 挂，改名只换显示名与导出文字。
 * 与 `addPropertyOption` 同一条守卫：**label 唯一**——改成已有别的选项的名字 = 挡下（返回 `null`，界面就地一句）。
 */
export function renamePropertyOption(defId: string, optionId: string, label: string, registry: MetadataRegistry, now = Date.now()): MetadataRegistry | null {
  const target = registry.properties.find((def) => def.id === defId)
  const options = target?.options ?? []
  const trimmed = label.trim()
  if (!target || !trimmed) return null
  if (!options.some((option) => option.id === optionId)) return null
  if (options.some((option) => option.id !== optionId && option.label === trimmed)) return null
  return {
    ...registry,
    properties: registry.properties.map((def) =>
      def.id === defId
        ? { ...def, options: (def.options ?? []).map((option) => (option.id === optionId ? { ...option, label: trimmed } : option)), modified: now }
        : def,
    ),
  }
}

/**
 * 选项：**删除**（θ4）：只动注册表——页面上的取值由调用方**先清**（同 `deletePropertyDef` 的体例：
 * 那一步是一块块级事务、可 ⌘Z 撤销；这里不做"值怎么办"的判断）。
 */
export function removePropertyOption(defId: string, optionId: string, registry: MetadataRegistry): MetadataRegistry | null {
  const target = registry.properties.find((def) => def.id === defId)
  if (!target || !(target.options ?? []).some((option) => option.id === optionId)) return null
  return {
    ...registry,
    properties: registry.properties.map((def) =>
      def.id === defId ? { ...def, options: (def.options ?? []).filter((option) => option.id !== optionId) } : def,
    ),
  }
}

/** 数组内移动（`to` 夹到合法范围）——两条排序入口共用。 */
function moveTo<T>(items: T[], from: number, to: number): T[] {
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(to, next.length)), 0, moved)
  return next
}

/** 选项：**排序**（θ4 ④）：`def.options` 的数组序 = 数据（取值选择器与导出写出的顺序同源）。 */
export function movePropertyOption(defId: string, optionId: string, toIndex: number, registry: MetadataRegistry, now = Date.now()): MetadataRegistry | null {
  const target = registry.properties.find((def) => def.id === defId)
  const options = target?.options ?? []
  const from = options.findIndex((option) => option.id === optionId)
  if (!target || from < 0) return null
  if (toIndex === from) return null
  return {
    ...registry,
    properties: registry.properties.map((def) =>
      def.id === defId ? { ...def, options: moveTo(def.options ?? [], from, toIndex), modified: now } : def,
    ),
  }
}

/** 属性定义：**排序**（θ4 ④）：`registry.properties` 的数组序 = 数据（摘要条属性行与卡片属性行同序）。 */
export function movePropertyDef(defId: string, toIndex: number, registry: MetadataRegistry, now = Date.now()): MetadataRegistry | null {
  const from = registry.properties.findIndex((def) => def.id === defId)
  if (from < 0 || toIndex === from) return null
  return {
    ...registry,
    properties: moveTo(registry.properties.map((def) => (def.id === defId ? { ...def, modified: now } : def)), from, toIndex),
  }
}

/**
 * 标签的**用量读数**（`13-属性区重规划` §5-12 / §3.6「用在 N 页」）：**全量**标签（含 0 用的——
 * 选择器要能复用未用的定义）＋ 未删除页面的计数。纯读数，不改数据；取用选择器与属性库共用同一口径。
 */
export function tagUsages(blocks: Iterable<Block>, tags: TagDef[]): { id: string; name: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const block of blocks) {
    if (block.deleted) continue
    for (const id of block.tags) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  return tags
    .map((tag) => ({ id: tag.id, name: tag.name, count: counts.get(tag.id) ?? 0 }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, 'zh-CN'))
}

/** Lazily registers legacy plain-text tags as `TagDef`s keyed by their old text. */
export function migratePlainTags(blocks: Iterable<Block>, registry: MetadataRegistry, now = Date.now()): MetadataRegistry {
  const known = new Set(registry.tags.map((tag) => tag.id))
  const added: TagDef[] = []
  for (const block of blocks) {
    for (const tagId of block.tags) {
      if (known.has(tagId)) continue
      known.add(tagId)
      added.push({ id: tagId, name: tagId, created: now, modified: now })
    }
  }
  return added.length > 0 ? { ...registry, tags: [...registry.tags, ...added] } : registry
}
