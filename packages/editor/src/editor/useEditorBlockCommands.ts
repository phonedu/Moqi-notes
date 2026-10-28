import type { MutableRefObject } from 'react'
import { $createTextNode, $getNodeByKey, $getSelection, $isRangeSelection, HISTORIC_TAG, type LexicalEditor, type LexicalNode } from 'lexical'
import {
  createTextBlock, isListType, orderedRootIds, splitContentAtOffset, textContent,
  type Block, type BlockType, type ContentFragment,
} from '../domain/block'
import type { EditorStoreHandle } from './storeHandle'
import type { Transaction } from '../domain/operation'
import { $createBlockNode, $createInlineFragmentNode, $isBlockNode, applyMarks } from './blockNode'
import { blocksFromEditorState, inlineTextNodes } from './blockLexicalAdapter'
import { $contentOffset, $selectBlockEnd, caretIsInBlock, currentBlockId } from './caret'
import { handleCodeBlockEnter } from './blockTextOps'
import { decideEmptyEnter, decideListEnter } from './inputRules'
import type { NameRowFacts } from './nameLine'
import type { AiEditorHandle } from './aiBlockOps'
import { $findBlockNode as findBlockNode } from './blockNode'
import { resolveDropDestination, type DropPosition } from './dropTargets'

export type BlockCommandDeps = {
  store: EditorStoreHandle
  editorRef: MutableRefObject<LexicalEditor | null>
  selectedIds: string[]
  activeBlockId: string | null
  activePageId: string | null
  persist: (changedIds: Iterable<string>) => void
  syncEditorChanges: (editor: LexicalEditor, editorState?: ReturnType<LexicalEditor['getEditorState']>) => void
  reloadFromStore: (pageId?: string | null, persistAll?: boolean) => void
  pendingEnterRef: MutableRefObject<Map<string, Block>>
  editorBase: () => Map<string, Block>
}

/**
 * 块级命令（模块化 M1.6）：Enter / 缩进 / 折叠 / 类型转换 / 勾选 / 拖拽 / 上下移 / 插入。
 *
 * 只搬函数体，不重写判据：函数之间的调用关系与原 `EditorShell` 一致；编辑器类型与
 * 领域写入仍通过参数注入，方便后续换成 `EditorHost`。
 */
