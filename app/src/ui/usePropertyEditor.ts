import { createPropertyDef, addPropertyOption, deletePropertyDef, ensureTagDef, isDefaultField, movePropertyDef, movePropertyOption, removePropertyOption, renamePropertyDef, renamePropertyOption, type MetadataRegistry, type PropertyType, type PropertyValue } from '@moqi/editor'
import type { Block } from '@moqi/editor'
import type { DomainStore } from '../application/store'
import { initialValueFor } from './shellSupport'
import { propertyNameToast, type PropertyEditorCallbacks } from './PropertyRows'
import { pushRecentProperty, type UiPrefs } from './uiPrefs'

/**
 * 属性 / 标签的**写入口**（外壳拆分第四刀， 从 `EditorShell` 抽出）。
 *
 * 为什么是 `use*` 模块（`06` §6 落点四问第 ③ 条）：它是一组**闭包在会话状态上的写操作**——
 * 改注册表（属性定义）、改页面上的取值与标签、挂属性时记一笔「最近使用」。面板（`Property.tsx`）
 * 只认回调、不认外壳；外壳只留一行接线。搬的只是住址，行为一字未改。
 */
type Deps = {
  registry: MetadataRegistry
  /** 注册表写口（住外壳：标签全局操作与导入通路也用同一个）。 */
  updateRegistry: (next: MetadataRegistry) => void
  store: DomainStore
  /** 当前页（无页面时属性写入口全部空转）。 */
  activePageId: string | null
  prefs: UiPrefs
  updatePrefs: (next: UiPrefs) => void
  /** 保存队列的入队口（外壳的 `persist`）。 */
  persist: (changedIds: Iterable<string>) => void
  notify: (message: string, actionLabel?: string, onAction?: () => void) => void
  closeDialog: () => void
}

