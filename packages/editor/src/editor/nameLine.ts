/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { HISTORIC_TAG, $createLineBreakNode, $createRangeSelection, $getNodeByKey, $getSelection, $isLineBreakNode, $isRangeSelection, $setSelection, type LexicalEditor, type LexicalNode } from 'lexical'
import { $ensureNameLineAnchor, $findBlockNode, $isBlockNode, $isNameLineAnchor, BlockNode, nameRowTextSize } from './blockNode'
import { $contentOffset, $selectBlockStart, $selectOffsetInBlock } from './caret'

/**
 * 名字行（= 页面容器块自己那一行，`docs/04` §3.1 `R04-NAME-11/12`）的**唯一所有者**。
 *
 * 名字行收口（T5）：这三件事原来散在 `ui/EditorShell.tsx`（落点 / 接缝的动作）
 * 与 `editor/inputRules.ts`（接缝的判据），现在归到这里——**行为零变化**，只是换家：
 *
 * | 归属 | 对外 | 说明 |
 * |---|---|---|
 * | **落点** | `selectNameRow` / `$selectNameRow` | 把光标放到名字行（行首 / 文字末尾 / 任意偏移三种落法） |
 * | **接缝** | `decideNameRowCross` / `crossNameRow`、`decideNameRowEdge` / `nameRowEdge` | 与第一个子块之间那处接缝的光标跨越（六键 + 点击） |
 * | **自维护** | `registerNameLineAnchor` | 锚点的注册与调用（`$ensureNameLineAnchor` 是规则本体，住在 `blockNode.ts`） |
 *
 * **有意不在这里的**：`NameLineAnchorNode` 节点类与 `$isNameLineAnchor`（节点家族不拆，留 `blockNode.ts`）；
 * `$normalizePoint` 的 break 语义（光标原语，留 `caret.ts`）；排版数值（CSS，归 `09-桌面端UI规范` `R09-BLOCK-12`）。
 *
 * 名字行锚点为什么存在、六个方向为什么都要显式补：见 `07-验收记录.md`「规则理由 · R04-NAME-11」。
 */

/** 名字行的三种落法：点占位（行首 + 格式归零）/ 文字末尾 / 第 N 个字符。 */
export type NameRowSpot = 'block-start' | 'text-end' | number

/**
 * 空名字行的**行盒持有者**（台账 `D-072`， 真机试验场实证）：空名字行在锚点**之后**
 * 持一个 `LineBreakNode`——「锚点之前」(容器,0) 的折叠光标在 Android WebView 画不出来
 * （那一行没有可编辑的行盒承载物；普通空块靠 Lexical 渲染的 `<br>`，锚点是 DecoratorNode，不带来）。
 * 持有者给这行一个可编辑行盒，(容器,1)〔锚点之后、持有者之前〕桌面与真机两通道都能画。
 *
 * 放锚点**之后**（不是之前）：放之前的话名字行整体下移一行（试验场实测 43px 位移）；
 * 放之后则排版逐像素不变（同帧对照）。名字行一有字就移除（不然名字下多一条空行）；
 * 序列化侧同样跳过（`blockLexicalAdapter` 的 `readBlockNode`）。
 */
