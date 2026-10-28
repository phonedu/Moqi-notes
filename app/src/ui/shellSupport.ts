/**
 * 外壳支持（2026-10-09 收口；来源：代码侧第一批「外壳新代码免入」的第一刀）。
 *
 * **职责**：从 `EditorShell.tsx` 抽出的**叶子函数**——首屏种子与页面路径、属性行模型、格式快照比较、
 * 光标归属判据。都是纯函数或只依赖领域数据，跟渲染无关；外壳只调用、不再自己实现。
 *
 * 落点依据：`06` §6 落点四问——「判据 / 派生数据」进这里，「画」才留给表面组件。
 */
import { createTextBlock, orderedRootIds, type Block, type BlockMap } from '@moqi/editor'
import { resolveDropDestination, type DropPosition } from '@moqi/editor'
import { syncBlockGroupMove } from '@moqi/editor'
import { summarizeBlock } from '@moqi/editor'
import { DEFAULT_FIELD, propertyRowVisible, type MetadataRegistry, type PropertyDef, type PropertyValue } from '@moqi/editor'
import type { PropertyRow } from './types'
import { formatDate } from './format'
import type { DomainStore } from '../application/store'

const initialText = ''

/**
 * γ2（2026-10-12）：**块组拖拽的落位**（选择模式内拖整个选区）——
 * 落点规则（`resolveDropDestination`）→ 领域**一次事务**（`store.moveBlocks`）→ Lexical 结构同步。
 *
 * 一次拖拽 = **一步撤销**（领域侧就是一笔 transaction）；非法落点 `false` = 没动（界面据此回弹、不画线）。
 * 同步保序：`into` = 依次 append；`before` = 逐个插在目标前（顺插即保序）；`after` = **滚动锚点**（每插一块后锚点移到刚插的那块，否则后插的会挤到前面）。
 */
export function moveBlockGroup(input: {
  store: DomainStore
  editor: { update(updateFn: () => void, options?: { tag?: string | string[]; discrete?: boolean }): void }
  ids: string[]
  targetId: string
  position: DropPosition
}): boolean {
  const { store, editor, ids, targetId, position } = input
  if (ids.length === 0) return false
  const destination = resolveDropDestination(store.read(), ids[0], targetId, position)
  if (!destination) return false
  if (!store.moveBlocks(ids, destination.parentId, destination.index)) return false
  syncBlockGroupMove(editor, ids, targetId, position)
  return true
}

export function firstPageId(blocks: BlockMap): string | null {  for (const id of orderedRootIds(blocks)) {
    const block = blocks.get(id)
    if (block?.isObject) return id
  }
  return null
}

/** 来源路径：所属页面 › 块摘要（块本身是页面时只显示页面名）。 */
export function pathOf(blocks: BlockMap, block: Block): string {
  if (block.isObject) return block.objectName ?? '未命名页面'
  let cursor: Block | undefined = block.parent ? blocks.get(block.parent) : undefined
  while (cursor && !cursor.isObject) cursor = cursor.parent ? blocks.get(cursor.parent) : undefined
  const page = cursor?.objectName ?? '页面'
  return `${page} › ${summarizeBlock(block)}`
}

export function propertyValueLabel(def: PropertyDef, value: PropertyValue | undefined): string {
  if (!value) return ''
  if (value.type === 'select') return def.options?.find((option) => option.id === value.optionId)?.label ?? ''
  if (value.type === 'checkbox') return value.value ? '已勾选' : ''
  return String(value.value)
}

export function initialValueFor(def: PropertyDef): PropertyValue {
  switch (def.type) {
    case 'select': return { defId: def.id, type: 'select', optionId: def.options?.[0]?.id ?? '' }
    case 'number': return { defId: def.id, type: 'number', value: 0 }
    case 'date': return { defId: def.id, type: 'date', value: formatDate(Date.now()) }
    case 'checkbox': return { defId: def.id, type: 'checkbox', value: false }
    default: return { defId: def.id, type: 'text', value: '' }
  }
}

/**
 * 属性行模型（摘要条原位展开）：用户属性 = 本页已挂载的定义；默认字段（标签 / 创建时间 / 编辑时间）
 * 是**可添加项**（`13-属性区重规划` §0-1/§0-2，2026-10-10 裁决）——行显示规则收在领域纯函数
 * `propertyRowVisible`：**`(键 ∈ propertyShown ∨ 有值) ∧ 键 ∉ propertyHidden`**。
 * 没有可见行 ⇒ 页面没有属性面（§0-11：有属性才出现）。
 */