export function usePropertyEditor({
  registry, updateRegistry, store, activePageId, prefs, updatePrefs, persist, notify, closeDialog,
}: Deps): {
  /** 面板（`Property.tsx` 两处同构）认的那组回调。 */
  propertyCallbacks: PropertyEditorCallbacks
  /** 设置页「全局属性管理」用的写入口（**停用已取消**，`属性区重规划（已归档）` §0-4：状态收敛为 在用 / 已删除）。 */
  createProperty: (name: string, type: PropertyType) => void
  /** 添加弹窗「建并添加」：建定义 ＋ 本页写初始取值 ＋ 记「最近使用」（关弹窗归弹窗自己）。 */
  createAndAddProperty: (name: string, type: PropertyType) => void
  handleRenameProperty: (defId: string, name: string) => string | null
  handleAddPropertyOption: (defId: string, label: string) => void
  /** θ4 选项维护：改名（值不动，判据 label 唯一）/ 删除（全库清值一块事务 → 移除选项）/ 排序（数组序 = 数据）。 */
  handleRenamePropertyOption: (defId: string, optionId: string, label: string) => boolean
  handleRemovePropertyOption: (defId: string, optionId: string) => void
  handleMovePropertyOption: (defId: string, optionId: string, toIndex: number) => void
  /** θ4 ④ 属性定义排序（`registry.properties` 数组序 = 数据：摘要条属性行与卡片属性行同序）。 */
  handleMoveProperty: (defId: string, toIndex: number) => void
  /** 名称判据的人话（θ4：设置页「完成」的可点性与就地一句共用一份）——`propertyNameProblem` 的包装。 */
  nameProblemText: (name: string, excludeId?: string) => string | null
  /** 添加属性弹窗的「点了即加即关」落点。 */
  mountProperty: (defId: string) => void
  /** 删除用户属性（仅 registry 里的；§3.2① 全库清值一块事务 → ② 删定义）。 */
  deleteProperty: (defId: string) => void
} {
  function createProperty(name: string, type: PropertyType) {
    const created = createPropertyDef(name, type, registry)
    if (!created) {
      notify(propertyNameToast(name, registry) ?? `建不了属性「${name.trim()}」`)
      return
    }
    updateRegistry(created.registry)
  // `§0-6`（ 裁决）：**成功不弹通知**（界面自证——属性已出现在面板/属性库里）。
  }

  /**
   * 添加弹窗的「**建并添加**」（`属性区重规划（已归档）` §0-3）：建定义 → 本页写入初始取值 → 记「最近使用」。
   * 判据与 `createProperty` 同一套（失败 toast 说清问题）；取值那一笔走 `updatePage`（一次事务一个落盘名单）。
   * 关弹窗不在这里——弹窗自己的 submit 建完即关（点了即加即关）。
   */
  function createAndAddProperty(name: string, type: PropertyType) {
    const created = createPropertyDef(name, type, registry)
    if (!created) {
      notify(propertyNameToast(name, registry) ?? `建不了属性「${name.trim()}」`)
      return
    }
    updateRegistry(created.registry)
    if (activePageId) {
      const page = store.get(activePageId)
      if (page) updatePage({ properties: [...page.properties, initialValueFor(created.def)] })
    }
    // 「最近使用」两条路都记：列表添加（`mountProperty`）与这里的新建。
    updatePrefs(pushRecentProperty(prefs, created.def.id))
  }

 /** 改名：**成功不弹通知**、失败**返回原因**由调用方就地显示（`§0-6`， 裁决）。 */
  function handleRenameProperty(defId: string, name: string): string | null {
    const problem = propertyNameToast(name, registry, defId)
    if (problem) return problem
    const next = renamePropertyDef(defId, name, registry)
    if (!next) return `改不了属性名「${name.trim()}」`
    updateRegistry(next)
    return null
  }

  /**
   * 「时间」行的值（`属性区重规划（已归档）` §0-12 已裁）：改的是页面的 `created`（`YYYY-MM-DD` 本地日）。
   * `modified` 系统维护、不从这里写；一次事务、一个落盘名单（与其它页级字段同一条通路）。
   */
  function setCreated(value: string) {
    if (!activePageId) return
    const page = store.get(activePageId)
    if (!page) return
    const [year, month, day] = value.split('-').map(Number)
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return
    const timestamp = new Date(year, month - 1, day).getTime()
    if (!Number.isFinite(timestamp) || timestamp === page.created) return
    store.apply({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      source: 'user',
      operations: [{
        type: 'update',
        opId: crypto.randomUUID(),
        blockId: activePageId,
        changes: { created: timestamp },
        previous: { created: page.created },
      }],
    })
    persist([activePageId])
  }

  function handleAddPropertyOption(defId: string, label: string) {
    const result = addPropertyOption(defId, label, registry)
    if (result) updateRegistry(result.registry)
  }

  /** 选项：**改名**（θ4）：值不动（按 `optionId` 挂）；判据在域层（label 唯一）。返回是否成功（失败就地一句）。 */
  function handleRenamePropertyOption(defId: string, optionId: string, label: string): boolean {
    const next = renamePropertyOption(defId, optionId, label, registry)
    if (next) updateRegistry(next)
    return next !== null
  }

  /**
   * 选项：**删除**（θ4）——两步的第 ② 步：① **一块事务**清掉全库引用该选项的取值（可 ⌘Z 撤销；
   * 体例同 `deleteProperty`：沾到的页每个一条 update）→ ② 从定义里移除该选项。影响清单（用在 N 页）由确认框先给。
   */
  function handleRemovePropertyOption(defId: string, optionId: string) {
    type ApplyInput = Parameters<DomainStore['apply']>[0]
    type Changes = Partial<Pick<Block, 'properties'>>
    const operations: ApplyInput['operations'] = []
    const touched: string[] = []
    for (const block of store.snapshot().values()) {
      if (!block.properties.some((item) => item.defId === defId && item.type === 'select' && item.optionId === optionId)) continue
      const changes: Changes = { properties: block.properties.filter((item) => !(item.defId === defId && item.type === 'select' && item.optionId === optionId)) }
      operations.push({ type: 'update', opId: crypto.randomUUID(), blockId: block.entityId, changes, previous: { properties: block.properties } })
      touched.push(block.entityId)
    }
    if (operations.length > 0) {
      store.apply({ id: crypto.randomUUID(), timestamp: Date.now(), source: 'user', operations })
      persist(touched)
    }
    const next = removePropertyOption(defId, optionId, registry)
    if (next) updateRegistry(next)
  }

  /** 选项：**排序**（θ4 ④）——`def.options` 的数组序 = 数据（选择器与导出同序）。 */
  function handleMovePropertyOption(defId: string, optionId: string, toIndex: number) {
    const next = movePropertyOption(defId, optionId, toIndex, registry)
    if (next) updateRegistry(next)
  }

  /** 属性定义：**排序**（θ4 ④）——`registry.properties` 的数组序 = 数据（摘要条属性行与卡片属性行同序）。 */
  function handleMoveProperty(defId: string, toIndex: number) {
    const next = movePropertyDef(defId, toIndex, registry)
    if (next) updateRegistry(next)
  }

  /** 名称判据的人话（θ4）——建 / 改与设置页的「完成」共用同一份判据（`propertyNameProblem` ＋ 人话）。 */
  function nameProblemText(name: string, excludeId?: string) {
    return propertyNameToast(name, registry, excludeId)
  }

  /** 改本页的字段（属性值 / `propertyShown` / `propertyHidden`）——一次事务、一个落盘名单。 */
  function updatePage(changes: Partial<Pick<Block, 'properties' | 'propertyShown' | 'propertyHidden'>>) {
    if (!activePageId) return
    const page = store.get(activePageId)
    if (!page) return
    const previous: Partial<Block> = {}
    for (const key of Object.keys(changes) as (keyof typeof changes)[]) (previous as Record<string, unknown>)[key] = page[key]
    store.apply({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      source: 'user',
      operations: [{ type: 'update', opId: crypto.randomUUID(), blockId: activePageId, changes, previous }],
    })
    persist([activePageId])
  }

  /**
  * 「添加属性」（`属性区重规划（已归档）` §0-1/§0-2/§0-3/§0-9， 裁决）：
   * 默认字段（标签 / 创建时间 / 编辑时间）→ 进 `propertyShown` 即出现（没有值可写）；
   * 用户属性 → 出一档 `propertyHidden`（从本页删过的再加回来）＋ 写初始值（既有行为）。
   * 两侧都**不做限制**：已添加再点 = 幂等。
   */
  function mountProperty(defId: string) {
    if (!activePageId) return
    const page = store.get(activePageId)
    if (!page) return
    const shown = page.propertyShown ?? []
    const hidden = page.propertyHidden ?? []
    const nextShown = shown.includes(defId) ? shown : [...shown, defId]
    const nextHidden = hidden.filter((id) => id !== defId)
    if (isDefaultField(defId)) {
      updatePage({ propertyShown: nextShown, propertyHidden: nextHidden })
      closeDialog()
      return
    }
    const def = registry.properties.find((item) => item.id === defId)
    if (!def) return
    const value = initialValueFor(def)
    updatePage({
      properties: [...page.properties.filter((item) => item.defId !== defId), value],
      propertyShown: nextShown,
      propertyHidden: nextHidden,
    })
  // 「最近使用」记一笔（添加属性弹窗的快捷组； 新设计）。
    updatePrefs(pushRecentProperty(prefs, defId))
    closeDialog()
  }

  /**
   * 删除用户属性（`属性区重规划（已归档）` §3.2「删除（仅用户建的）」）：① **一块事务**清全库取值与显示集合
   * （可 ⌘Z 撤销——沾到的块每个一条 update 操作；软删除页也清，不留悬空引用）→ ② 删定义。
   * 影响清单（用在 N 页 / 共 M 个值）由调用方在确认框里先给（判据 = `domain.propertyUsages` 同一读数）。
   */
  function deleteProperty(defId: string) {
    type ApplyInput = Parameters<DomainStore['apply']>[0]
    type Changes = Partial<Pick<Block, 'properties' | 'propertyShown' | 'propertyHidden'>>
    const operations: ApplyInput['operations'] = []
    const touched: string[] = []
    for (const block of store.snapshot().values()) {
      const hasValue = block.properties.some((item) => item.defId === defId)
      const shown = block.propertyShown ?? []
      const hidden = block.propertyHidden ?? []
      if (!hasValue && !shown.includes(defId) && !hidden.includes(defId)) continue
      const changes: Changes = {}
      const previous: Changes = {}
      if (hasValue) { changes.properties = block.properties.filter((item) => item.defId !== defId); previous.properties = block.properties }
      if (shown.includes(defId)) { changes.propertyShown = shown.filter((id) => id !== defId); previous.propertyShown = shown }
      if (hidden.includes(defId)) { changes.propertyHidden = hidden.filter((id) => id !== defId); previous.propertyHidden = hidden }
      operations.push({ type: 'update', opId: crypto.randomUUID(), blockId: block.entityId, changes, previous })
      touched.push(block.entityId)
    }
    if (operations.length > 0) {
      store.apply({ id: crypto.randomUUID(), timestamp: Date.now(), source: 'user', operations })
      persist(touched)
    }
    const next = deletePropertyDef(defId, registry)
    if (next) updateRegistry(next)
  }

  /**
   * 「**从本页删除**」（`§0-10` 裁决：本页不再显示、**值保留**）：默认字段出 `propertyShown`；
   * 用户属性进 `propertyHidden`（值还在，再加回来即恢复）。要清值就**把值清空**（既有语义）。
   */
  function removeFromPage(defId: string) {
    if (!activePageId) return
    const page = store.get(activePageId)
    if (!page) return
    const shown = page.propertyShown ?? []
    const hidden = page.propertyHidden ?? []
    if (isDefaultField(defId)) {
      updatePage({ propertyShown: shown.filter((id) => id !== defId), propertyHidden: hidden.filter((id) => id !== defId) })
      return
    }
    updatePage({ propertyShown: shown.filter((id) => id !== defId), propertyHidden: hidden.includes(defId) ? hidden : [...hidden, defId] })
  }

  function setBlockProperty(defId: string, value: PropertyValue | null) {
    if (!activePageId) return
    const nextProperties = value === null
      ? (store.get(activePageId)?.properties ?? []).filter((item) => item.defId !== defId)
      : [...(store.get(activePageId)?.properties ?? []).filter((item) => item.defId !== defId), value]
    store.apply({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      source: 'user',
      operations: [{
        type: 'update',
        opId: crypto.randomUUID(),
        blockId: activePageId,
        changes: { properties: nextProperties },
        previous: { properties: store.get(activePageId)?.properties ?? [] },
      }],
    })
    persist([activePageId])
  }

  function addPageTag(name: string) {
    if (!activePageId) return
    const { id, registry: next } = ensureTagDef(name, registry)
    updateRegistry(next)
    const page = store.get(activePageId)
    if (!page || page.tags.includes(id)) return
    store.apply({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      source: 'user',
      operations: [{
        type: 'update',
        opId: crypto.randomUUID(),
        blockId: activePageId,
        changes: { tags: [...page.tags, id] },
        previous: { tags: page.tags },
      }],
    })
    persist([activePageId])
  }

  function removePageTag(tagId: string) {
    if (!activePageId) return
    const page = store.get(activePageId)
    if (!page) return
    store.apply({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      source: 'user',
      operations: [{
        type: 'update',
        opId: crypto.randomUUID(),
        blockId: activePageId,
        changes: { tags: page.tags.filter((id) => id !== tagId) },
        previous: { tags: page.tags },
      }],
    })
    persist([activePageId])
  }

  const propertyCallbacks: PropertyEditorCallbacks = {
    onSetValue: setBlockProperty,
    onAddOption: handleAddPropertyOption,
    onRemoveProperty: removeFromPage,
    onRenameProperty: handleRenameProperty,
    onSetCreated: setCreated,
    onAddTag: addPageTag,
    onRemoveTag: removePageTag,
  }

  return {
    propertyCallbacks, createProperty, createAndAddProperty, deleteProperty, handleRenameProperty, handleAddPropertyOption, mountProperty,
    handleRenamePropertyOption, handleRemovePropertyOption, handleMovePropertyOption, handleMoveProperty, nameProblemText,
  }
}
