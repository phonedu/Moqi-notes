import type { Block, BlockMap } from './block'
import type { Operation, Transaction } from './operation'

/**
 * 页面模板的领域操作（0.7 复利线第一刀）。
 *
 * 模板 = **被标记的普通页面**（页面对象块上的 `isTemplate`，与 `pinned` / `starred` 同一族的页面级标记）：
 * 不新增块类型、不做模板管理中心——模板页照常编辑 / 搜索 / 导出。
 *
 * 「从模板创建」按**三件**应用：
 * ① 属性预设：模板页的属性值带到新页；
 * ② 内容复制（**仅空实例**）：目标页除名字行外没有任何块才复制正文；非空 → 只带属性预设、正文一字不动；
 * ③ 子结构深复制：整棵子树带过来（id 全换新、内部引用改指副本，与复制块的语义一致）。
 */

/** 副本的 id 生成器（测试可注入固定序列）。 */
type IdFactory = () => string

function cloneForTemplate(source: Block, entityId: string, parent: string | null, newId: IdFactory, now: number, idMap: Map<string, string>): Block {
  const block = structuredClone(source)
  block.entityId = entityId
  block.blockUid = newId()
  block.parent = parent
  block.children = []
  block.position = 0
  block.deleted = false
  block.deletedAt = null
  block.prevParent = null
  block.prevIndex = null
  // 页面级标记不随内容走：副本不是模板，也不继承置顶 / 星标。
  block.pinned = false
  block.starred = false
  block.isTemplate = false
  // 行内引用：指向被复制集合内部的改指副本，外部的保持原目标。
  block.content = block.content.map((fragment) => {
    if (fragment.t !== 'inline-ref' || !fragment.ref) return fragment
    const remapped = idMap.get(fragment.ref.targetId)
    return remapped ? { ...fragment, ref: { ...fragment.ref, targetId: remapped } } : fragment
  })
  // 正向引用清空、随后以操作补登记（与复制块同一条路：反链由领域维护，不照抄旧值）。
  block.blockRefs = []
  block.blockBackRefs = []
  block.objectRefs = []
  block.objectBackRefs = []
  block.created = now
  block.modified = now
  return block
}

/** 存为模板 / 取消模板：一条 `update` op（撤销、同步、落盘全链免费）。 */
export function markTemplate(blocks: BlockMap, pageId: string, on: boolean, now = Date.now()): Omit<Transaction, 'inverse'> | null {
  const page = blocks.get(pageId)
  if (!page || page.deleted || !page.isObject) return null
  if (Boolean(page.isTemplate) === on) return null
  return {
    id: crypto.randomUUID(),
    timestamp: now,
    source: 'user',
    operations: [{
      type: 'update',
      opId: crypto.randomUUID(),
      blockId: pageId,
      changes: { isTemplate: on },
      previous: { isTemplate: page.isTemplate ?? false },
    }],
  }
}

export type TemplateApplyResult = {
  transaction: Omit<Transaction, 'inverse'>
  /** 复制过来的块数（0 = 只带了属性预设）。 */
  copiedBlocks: number
  /** 目标页非空，只应用了属性预设（负例路径）。 */
  propertiesOnly: boolean
}

/**
 * 把模板应用到目标页（三件）。目标页**非空**（除名字行外有块）时只带属性预设、正文一字不动。
 * 返回 null = 不成立（模板不是模板页 / 目标不是页面 / 自引用 / 已删除）。
 */
export function instantiateTemplate(
  blocks: BlockMap,
  templateId: string,
  targetPageId: string,
  options: { now?: number; newId?: IdFactory } = {},
): TemplateApplyResult | null {
  const now = options.now ?? Date.now()
  const newId = options.newId ?? (() => crypto.randomUUID())
  const template = blocks.get(templateId)
  const target = blocks.get(targetPageId)
  if (!template || template.deleted || !template.isObject || !template.isTemplate) return null
  if (!target || target.deleted || !target.isObject) return null
  if (templateId === targetPageId) return null

  const operations: Operation[] = []
  // ① 属性预设
  const properties = structuredClone(template.properties ?? [])
  operations.push({
    type: 'update',
    opId: newId(),
    blockId: targetPageId,
    changes: { properties },
    previous: { properties: target.properties },
  })

  // ②③ 仅空实例才复制正文（名字行 = 目标页对象块自己的内容，不算「块」）
  const isEmpty = target.children.every((id) => {
    const child = blocks.get(id)
    return !child || child.deleted
  })
  let copiedBlocks = 0
  if (isEmpty) {
    const roots = template.children.filter((id) => {
      const child = blocks.get(id)
      return Boolean(child) && !child!.deleted
    })
    const idMap = new Map<string, string>()
    for (const rootId of roots) {
      for (const oldId of collectSubtreeIds(blocks, rootId)) idMap.set(oldId, newId())
    }
    const refs: Operation[] = []
    roots.forEach((rootId, rootIndex) => {
      for (const oldId of collectSubtreeIds(blocks, rootId)) {
        const source = blocks.get(oldId)!
        const isRoot = oldId === rootId
        const parentId = isRoot ? targetPageId : idMap.get(source.parent!)!
        const index = isRoot ? rootIndex : blocks.get(source.parent!)!.children.indexOf(oldId)
        operations.push({
          type: 'insert',
          opId: newId(),
          parentId,
          index,
          block: cloneForTemplate(source, idMap.get(oldId)!, parentId, newId, now, idMap),
        })
        copiedBlocks += 1
      }
      // 引用补登记：内部目标改指副本；外部目标仍活着才保留
      for (const oldId of collectSubtreeIds(blocks, rootId)) {
        const source = blocks.get(oldId)!
        const fromId = idMap.get(oldId)!
        for (const ref of source.blockRefs) {
          const internal = idMap.get(ref.targetBlockId)
          const target2 = blocks.get(ref.targetBlockId)
          if (!internal && (!target2 || target2.deleted)) continue
          refs.push({ type: 'block-ref', opId: newId(), fromId, targetId: internal ?? ref.targetBlockId, refType: ref.type, context: ref.context })
        }
        for (const targetId of source.objectRefs) {
          const internal = idMap.get(targetId)
          const target2 = blocks.get(targetId)
          if (!internal && (!target2 || target2.deleted)) continue
          refs.push({ type: 'object-ref', opId: newId(), fromId, targetId: internal ?? targetId })
        }
      }
    })
    operations.push(...refs)
  }

  return {
    transaction: { id: crypto.randomUUID(), operations, timestamp: now, source: 'user' },
    copiedBlocks,
    propertiesOnly: !isEmpty,
  }
}

/** 子树 id（含自己），按先序——与复制块的 collectSubtree 同口径，这里内联避免跨模块依赖循环。 */
function collectSubtreeIds(blocks: BlockMap, rootId: string): string[] {
  const out: string[] = []
  const walk = (id: string): void => {
    const block = blocks.get(id)
    if (!block) return
    out.push(id)
    for (const childId of block.children) walk(childId)
  }
  walk(rootId)
  return out
}
