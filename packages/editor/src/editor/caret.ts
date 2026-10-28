/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { $createRangeSelection, $getNodeByKey, $getSelection, $isLineBreakNode, $isRangeSelection, $setSelection, type LexicalEditor, type LexicalNode } from 'lexical'
import { $inlineTextChildren, $isBlockNode, $isNameLineAnchor, type BlockNode } from './blockNode'

/**
 * 光标所在块的 entityId；光标不在任何块里（或停在根上）时返回 null。
 *
 * 自带一次 `read`（所以名字不是 `$` 前缀）：调用点大多是事件回调，不想为了读一个 id
 * 自己包一层 `editor.getEditorState().read(...)`。原住在 `ui/EditorShell.tsx`，
 * 随还债 #2 模块③下沉到这里——AI 的「光标块」档位（`R09-AIB-6`）与编辑器外壳都要用。
 */
type EditorReadHandle = { getEditorState(): ReturnType<LexicalEditor['getEditorState']> }

export function currentBlockId(editor: EditorReadHandle): string | null {
  let found: string | null = null
  editor.getEditorState().read(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection) || selection.anchor.key === 'root') return
    let node = $getNodeByKey(selection.anchor.key)
    while (node && !$isBlockNode(node)) node = node.getParent()
    if ($isBlockNode(node)) found = node.getEntityId()
  })
  return found
}

/**
 * 块内光标的字符偏移与恢复（docs/04 §1：结构操作 / 领域重建都不许抢光标）。
 *
 * 编辑器的 selection 记的是**节点 key + 该节点内的偏移**，而领域操作、整篇重建之后
 * 节点会换新（key 全变），所以「保持光标」必须靠**块内行内文字的字符偏移**来表达：
 * 重建前读一次、重建后放回去。斜杠菜单那边判定触发词也用的是同一套「块内行内文字前缀」的算法。
 *
 * 只数**行内文字**：页面容器的名字行锚点是零宽结构性节点，既不是文字位置（不能当锚点设 point），
 * 也不参与偏移计算（见 blockNode.ts 的 `$inlineTextChildren`）。
 */

/** 光标在块内行内文字里的字符偏移；光标不在这个块的行内文字里时返回 null。 */
export function $caretOffsetInBlock(block: BlockNode, anchorKey: string, anchorOffset: number): number | null {
  let prefix = 0
  let reached = false
  for (const child of $inlineTextChildren(block)) {
    if (child.getKey() === anchorKey) {
      prefix += anchorOffset
      reached = true
      break
    }
    prefix += child.getTextContentSize()
  }
  return reached ? prefix : null
}

/** 把光标放到块内行内文字的第 `offset` 个字符处（越界钳到行内末尾）；块内没有行内文字时落到块首。 */
export function $selectOffsetInBlock(block: BlockNode, offset: number): void {
  const inline = $inlineTextChildren(block)
  let remaining = Math.max(0, offset)
  for (const child of inline) {
    const size = child.getTextContentSize()
    if (remaining <= size) {
      const selection = $createRangeSelection()
      selection.anchor.set(child.getKey(), remaining, 'text')
      selection.focus.set(child.getKey(), remaining, 'text')
      $setSelection(selection)
      return
    }
    remaining -= size
  }
  // 越界：落到最后一个行内子节点末尾。不用 block.selectEnd()——块尾的 element 点读不回字符偏移，
  // 而且有子块时它会落到子块之后。
  const last = inline[inline.length - 1]
  if (!last) {
    $selectBlockStart(block)
    return
  }
  const size = last.getTextContentSize()
  const selection = $createRangeSelection()
  selection.anchor.set(last.getKey(), size, 'text')
  selection.focus.set(last.getKey(), size, 'text')
  $setSelection(selection)
}

/**
 * 光标落到块首，**行内格式归零**（docs/04 §1「换文档 = 新文档」）。
 *
 * 不能用 `block.selectStart()`：Lexical 的 `ElementNode.select()` / `TextNode.select()` 在
 * 已有 RangeSelection 时是**原地改写同一个 selection 对象**（`selection.anchor.set(...)`），
 * 于是上一处的 `selection.format` 被原样带过来——换页 / 新建页面后格式栏还亮着上一页的「加粗」，
 * 接着敲的字也是加粗的（用户实测：「新开页面会保留上一个页面光标处出现的格式」）。
 * 这里显式新建 selection（`$createRangeSelection()` 的 format 恒为 0），把格式断掉。
 */