export function $ensureNameLineHolder(block: BlockNode): boolean {
  if (!block.isPageObject()) return false
  const children = block.getChildren()
  const anchorIndex = children.findIndex($isNameLineAnchor)
  if (anchorIndex === -1) return false
  // 容器里出现的 br 只可能是持有者（名字是单行、子块不在这一层）——按**存在性**找，
  // 不按「紧挨锚点」找：打字会把文字插进锚点与持有者之间（插入点 =「锚点之后」），持有者随之后移。
  const holder = children.find((child) => $isLineBreakNode(child)) ?? null
  const hasText = nameRowTextSize(block) > 0
  // 光标兜底（`D-072`）：空名字行上落在 (容器,0)（锚点**之前**）的折叠光标挪到「锚点之后」——
  // (容器,0) 在 Android WebView 画不出光标。谁落的都兜（新建页面的初始焦点路径 `$selectBlockStart`
  // 与落点在同一次 update 里，插入持有者那一刻还看不见它；节点变换在提交期跑，看得到最终选区）。
  if (!hasText) {
    const selection = $getSelection()
    if ($isRangeSelection(selection) && selection.isCollapsed()
      && selection.anchor.type === 'element' && selection.anchor.key === block.getKey() && selection.anchor.offset === 0) {
      selection.anchor.set(block.getKey(), anchorIndex + 1, 'element')
      selection.focus.set(block.getKey(), anchorIndex + 1, 'element')
    }
  }
  if (!hasText && !holder) { block.splice(anchorIndex + 1, 0, [$createLineBreakNode()]); return true }
  if (hasText && holder) { holder.remove(); return true }
  return false
}

/**
 * 空名字行的可画落点（台账 `D-072`）：**element 点**落到锚点之后（DOM `(容器,1)`、行盒持有者 br 之前）。
 * 锚点之前的 `(容器,0)` 在 Android WebView 画不出光标（真机试验场实证；桌面两处都画）。
 * 不用 text 点：Lexical 不许把 text 点设在 LineBreakNode 上（`PointType.set` 直接抛错）。
 */
function $selectEmptyNameRow(node: BlockNode): void {
  const anchorIndex = node.getChildren().findIndex($isNameLineAnchor)
  const selection = $createRangeSelection()
  selection.anchor.set(node.getKey(), anchorIndex + 1, 'element')
  selection.focus.set(node.getKey(), anchorIndex + 1, 'element')
  $setSelection(selection)
}

/** `$` 原语：把光标放到名字行（要在 `editor.update` / `read` 上下文里调用）。 */
export function $selectNameRow(containerId: string, spot: NameRowSpot): boolean {
  const node = $findBlockNode(containerId)
  if (!node) return false
  const empty = node.isPageObject() && nameRowTextSize(node) === 0
  if (spot === 'block-start') {
    // 空名字行落「锚点之后」（`D-072`）；有字的名字行照旧 (文本,0)。
    if (empty) $selectEmptyNameRow(node)
    else $selectBlockStart(node)
  }
  else if (spot === 'text-end') {
    if (empty) $selectEmptyNameRow(node)
    else $selectOffsetInBlock(node, nameRowTextSize(node))
  }
  else if (empty) $selectEmptyNameRow(node)
  else $selectOffsetInBlock(node, spot)
  return true
}

/**
 * 点击空名字行（占位那一片）⇒ 光标落到名字行（`R04-NAME-12`）。
 *
 * 占位是**脱离文档流**的装饰（见 app.css）：空名字行里没有可停留的文本，浏览器会把这一带的
 * 点击解析到下面第一个块（用户实测：「想通过点击未命名页面的占位来让光标移到这个位置是没用的」）。
 * 判定只看**点击目标是不是容器元素本身**（不看坐标）——落在子块上的点击一律不干预
 * （名字行有文字时点击本来就落在真实文字上，原生行为就是对的）。落法：行首 + 行内格式归零。
 */
export function selectNameRow(editor: LexicalEditor, containerId: string): boolean {
  if (!$findBlockNodeIn(editor, containerId)) return false
  editor.update(() => { $selectNameRow(containerId, 'block-start') }, { tag: [HISTORIC_TAG, 'moqi-name-row'], discrete: true })
  return true
}

/** 容器的领域事实：`editor/` 不认识 store，由调用方（外壳）读出来传进来。 */
export type NameRowFacts = { containerId: string; firstChildId: string | null }

