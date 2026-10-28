/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { createTextBlock, type Block, type BlockMap, type BlockType, type ContentFragment } from './block'
import type { Operation, Transaction } from './operation'

export const convertibleBlockTypes: BlockType[] = [
  'text',
  'heading1',
  'heading2',
  'heading3',
  'heading4',
  'heading5',
  'heading6',
  'bullet',
  'numbered',
  'quote',
  'code',
  'divider',
  'todo',
]

const convertible = new Set<BlockType>(convertibleBlockTypes)

function bodyLength(content: ContentFragment[]): number {
  return content.reduce((total, fragment) => total + fragment.v.length, 0)
}

/** Block 的 blockUid 生成规则： + 8 位 uuid 片段（与 createPage 的写法一致）。 */
export function newBlockUid(): string {
  return `b${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`
}

/**
 * V2a T12: a `/` menu choice becomes one `update` transaction (spec §4.2).
 * Own fields that are not passed in `nextContent` keep their value, so the
 * conversion preserves identity, children, parent, refs, tags and properties.
 * Contract no-ops return null so the caller never creates an empty transaction.
 *
 * `divider` carries no body. Converting a Block that still has text moves the
 * original content into a new `text` sibling (same transaction, one undo);
 * the source keeps the original text only when it is already empty.
 */
export function convertBlockType(
  blocks: BlockMap,
  blockId: string,
  nextType: BlockType,
  nextContent?: ContentFragment[],
  now = Date.now(),
  /**
   * MD 输入层专用（`R09-MD-3` 的 `[x] `）：转换**顺带**定勾选态——放同一个事务里，
   * ⌘Z 一次就退回（两步的话用户要按两次撤销，违背 `R09-MD-4.4`）。不传 = 维持 D11 的「保留原勾选态」。
   */
  nextChecked?: boolean,
): Omit<Transaction, 'inverse'> | null {
  const block = blocks.get(blockId)
  if (!block || block.deleted || !convertible.has(nextType)) return null
 // D13（ 裁决）：页面容器不参与转换。界面置灰只是第一道，域层也要把关
  // （与置顶上限同一做法：单一所有者）。顺带审计见 treeOps 的移动守卫。
  if (block.isObject) return null

  const content = nextContent ?? block.content

  const text = bodyLength(content)
  const movesBody = nextType === 'divider' && text > 0
 // D11（ 裁决）：勾选态**保留**——转出 todo 不清 `checked`（数据留、界面无痕），
  // 转回 todo 即还原。以前在这里清零，等于让转换不可逆（与「AI 采用」的哲学相反）。
  const changes: Partial<Block> = { type: nextType, content: movesBody ? [] : content }
  if (nextChecked !== undefined) changes.checked = nextChecked

  const previous: Partial<Block> = {}
  let dirty = false
  for (const key of Object.keys(changes) as (keyof Block)[]) {
    previous[key] = structuredClone(block[key]) as never
    if (JSON.stringify(previous[key]) !== JSON.stringify(changes[key])) dirty = true
  }
  if (!dirty) return null

  const operations: Operation[] = [{
    type: 'update',
    opId: crypto.randomUUID(),
    blockId,
    changes,
    previous,
  }]

  if (movesBody) {
    const sibling = createTextBlock({
      entityId: crypto.randomUUID(),
      blockUid: newBlockUid(),
      parent: block.parent,
      now,
    })
    sibling.content = content
    const parent = block.parent ? blocks.get(block.parent) : undefined
    operations.push({
      type: 'insert',
      opId: crypto.randomUUID(),
      block: sibling,
      parentId: block.parent,
      index: parent ? parent.children.indexOf(blockId) + 1 : undefined,
    })
  }

  return { id: crypto.randomUUID(), operations, timestamp: now, source: 'user' }
}