export function useEditorBlockCommands(deps: BlockCommandDeps) {
  const { store, editorRef, selectedIds, activeBlockId, activePageId, persist, syncEditorChanges, reloadFromStore, pendingEnterRef, editorBase } = deps

  /**
   * 列表的降级出口（docs/04 §3 `R04-ENTER-4` 的另一半）：光标在**有内容的列表项行首**按
   * Backspace → 本项退出列表（变回普通文本块），内容与光标都不动；**再按一次**才轮到原来的
   * 合并 / 跨行逻辑。没有这一步时，项首 Backspace 会把两个列表项并成一个（用户实测 2026-09-30）。
   * 空项不在这里处理：空项的 Backspace 让给既有的「空块合并」通路，语义更自然。
   */
  function onEnter(editor: LexicalEditor): boolean {
    // 代码块里的回车（`R04-ENTER-6`）整段住在 `ui/blockTextOps.ts`（外壳只递依赖——
    // `06` §6「外壳新代码免入」）；不是代码块就落回下面的既有链路。
    if (handleCodeBlockEnter(editor, { store, persist, convertCurrentBlock, flushPendingEnter, syncEditorChanges })) return true
    // 列表项里的回车（docs/04 §3 R04-ENTER-4，用户实测 2026-09-30）：**继续同类型列表项**；
    // 空的列表项则「先逐级外移、回到最外层再按一次退出列表」——退出方式就藏在这条链里。
    // 判据是纯函数 decideListEnter（src/editor/inputRules.ts），这里只执行它的结论。
    {
      const caretId = currentBlockId(editor)
      const caret = caretId ? store.get(caretId) : null
      if (caret && isListType(caret.type)) {
        const parent = caret.parent ? store.get(caret.parent) : null
        const action = decideListEnter({
          isList: true,
          hasText: textContent(caret).trim().length > 0,
          indented: Boolean(parent && !parent.isObject),
        })
        if (action === 'outdent') return outlineMove(editor, 'outdent', caretId!)
        if (action === 'exit') {
          // 退出列表 = 变回普通文本块（内容与光标都不动，也不产生新块）
          convertCurrentBlock(editor, caretId!, 'text')
          return true
        }
      }
    }
    // 大纲惯例：空块再按 Enter 退出缩进——本块升一级，光标留在它开头（用户口径 2026-09-27，
    // `R04-ENTER-3`）。判据在输入规则层（`inputRules.ts` 的 decideEmptyEnter），这里只执行结论：
    // 只在「空块 + 父块是真正的上级块」时生效；页面容器的直接子块已经是一级，按 Enter 仍旧只换行。
    {
      const caretId = currentBlockId(editor)
      const caret = caretId ? store.get(caretId) : null
      const parent = caret?.parent ? store.get(caret.parent) : null
      const action = decideEmptyEnter({
        indented: Boolean(parent && !parent.isObject),
        hasText: caret ? textContent(caret).trim().length > 0 : true,
      })
      if (caret && action === 'outdent') return outlineMove(editor, 'outdent', caretId!)
    }
    const currentBase = editorBase()
    for (const [id, pendingBlock] of pendingEnterRef.current) currentBase.set(id, structuredClone(pendingBlock))
    const current = blocksFromEditorState(editor.getEditorState(), currentBase)
    let currentId: string | null = null
    let offset = 0
    editor.getEditorState().read(() => {
      const selection = $getSelection()
      if (!$isRangeSelection(selection) || selection.anchor.key === 'root') return
      let node = $getNodeByKey(selection.anchor.key)
      while (node && !$isBlockNode(node)) node = node.getParent()
      if ($isBlockNode(node)) {
        currentId = node.getEntityId()
        offset = $contentOffset(node, selection.anchor.key, selection.anchor.offset)
      }
    })
    if (!currentId) return false
    const block = current.get(currentId)
    if (!block) return false
    const [before, after] = splitContentAtOffset(block.content, offset)
    const parent = block.parent ? current.get(block.parent) : block.isObject ? block : undefined
    const parentId = parent?.entityId ?? block.parent
    const newBlock = createTextBlock({
      entityId: crypto.randomUUID(),
      blockUid: `b${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`,
      text: after.map((fragment) => fragment.v).join(''),
      parent: parentId,
    })
    newBlock.content = after
    // 「继续列表」：列表项拆出来的新块沿用同一个类型（待办恒为未勾选；AI 不会替用户改勾选态）。
    if (isListType(block.type)) {
      newBlock.type = block.type
      newBlock.checked = false
    }
    // 对象块拥有子段落：从对象块自身文字拆分时，新段落应排在子块之前。
    pendingEnterRef.current.set(newBlock.entityId, structuredClone(newBlock))
    let didApply = false
    editor.update(() => {
      const currentNode = findBlockNode(block.entityId)
      if (!currentNode) {
        pendingEnterRef.current.delete(newBlock.entityId)
        return
      }
      didApply = true
      const childBlocks = currentNode.getChildren().filter($isBlockNode)
      for (const child of currentNode.getChildren()) child.remove()
      for (const fragment of before) {
        const textNode = fragment.t === 'text' ? $createTextNode(fragment.v) : $createInlineFragmentNode(fragment)
        applyMarks(textNode, fragment.marks)
        currentNode.append(textNode)
      }
      const nextNode = $createBlockNode(newBlock)
      for (const fragment of after) {
        const textNode = fragment.t === 'text' ? $createTextNode(fragment.v) : $createInlineFragmentNode(fragment)
        applyMarks(textNode, fragment.marks)
        nextNode.append(textNode)
      }
      if (parentId === block.entityId) {
        currentNode.append(nextNode)
        for (const child of childBlocks) currentNode.append(child)
      } else {
        for (const child of childBlocks) currentNode.append(child)
        currentNode.insertAfter(nextNode)
      }
      nextNode.selectStart()
    }, { tag: [HISTORIC_TAG, 'moqi-enter'], discrete: true })
    if (!didApply) return false
    setTimeout(() => {
      if (pendingEnterRef.current.has(newBlock.entityId)) syncEditorChanges(editor, editor.getEditorState())
    }, 0)
    return true
  }

  function outlineMove(editor: LexicalEditor, direction: 'indent' | 'outdent', blockId?: string) {
    const target = blockId ?? currentBlockId(editor)
    if (!target) return true
    if (!flushPendingEnter(editor, target)) return true
    const before = store.get(target)
    if (!before) return true
    const changed = direction === 'indent' ? store.indent(target) : store.outdent(target)
    if (!changed) return true
    const after = store.get(target)
    if (!after) return true
    const keepCaret = caretIsInBlock(editor, target)
    editor.update(() => {
      const node = findBlockNode(target)
      if (!node) return
      if (direction === 'indent') {
        const previous = node.getPreviousSibling()
        if ($isBlockNode(previous)) previous.append(node)
      } else {
        const parent = node.getParent()
        if ($isBlockNode(parent)) parent.insertAfter(node)
      }
      if (!keepCaret) node.selectStart()
    }, { tag: [HISTORIC_TAG, 'moqi-outline'], discrete: true })
    const changedIds = new Set<string>([target])
    if (before.parent) changedIds.add(before.parent)
    if (after.parent) changedIds.add(after.parent)
    persist(changedIds)
    return true
  }

  function toggleCollapse(editor: LexicalEditor, blockId: string) {
    if (!flushPendingEnter(editor, blockId)) return
    const block = store.get(blockId)
    if (!block || block.children.length === 0) return
    const collapsed = !block.collapsed
    store.apply({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      source: 'user',
      operations: [{ type: 'collapse', opId: crypto.randomUUID(), blockId, collapsed }],
    })
    editor.update(() => {
      const node = findBlockNode(blockId)
      if (node) node.setCollapsed(collapsed)
    }, { tag: [HISTORIC_TAG, 'moqi-collapse'], discrete: true })
    persist([blockId])
  }

  /**
   * 类型转换：一次事务保留 identity、行内内容、子块、引用、标签与属性。
   * `nextText` 只在斜杠菜单里用，用来丢掉触发词（`/标题`）；不给就原样保留正文——
   * 早先这里固定传空内容，转换类型会把整块文字清空（docs/04 §4「不应丢字」）。
   */
  function convertCurrentBlock(editor: LexicalEditor, blockId: string, type: BlockType, nextText?: string, options: { checked?: boolean } = {}) {
    if (!flushPendingEnter(editor, blockId)) return
    const block = store.get(blockId)
    if (!block) return
    const content: ContentFragment[] = nextText === undefined ? block.content : nextText.length > 0 ? [{ t: 'text', v: nextText }] : []
    const affected = store.convertType(blockId, type, content, { checked: options.checked })
    if (!affected) return
    if (type === 'divider') {
      // 转分隔线时**正文会被域层挪到紧随其后的新 `text` 块**（`02` §「类型转换」）。编辑器这边不能
      // 只改当前这一个节点：镜像随后会把正文写回分隔线里（线上留着字、下面还重复一份），新块也看不见
      // ——2026-10-03 实测。整篇重建一次（与撤销 / AI 落点同一条路）最省事，也顺带把新块摆出来。
      reloadFromStore()
      return
    }
    const keepCaret = caretIsInBlock(editor, blockId)
    editor.update(() => {
      const node = findBlockNode(blockId)
      if (!node) return
      if (nextText !== undefined) {
        for (const child of node.getChildren()) if (!$isBlockNode(child)) child.remove()
        if (nextText.length > 0) node.append($createTextNode(nextText))
      }
      node.setBlockType(type)
      // 勾选态**必须同步到编辑节点**（`R09-MD-3` 的 `[x] ` 打字触发）：域层这一次事务里已经把
      // `checked` 定好了（`convertBlockType` 的 `nextChecked`），但节点上的 `__checked` 还是旧值——
      // 镜像随后把节点写回领域，`checked: true` 就被冲成 false（真窗口实测：`[x] ` 敲出来落库是未勾）。
      if (options.checked !== undefined) node.setChecked(options.checked)
      // 斜杠菜单（内容换成丢掉触发词后的正文）光标落到文末——触发词本来就是在文末敲的；
      // 格式栏 / 工具栏转换不动光标（光标就在这个块里时按原地保留）。
      if (nextText !== undefined) node.selectEnd()
      else if (!keepCaret) node.selectStart()
    }, { tag: [HISTORIC_TAG, 'moqi-type'], discrete: true })
    const changedIds = new Set(affected)
    if (block.parent) changedIds.add(block.parent)
    persist(changedIds)
  }

  /**
   * 用纯文本替换块的行内内容（斜杠菜单丢弃触发词、标签转换等共用）。
   *
   * `mirror: true` 只给**不是用户动作**的写回用（AI 流式生成按节拍写回正文，docs/04 §5）：
   * 镜像进领域、不占撤销栈，否则一次生成会留下几十条撤销记录。
   */
  function replaceBlockText(editor: AiEditorHandle | null, blockId: string, text: string, options: { selectEnd?: boolean; mirror?: boolean } = {}) {
    const block = store.get(blockId)
    if (!block) return
    const affected = store.convertType(blockId, block.type, text.length > 0 ? [{ t: 'text', v: text }] : [], { mirror: options.mirror })
    if (!affected) return
    editor?.update(() => {
      const node = findBlockNode(blockId)
      if (!node) return
      for (const child of node.getChildren()) if (!$isBlockNode(child)) child.remove()
      // 代码块的文本走**带换行拆分**的那条构节点路径（与适配器同一份 `inlineTextNodes`）：
      // 含 `\n` 的正文（AI 流式、撤销重放、恢复）在编辑器里也落成 `<br>`，与手敲出来的形态一致。
      for (const child of inlineTextNodes(text, block.type === 'code')) node.append(child)
      if (options.selectEnd !== false) node.selectEnd()
    }, { tag: [HISTORIC_TAG, 'moqi-text'], discrete: true })
    persist(affected)
  }

  function toggleChecked(editor: LexicalEditor, blockId: string) {
    if (!flushPendingEnter(editor, blockId)) return
    const block = store.get(blockId)
    if (!block || block.type !== 'todo') return
    const checked = !block.checked
    store.apply({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      source: 'user',
      operations: [{ type: 'update', opId: crypto.randomUUID(), blockId, changes: { checked }, previous: { checked: block.checked } }],
    })
    editor.update(() => {
      const node = findBlockNode(blockId)
      if (node) node.setChecked(checked)
    }, { tag: [HISTORIC_TAG, 'moqi-check'], discrete: true })
    persist([blockId])
  }

  /**
   * 光标 / 选区在当前块里的**领域落点**（`$contentOffset` 口径，与领域 `content` 的字符偏移一致）；
   * 不在行内文字里时返回 null。三个入口（⌘L / 斜杠 / 粘贴纯 URL）共用这一份量法。
   */
  function caretRangeInBlock(editor: LexicalEditor): { blockId: string; offset: number; length: number; text: string } | null {
    let facts: { blockId: string; offset: number; length: number; text: string } | null = null
    editor.getEditorState().read(() => {
      const selection = $getSelection()
      if (!$isRangeSelection(selection) || selection.anchor.key === 'root') return
      let node: LexicalNode | null = $getNodeByKey(selection.anchor.key)
      while (node && !$isBlockNode(node)) node = node.getParent()
      if (!$isBlockNode(node)) return
      const anchor = $contentOffset(node, selection.anchor.key, selection.anchor.offset)
      const focus = $contentOffset(node, selection.focus.key, selection.focus.offset)
      facts = {
        blockId: node.getEntityId(),
        offset: Math.min(anchor, focus),
        length: Math.abs(anchor - focus),
        text: selection.getTextContent(),
      }
    })
    return facts as { blockId: string; offset: number; length: number; text: string } | null
  }

  function handleMove(editor: LexicalEditor, dragId: string, targetId: string, position: DropPosition) {
    const dragged = store.get(dragId)
    if (!dragged) return
    // 落点规则收敛到纯函数（src/ui/dropTargets.ts）：自身/后代、根块的前后都是无效落点。
    const destination = resolveDropDestination(store.read(), dragId, targetId, position)
    if (!destination) return
    const { parentId: newParentId, index: newIndex } = destination
    const beforeParent = dragged.parent
    if (!store.move(dragId, newParentId, newIndex)) return
    const after = store.get(dragId)!
    const keepCaret = caretIsInBlock(editor, dragId)
    editor.update(() => {
      const node = findBlockNode(dragId)
      const targetNode = findBlockNode(targetId)
      if (!node || !targetNode) return
      if (position === 'into') targetNode.append(node)
      else if (position === 'before') targetNode.insertBefore(node)
      else targetNode.insertAfter(node)
      if (!keepCaret) node.selectStart()
    }, { tag: [HISTORIC_TAG, 'moqi-move'], discrete: true })
    const changedIds = new Set<string>([dragId, targetId])
    if (beforeParent) changedIds.add(beforeParent)
    if (after.parent) changedIds.add(after.parent)
    persist(changedIds)
  }

  /**
   * 块上移 / 下移（`R09-BEDIT-12` / `R09-KEY-20`）：**同级内**按文档序移动一格，到边界 no-op；
   * 键盘一次动一块——多块整组移动走拖拽（`R09-BEDIT-2` 已交付的那条路）。
   */
  function moveBlocksStep(direction: -1 | 1) {
    const targets = selectedIds.length > 0 ? selectedIds : activeBlockId ? [activeBlockId] : []
    if (targets.length > 1) return
    if (targets.length === 1) moveBlockStepById(targets[0], direction)
  }

  /** 单块同级移动一格：复用拖拽的落点规则与事务（一次移动 = 一次事务、一步撤销）。 */
  function moveBlockStepById(blockId: string, direction: -1 | 1) {
    const editor = editorRef.current
    if (!editor) return
    const block = store.get(blockId)
    if (!block?.parent) return
    const siblings = store.get(block.parent)?.children ?? []
    const index = siblings.indexOf(blockId)
    const neighbor = index < 0 ? undefined : direction === -1 ? siblings[index - 1] : siblings[index + 1]
    if (!neighbor) return
    handleMove(editor, blockId, neighbor, direction === -1 ? 'before' : 'after')
  }

  /** 在指定块下方插入同级块（把手行尾 ＋）。 */
  function insertSibling(editor: LexicalEditor, blockId: string, where: 'above' | 'below' = 'below') {
    // ＋ 的插入下标来自领域（父块 children 里本块的位置）：先折进 pending Enter，否则下标落到 0，空块会插到本块**上面**。
    if (!flushPendingEnter(editor, blockId)) return
    const anchor = store.get(blockId)
    if (!anchor) return
    const parentId = anchor.parent
    const step = where === 'above' ? 0 : 1
    const index = parentId === null
      ? orderedRootIds(store.read()).indexOf(blockId) + step
      : (store.get(parentId)?.children.indexOf(blockId) ?? -1) + step
    const block = createTextBlock({
      entityId: crypto.randomUUID(),
      blockUid: `b${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`,
      parent: parentId,
    })
    if (where === 'below' && anchor.isObject && parentId === null) {
      // 页面块行尾 ＋ 在页面内部新建段落，保证新增内容仍属于本页。
      block.parent = anchor.entityId
      store.apply({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: 'user',
        operations: [{ type: 'insert', opId: crypto.randomUUID(), block, parentId: anchor.entityId, index: anchor.children.length }],
      })
    } else {
      store.apply({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: 'user',
        operations: [{ type: 'insert', opId: crypto.randomUUID(), block, parentId, index }],
      })
    }
    editor.update(() => {
      const node = findBlockNode(blockId)
      const newNode = $createBlockNode(block)
      if (!node) return
      if (block.parent === anchor.entityId) {
        node.append(newNode)
      } else if (where === 'above') {
        node.insertBefore(newNode)
      } else {
        node.insertAfter(newNode)
      }
      newNode.selectStart()
    }, { tag: [HISTORIC_TAG, 'moqi-insert'], discrete: true })
    persist([block.entityId, blockId])
  }

  function insertBlockOfType(editor: LexicalEditor, kind: 'todo' | 'quote' | 'code' | 'text' | 'divider', seedText?: string, afterId?: string) {
    const target = afterId ?? currentBlockId(editor)
    if (!target) return
    const anchor = store.get(target)
    if (!anchor) return
    const block = createTextBlock({
      entityId: crypto.randomUUID(),
      blockUid: `b${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`,
      parent: anchor.parent,
    })
    block.type = kind
    if (seedText) block.content = [{ t: 'text', v: seedText }]
    const parentId = anchor.parent
    const index = parentId === null
      ? orderedRootIds(store.read()).indexOf(target) + 1
      : (store.get(parentId)?.children.indexOf(target) ?? -1) + 1
    store.apply({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      source: 'user',
      operations: [{ type: 'insert', opId: crypto.randomUUID(), block, parentId, index }],
    })
    editor.update(() => {
      const node = findBlockNode(target)
      if (!node) return
      const newNode = $createBlockNode(block)
      node.insertAfter(newNode)
      // 带种子的插入（今天 / 现在）：文字要显式灌进节点（$createBlockNode 只管结构、不收 content）；光标落日期后。
      if (seedText) { for (const child of inlineTextNodes(seedText, true)) newNode.append(child); $selectBlockEnd(newNode) } else newNode.selectStart()
    }, { tag: [HISTORIC_TAG, 'moqi-insert'], discrete: true })
    persist([block.entityId, target])
  }

  /**
   * 结构操作（缩进 / 反缩进 / 转换类型 / 折叠 / 勾选 / 拖拽 / ＋ 插入）前把「还没折进领域的 Enter 新块」先落库。
   * Enter 建块走 pendingEnterRef（等编辑器提交后再写回领域），所以刚回车出来的块在领域里还不存在：
   * 此时按 ⇧Tab / 点 ＋ 会静默失效（用户实测「取消缩进没反应」的一种来源）。
   */
  function flushPendingEnter(editor: LexicalEditor, targetId: string): boolean {
    if (!pendingEnterRef.current.has(targetId)) return true
    syncEditorChanges(editor)
    return store.get(targetId) !== undefined
  }

  /**
   * 名字行那处接缝要知道的**领域事实**（`editor/nameLine.ts` 不认识 store，由外壳读出来递进去）。
   * 不是页面（容器）就没有名字行，返回 null。
   */
  function nameRowFacts(): NameRowFacts | null {
    const container = activePageId ? store.get(activePageId) : undefined
    if (!container?.isObject) return null
    return { containerId: container.entityId, firstChildId: container.children[0] ?? null }
  }


  return {
    onEnter, outlineMove, toggleCollapse, convertCurrentBlock, replaceBlockText, toggleChecked, caretRangeInBlock,
    handleMove, moveBlocksStep, moveBlockStepById, insertSibling, insertBlockOfType,
    flushPendingEnter, nameRowFacts,
  }
}