export function buildPropertyRows(page: Block, registry: MetadataRegistry) {
  const shown = page.propertyShown ?? []
  const hidden = page.propertyHidden ?? []
  const custom = registry.properties
    .filter((def) => propertyRowVisible({ id: def.id, hasValue: page.properties.some((value) => value.defId === def.id), shown, hidden }))
    .map((def) => ({ kind: 'custom' as const, def, value: page.properties.find((value) => value.defId === def.id) }))
  const rows: PropertyRow[] = [...custom]
  const showDefault = (id: string, hasValue = false) => propertyRowVisible({ id, hasValue, shown, hidden })
  // 标签行的「有值」= **这页真挂着标签**（导入 front-matter / 行内标签收进来后 `accept:R09-MD-3` 要它在页头现身）；
  // 「时间」行仍是纯可添加项（页面创建时间人人都有，若按有值出，属性面就永不消失——§0-11）。
  if (showDefault(DEFAULT_FIELD.tags, page.tags.length > 0)) {
    rows.push({
      kind: 'tags' as const,
      tags: page.tags.map((tagId) => registry.tags.find((tag) => tag.id === tagId)).filter((tag): tag is { id: string; name: string; created: number; modified: number } => Boolean(tag)).map((tag) => ({ id: tag.id, name: tag.name })),
    })
  }
  // 「时间」= **一行**（§0-12 已裁）：值取 `created`、用户可改；`modified` 不进面板（旧「编辑时间」行退场）。
  if (showDefault(DEFAULT_FIELD.created)) rows.push({ kind: 'time' as const, timestamp: page.created })
  return rows
}

/** 三层工具栏的格式快照值比较：内容相同就不换引用，避免每次编辑器更新都重渲染。 */
export function sameFormats(
  left: { selection: string[]; blocks: string[] },
  right: { selection: string[]; blocks: string[] },
): boolean {
  const same = (a: string[], b: string[]): boolean => a.length === b.length && a.every((item, index) => item === b[index])
  return same(left.selection, right.selection) && same(left.blocks, right.blocks)
}

export function loadInitialBlocks(): Block[] {
  return [createTextBlock({
    entityId: crypto.randomUUID(),
    blockUid: 'p00000001',
    text: initialText,
    isObject: true,
    objectName: '未命名页面',
  })]
}

/** 视口断点查询：无 window 的环境（测试/SSR）一律返回 false。 */
export function matchMediaSafe(query: string): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia(query).matches
  } catch {
    return false
  }
}
/** 「另存副本」：桌面复制进认得的目录并把路径显示出来；浏览器通道直接下载（`AssetPort.saveCopy`）。 */
export async function saveMediaCopy(options: { asset: Block['asset']; notify: (text: string) => void; saveCopy: (diskName: string, displayName: string) => Promise<string | null> }) {
  const asset = options.asset
  if (!asset) return
  try {
    await options.saveCopy(asset.fileName, asset.originalName)
  } catch (error) {
    options.notify('另存失败：' + (error instanceof Error ? error.message : String(error)))
  }
}
/**
 * 当前有没有**文字选区**（非折叠的 DOM 选区）。块级 ⌘C / ⌘X 用它给文字让路：
 * 有文字选区时那是文字的复制 / 剪切，走内核与平台自己的路径（`R09-KEY-21`）。
 */
export function hasTextSelection(): boolean {
  const selection = window.getSelection()
  return Boolean(selection && !selection.isCollapsed && selection.rangeCount > 0)
}

/**
 * 回收站「恢复」一页（2026-10-11 4b-② 从 `EditorShell` 搬出——体量门「外壳新代码免入」）：
 * 名字 = 首行（docs/04 §3.1）——老页面（名字只在 `objectName` 里）还原后要把名字落进首行，
 * 否则回落占位。桌面回收站视图与手机档回收站 Sheet **共用这一条**（依赖以口传入，方便单测）。
 */
export function restorePageWithLegacyName(deps: {
  store: DomainStore
  snapshot: Map<string, Block>
  persist: (rootIds: string[]) => void
  reloadFromStore: () => void
  notify: (message: string) => void
}, id: string): void {
  const { store, snapshot, persist, reloadFromStore } = deps
  if (!store.restore(id)) return
  const restored = store.get(id)
  if (restored?.isObject) {
    const own = restored.content.map((fragment) => fragment.v).join('').trim()
    const legacyName = (restored.objectName ?? '').trim()
    if (own.length === 0 && legacyName.length > 0 && legacyName !== '未命名页面') {
      store.apply({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: 'user',
        operations: [{ type: 'update', opId: crypto.randomUUID(), blockId: id, changes: { content: [{ t: 'text', v: legacyName }] }, previous: { content: restored.content } }],
      })
    }
  }
  reloadFromStore()
  persist([...snapshot.values()].filter((block) => !block.deleted).map((block) => block.entityId))
  /* B 批：恢复成功不弹通知（页面回来了 = 界面自证） */
}