export function $selectBlockStart(block: BlockNode): void {
  const first = $inlineTextChildren(block)[0]
  const selection = $createRangeSelection()
  if (first && $isLineBreakNode(first)) {
    // 块首是换行（名字行的行盒持有者 / 代码块开头的空行，`D-072`）：Lexical 不许把 text 点
    // 设在 LineBreakNode 上（`PointType.set` 直接抛错）——用 element 点落在它之前（DOM 同位）。
    const index = block.getChildren().indexOf(first)
    selection.anchor.set(block.getKey(), Math.max(0, index), 'element')
    selection.focus.set(block.getKey(), Math.max(0, index), 'element')
  } else if (first) {
    selection.anchor.set(first.getKey(), 0, 'text')
    selection.focus.set(first.getKey(), 0, 'text')
  } else {
    // 空块：锚在块元素本身的开头（可读字符偏移无从谈起，element 点即可）。
    // 页面容器这边还多一层保障：element 点不会被下压进子块——容器的名字行锚点让
    // `$normalizePoint` 的下降循环当场 break（见 blockNode.ts）。
    // **页面容器例外**（`D-072`）：空名字行落「锚点之后」(容器, anchorIndex+1)——(容器,0) 在
    // Android WebView 画不出光标；「锚点之后」也是行盒持有者 br 的将来位置（同 `$selectEmptyNameRow`）。
    const anchorIndex = block.isPageObject() ? block.getChildren().findIndex($isNameLineAnchor) : -1
    const offset = anchorIndex === -1 ? 0 : anchorIndex + 1
    selection.anchor.set(block.getKey(), offset, 'element')
    selection.focus.set(block.getKey(), offset, 'element')
  }
  $setSelection(selection)
}

/**
 * 光标落到块内容**末尾**（触控双击进编辑态用——接着打字是主路径）。
 * 同 `$selectBlockStart` 的两条纪律：显式新建 selection（不带上一处的格式）、
 * 用**行内文字**的末尾而不是 `block.selectEnd()`（后者有子块时会落到子树之后）。
 */
export function $selectBlockEnd(block: BlockNode): void {
  const inline = $inlineTextChildren(block)
  const last = inline[inline.length - 1]
  const selection = $createRangeSelection()
  if (last && $isLineBreakNode(last)) {
    // 块尾是换行（同 `$selectBlockStart` 的 br 守卫）：element 点落在它之后（DOM 同位）。
    const index = block.getChildren().indexOf(last)
    selection.anchor.set(block.getKey(), index + 1, 'element')
    selection.focus.set(block.getKey(), index + 1, 'element')
  } else if (last) {
    const size = last.getTextContentSize()
    selection.anchor.set(last.getKey(), size, 'text')
    selection.focus.set(last.getKey(), size, 'text')
  } else {
    selection.anchor.set(block.getKey(), block.getChildrenSize(), 'element')
    selection.focus.set(block.getKey(), block.getChildrenSize(), 'element')
  }
  $setSelection(selection)
}

/**
 * 光标在块内的字符偏移，**含元素点**这种落法（`$caretOffsetInBlock` 对它是 null）。
 *
 * 名字行那处接缝必须用它：名字行为空时光标是**容器元素自己的 element 点**
 * （见 `nameLine.ts` 的 `decideNameRowCross`），`$caretOffsetInBlock` 会返回 null 判不出
 * 「在名字行末尾」。锚点在块元素上时按「前面那些子节点的文字量之和」算（子块不计，同
 * `$inlineTextChildren` 的口径）。
 *
 * 原住在 `ui/EditorShell.tsx`（ 名字行收口 T5 时随光标原语一起下沉）。
 */
export function $contentOffset(blockNode: BlockNode, anchorKey: string, anchorOffset: number): number {
  if (blockNode.getKey() === anchorKey) {
    return blockNode.getChildren().slice(0, anchorOffset).reduce((total, child) => total + ($isBlockNode(child) ? 0 : child.getTextContentSize()), 0)
  }
  let offset = 0
  let found = false
  const visit = (node: LexicalNode): void => {
    if (found || $isBlockNode(node)) return
    if (node.getKey() === anchorKey) { offset += anchorOffset; found = true; return }
    offset += node.getTextContentSize()
  }
  for (const child of blockNode.getChildren()) visit(child)
  return offset
}

/**
 * 结构操作（缩进 / 反缩进 / 转换类型 / 拖拽）**不该抢光标**（docs/04 §1：光标位置只能由用户动作
 * 与当前编辑器状态决定）。Lexical 的选择记的是**节点 key**，块被搬动或改类型后 key 不变、
 * 选择依然有效，所以光标已经在这个块里时什么都不用做——回块首会把「刚写完那一句的字后面」丢掉
 * （写完一句一缩进就跳到段首）。光标不在这个块里（块工具栏、多选、跳转）时才回块首，保证接下来有落点。
 */
export function caretIsInBlock(editor: LexicalEditor, blockId: string): boolean {
  return currentBlockId(editor) === blockId
}