/**
 * 名字行与第一个子块之间那处接缝的光标跨越（`R04-NAME-12`）。
 *
 * 锚点既是零宽节点，也是子块的「上一个节点」：Lexical 沿「上一个节点」做的光标移动与合并
 * 会被它挡住，所以这处接缝的四个方向都要显式补：
 * - 往上一行（Backspace / ←，光标在**第一个子块的行首**）→ 光标落到名字行；
 * - 往下一行（Delete / →，光标在**名字行的末尾**）→ 光标落到第一个子块的行首。
 *
 * 顺带按 `04` §1 的「空块 Backspace 合并」把**空的第一块**并掉（有内容只带光标，不动文字）。
 */
export function crossNameRow(editor: LexicalEditor, facts: NameRowFacts, options: { backward: boolean; deletes: boolean }): boolean {
  const firstChildId = facts.firstChildId
  if (!firstChildId) return false
  let blockId: string | null = null
  let offset = 0
  let rowSize = 0
  editor.getEditorState().read(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection) || selection.anchor.key === 'root') return
    // 只认「整行边界上的折叠光标」：有选区时 Backspace / Delete 该删选区、方向键该收选区。
    if (!selection.isCollapsed()) return
    let node: LexicalNode | null = $getNodeByKey(selection.anchor.key)
    while (node && !$isBlockNode(node)) node = node.getParent()
    if (!$isBlockNode(node)) return
    blockId = node.getEntityId()
    offset = $contentOffset(node, selection.anchor.key, selection.anchor.offset)
    const containerNode = $findBlockNode(facts.containerId)
    // 名字行文字量（`D-072` 口径）：行盒持有者 br 不算字——按 `inlineTextSize` 算的话，
    // 空名字行的「行末」判据（atNameRowEnd）永远差 1，↓ 与 Delete 的跨行接管全部失灵。
    if (containerNode) rowSize = nameRowTextSize(containerNode)
  })
  const atNameRowEmpty = blockId === facts.containerId && offset === rowSize && rowSize === 0
  const decided = decideNameRowCross({
    backward: options.backward,
    atFirstChildStart: blockId === firstChildId && offset === 0,
    atNameRowEnd: blockId === facts.containerId && offset === rowSize,
    atNameRowEmpty,
    composing: editor.isComposing(),
  })
  if (!decided) return false
  editor.update(() => {
    const containerNode = $findBlockNode(facts.containerId)
    const childNode = $findBlockNode(firstChildId)
    // 空的第一块（没有子块）才并掉：有子块时它承载着一整支内容，删它会连子树一起没了。
    // **只并「从子块行首往回删」这一条路**：空名字行上的 Backspace（atNameRowEmpty）是
    // 页面边界——吃掉事件、光标留在原地，绝不并块也不动正文（D-097：用户删光标题后再按
    // Backspace，正文被顶下去一行 / 光标钻进正文，观感如按了 Enter）。
    const mergeable = !atNameRowEmpty && childNode !== null && childNode.getTextContentSize() === 0 && !childNode.getChildren().some($isBlockNode)
    if (mergeable && childNode) childNode.remove()
    if (options.backward || (mergeable && options.deletes)) {
      // 落回名字行：空行落「锚点之后」(容器,1)（可画，`D-072`）——与 `$selectNameRow('block-start')` 同一落法。
      if (containerNode) {
        if (nameRowTextSize(containerNode) === 0) $selectEmptyNameRow(containerNode)
        else $selectOffsetInBlock(containerNode, nameRowTextSize(containerNode))
      }
    } else if (childNode) {
      $selectBlockStart(childNode)
    }
  }, { tag: [HISTORIC_TAG, 'moqi-name-row'], discrete: true })
  // 并掉空块这件事由编辑器 → 领域的镜像通路落盘（syncEditorChanges），这里不额外写。
  return true
}

/**
 * 名字行的行首 / 行尾（Home / End，`R04-NAME-12`）。
 *
 * 锚点是行内 run 的**最后一个**子节点，Lexical 的「行尾」于是落在锚点之后（一个元素点）：
 * 用户按 End 再按 Backspace，第一下会被这个空位置吃掉（`pnpm accept` 的 `PAGENAME-RENAME-1`、
 * 以及「删光名字」的最后一下都栽在这里， 实测）。所以光标在名字行时，Home / End
 * 一律落到**这一行自己的**行首 / 文字末尾。
 */
export function nameRowEdge(editor: LexicalEditor, facts: { containerId: string }, end: boolean): boolean {
  let onRow = false
  editor.getEditorState().read(() => {
    const selection = $getSelection()
    if (!$isRangeSelection(selection) || selection.anchor.key === 'root') return
    if (!selection.isCollapsed()) return
    let node: LexicalNode | null = $getNodeByKey(selection.anchor.key)
    while (node && !$isBlockNode(node)) node = node.getParent()
    if (!$isBlockNode(node) || node.getEntityId() !== facts.containerId) return
    onRow = true
  })
  if (!decideNameRowEdge({ onNameRow: onRow, composing: editor.isComposing() })) return false
  editor.update(() => { $selectNameRow(facts.containerId, end ? 'text-end' : 0) }, { tag: [HISTORIC_TAG, 'moqi-name-row'], discrete: true })
  return true
}

/**
 * 锚点的**自维护**：注册到 BlockNode 的节点变换上（谁改块，锚点自己补回来）。
 *
 * 容器自己那一行在「删掉名字最后一个字」「首行 Enter 拆走整行文字」之后会被 Lexical 的归一化
 * 收走，指向它的光标随之掉进下一个块（用户实测：删光页名光标跑到下面的块开头、点占位没反应）。
 * 规则只写在 `$ensureNameLineAnchor` 一处（`blockNode.ts`），这里只负责把它接上。
 */
export function registerNameLineAnchor(editor: LexicalEditor): () => void {
  return editor.registerNodeTransform(BlockNode, (node) => {
    $ensureNameLineAnchor(node)
    // 行盒持有者（`D-072`）：空名字行要有一个可编辑行盒才画得出光标（真机试验场实证）。
    // 跟在锚点后面维护同一份不变式：锚点在、空着 ⇒ 补持有者；有字 / 有字后 ⇒ 撤持有者。
    $ensureNameLineHolder(node)
  })
}

/**
 * 名字行与第一个子块之间那处接缝的**判据**（纯函数，`R04-NAME-12`）。
 *
 * 只认「整行边界」：光标在块中间时一律让给浏览器 / Lexical 的原生行为（合并相邻块、
 * 删字符、移动一格），所以这里只接两个布尔量。输入法组合态让给浏览器（同 `decideTab`）。
 */
export function decideNameRowCross(input: {
  /** 键的方向：true = 往上一行（Backspace / ←），false = 往下一行（Delete / →） */
  backward: boolean
  /** 光标在页面容器的第一个子块、且在该块行首（块内字符偏移 0） */
  atFirstChildStart: boolean
  /** 光标在名字行的末尾（名字行有文字：文字结尾；名字行为空：容器那个 element 点） */
  atNameRowEnd: boolean
  /** 名字行为空且光标在其上（atNameRowEnd 的空行特例）：这一行的 Backspace 是**页面边界** */
  atNameRowEmpty: boolean
  composing: boolean
}): boolean {
  if (input.composing) return false
  if (input.backward) return input.atFirstChildStart || input.atNameRowEmpty
  return input.atNameRowEnd
}

/** 名字行 Home / End 的判据（纯函数）：光标在名字行上（且不在输入法组合态）就接管。 */
export function decideNameRowEdge(input: { onNameRow: boolean; composing: boolean }): boolean {
  return !input.composing && input.onNameRow
}

/** 读一次：这个容器在编辑器里存在吗（`selectNameRow` 的入口检查，避免写空 transaction）。 */
function $findBlockNodeIn(editor: LexicalEditor, containerId: string): boolean {
  let found = false
  editor.getEditorState().read(() => { found = $findBlockNode(containerId) !== null })
  return found
}
