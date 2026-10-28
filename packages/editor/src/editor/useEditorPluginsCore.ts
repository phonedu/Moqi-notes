import { useEffect } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $createTextNode, $getSelection, $isElementNode, $isRangeSelection, COMMAND_PRIORITY_HIGH, COMMAND_PRIORITY_NORMAL,
  HISTORIC_TAG, INSERT_LINE_BREAK_COMMAND, KEY_ARROW_LEFT_COMMAND, KEY_ARROW_RIGHT_COMMAND, KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND, KEY_DOWN_COMMAND, KEY_ENTER_COMMAND, KEY_TAB_COMMAND, MOVE_TO_END, MOVE_TO_START,
  PASTE_COMMAND, RootNode, TextNode,
} from 'lexical'
import type { LexicalEditor, LexicalNode, TextFormatType } from './editorTypes'
import type { BlockMarker, OutlineDraft } from '../domain/mdSyntax'
import { parseMarkdownDocument, parseMarkdownOutline } from '../domain/mdSyntax'
import { INLINE_TEXT_FORMAT, decideBareUrlPaste, decideBlockMarkerTrigger, decideInlinePairTrigger, decideTab } from './inputRules'
import { registerNameLineAnchor } from './nameLine'
import { currentBlockId } from './caret'
import { $adoptRootContent } from './blockLexicalAdapter'
import { $findBlockNode, $isBlockNode, $trimInlineRef, InlineFragmentNode } from './blockNode'
import { newBlockUid } from '../domain/typeOps'
import { useStableCallback } from './useStableCallback'
import type { BlockType } from '../domain/block'

export type EditorPluginsCoreProps = {
  enabled: boolean
  onEnter: (editor: LexicalEditor) => boolean
  onLeaveList: (editor: LexicalEditor, event: KeyboardEvent) => boolean
  onIndent: (editor: LexicalEditor, blockId: string) => boolean
  onOutdent: (editor: LexicalEditor, blockId: string) => boolean
  onToggleCollapse: (editor: LexicalEditor, blockId: string) => void
  onMoveStep: (direction: -1 | 1) => void
  onJumpRef: (blockId: string) => void
  onOpenExternal: (url: string) => void
  onPasteUrl: (url: string) => void
  onPasteOutline: (anchorId: string, drafts: OutlineDraft[]) => void
  /** 粘贴截图 / 图片文件（M5：**可选**——缺席 = 不拦截该粘贴支路，截图落到默认行为；媒体能力关闭时宿主传 undefined）。 */
  onPasteMedia?: (file: File) => void
  onMarkerTrigger: (blockId: string, marker: BlockMarker) => void
  onActiveBlock: (blockId: string | null) => void
  onEditor: (editor: LexicalEditor | null) => void
  onToggleFormat: (format: TextFormatType) => void
  onAdoptRoot: (containerBlockId: string, items: { entityId: string; blockUid: string }[]) => void
  onNameRowCross: (editor: LexicalEditor, options: { backward: boolean; deletes: boolean }) => boolean
  onSelectNameRow: (containerId: string | null) => boolean
  onNameRowEdge: (editor: LexicalEditor, end: boolean) => boolean
  touchCompact: boolean
  touchEditId: string | null
}

/**
 * 编辑器输入 / 结构键的 Lexical 编排（模块化 M2）：Enter、Tab、Backspace、名字行接缝、
 * 粘贴、根级收编、MD 打字触发与行内引用不变式。UI 组件只组合可见插件。
 */
export function useEditorPluginsCore(props: EditorPluginsCoreProps): LexicalEditor {
  const {
    enabled, onEnter, onLeaveList, onIndent, onOutdent, onToggleCollapse, onMoveStep, onToggleFormat,
    onJumpRef, onOpenExternal, onPasteUrl, onPasteOutline, onPasteMedia, onMarkerTrigger, onAdoptRoot,
    onNameRowCross, onSelectNameRow, onNameRowEdge, onEditor, onActiveBlock, touchCompact, touchEditId,
  } = props
  const [editor] = useLexicalComposerContext()

  /**
   * 回调一律走稳定包装，下面的 effect **只注册一次**。
   *
   * 为什么必须有（2026-09-28 实测，用户现象「标题点不进去」）：父组件用内联箭头传回调，
   * 每次渲染都是新引用；effect 把它们放进依赖数组 → 每次渲染都重新 `registerNodeTransform`
   * → Lexical 会把该类型的节点标脏并**触发一次 `editor.update`** → 这次更新的 selection 提交
   * 走到 `$updateDOMSelection`，在「焦点不在编辑器里」（用户点了页面标题）时会把焦点
   * **抢回正文**：标题刚拿到焦点就被弹走。任何「注册型」的编辑器 effect 都适用这条：
   * 注册一次 + 回调取最新值（docs/04 §7、docs/06 §4.1「单一所有者」）。
   */
  const enter = useStableCallback(onEnter)
  const leaveList = useStableCallback(onLeaveList)
  const indent = useStableCallback(onIndent)
  const outdent = useStableCallback(onOutdent)
  const toggleCollapse = useStableCallback(onToggleCollapse)
  const moveStep = useStableCallback(onMoveStep)
  const toggleFormat = useStableCallback(onToggleFormat)
  const jumpRef = useStableCallback(onJumpRef)
  const openExternal = useStableCallback(onOpenExternal)
  const pasteUrl = useStableCallback(onPasteUrl)
  const pasteOutline = useStableCallback(onPasteOutline)
  const pasteMedia = useStableCallback((file: File) => { onPasteMedia?.(file) })
  const markerTrigger = useStableCallback(onMarkerTrigger)
  const adoptRoot = useStableCallback(onAdoptRoot)
  const nameRowCross = useStableCallback(onNameRowCross)
  const selectNameRowStable = useStableCallback(onSelectNameRow)
  const nameRowEdgeStable = useStableCallback(onNameRowEdge)

  useEffect(() => {
    onEditor(editor)
    onActiveBlock(currentBlockId(editor))
    const unregister = editor.registerUpdateListener(() => onActiveBlock(currentBlockId(editor)))
    return () => { unregister(); onEditor(null) }
    // 编辑器实例只创建一次（视图切换不重挂载）。
  }, [editor]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => editor.registerCommand(KEY_ENTER_COMMAND, () => (enabled ? enter(editor) : false), COMMAND_PRIORITY_HIGH), [editor, enabled, enter])

  // 软换行从根上取消（`04` §3 `R04-ENTER-5`，W6 2026-10-10 裁决）：**块内换行只允许出现在代码块**。
  // 输入侧两道：
  // ① Ctrl+O —— Lexical 在 **macOS** 把 `Ctrl+O` 映射成「插入 LineBreakNode」（LexicalEvents 的
  //    IS_APPLE 分支，自己 preventDefault）；这里在 KEY_DOWN_COMMAND 层（HIGH，先于 Lexical 内建的
  //    快捷键表）拦掉，**行为与 Enter 同义**（普通块拆块、代码块插换行——同一个 enter() 入口）；
  // ② INSERT_LINE_BREAK_COMMAND 兜底 —— 任何残余通路（输入法的 `insertText: '\n'` 等）都停在输入侧：
  //    适配器不序列化 LineBreakNode（插进去就丢），所以它从根上不存在。
  useEffect(() => {
    if (!enabled) return
    return editor.registerCommand(KEY_DOWN_COMMAND, (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'o' || !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return false
      if (event.isComposing || editor.isComposing()) return false
      event.preventDefault()
      return enter(editor)
    }, COMMAND_PRIORITY_HIGH)
  }, [editor, enabled, enter])

  // `INSERT_LINE_BREAK_COMMAND` 的守门：**只允许落脚在代码块里**（`R04-ENTER-6`，W6 机制 A，
  // 2026-10-10 定案；此前是"全拦"——那让代码块的换行也进不来）。非代码块一律吃掉（「块内换行只允许
  // 出现在代码块」）；代码块里放行给 Lexical 的默认处理器（`selection.insertLineBreak()`，
  // 与 `onEnter` 的新行动作同源）。
  useEffect(() => editor.registerCommand(INSERT_LINE_BREAK_COMMAND, () => {
    const blockId = currentBlockId(editor)
    if (!blockId) return true
    return editor.getEditorState().read(() => $findBlockNode(blockId)?.getBlockType() !== 'code')
  }, COMMAND_PRIORITY_HIGH), [editor])


  useEffect(() => {
    if (!enabled) return
    return editor.registerCommand(KEY_TAB_COMMAND, (event: KeyboardEvent) => {
      // Lexical 不会替 Tab 阻止默认行为（见 src/editor/inputRules.ts）：不 preventDefault 的话，
      // 浏览器会接着按「Tab 移动焦点」处理，⇧Tab 把焦点丢给页面标题并把正文滚回顶部。
      const tabBlockId = currentBlockId(editor)
      const tabInCode = editor.getEditorState().read(() => (tabBlockId ? $findBlockNode(tabBlockId)?.getBlockType() === 'code' : false))
      const decision = decideTab({
        blockId: tabBlockId,
        shiftKey: event.shiftKey,
        composing: event.isComposing || editor.isComposing(),
        inCode: tabInCode,
      })
      if (decision.kind === 'browser') return false
      event.preventDefault()
      if (decision.kind === 'code-text') {
        // 代码块内：Tab 插两个空格、⇧Tab 删当前行行首最多两个空格（「行」按换行符切分）。
        editor.update(() => {
          const selection = $getSelection()
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return
          const anchor = selection.anchor
          const point = anchor.getNode()
          // 光标可能落在**元素点**上（代码块按 `<br>` 分行，行尾/空白行处 anchor.type === 'element'）——
          // 这时取相邻的文本节点（前兄弟接尾、后兄弟接头），别直接放弃。
          let node: TextNode | null = point instanceof TextNode ? point : null
          let offset = anchor.offset
          if (!node && $isElementNode(point)) {
            const prev = (point.getChildAtIndex(offset)?.getPreviousSibling() ?? point.getLastChild())
            if (prev instanceof TextNode) { node = prev; offset = prev.getTextContentSize() }
          }
          if (!node) return
          const text = node.getTextContent()
          // 用「设选区 + insertText / removeText」而不是手改 `anchor.offset`——后者会把选区点弄脏，
          // 紧接着的下一次按键就读到过期偏移（探针实测：Tab 之后的 ⇧Tab 失效）。
          if (!decision.shiftKey) {
            selection.setTextNodeRange(node, offset, node, offset)
            selection.insertText('  ')
            return
          }
          const newline = String.fromCharCode(10)
          const lineStart = text.lastIndexOf(newline, Math.max(0, offset - 1)) + 1
          const lead = text.slice(lineStart, lineStart + 2)
          const removable = lead.startsWith('  ') ? 2 : lead.startsWith(' ') ? 1 : 0
          if (removable === 0) return
          selection.setTextNodeRange(node, lineStart, node, lineStart + removable)
          selection.removeText()
        }, { discrete: true })
        return true
      }
      return decision.kind === 'indent' ? indent(editor, decision.blockId) : outdent(editor, decision.blockId)
    }, COMMAND_PRIORITY_HIGH)
  }, [editor, enabled, indent, outdent])

  // 点击空名字行：占位是脱离文档流的装饰，空名字行里没有可停留的文本，浏览器会把这一带的点击
  // 解析到下面第一个块（用户实测的四条症状之一）。判定只看点击目标是不是容器元素本身，不看坐标。
  useEffect(() => {
    if (!enabled) return
    const onClick = (event: MouseEvent) => {
      // 触控只读态（`10` §6.3）：单击无操作——名字行的落光标只在编辑态里做。
      if (touchCompact && touchEditId === null) return
      const target = event.target instanceof HTMLElement ? event.target : null
      const blockElement = target?.closest<HTMLElement>('.moqi-block')
      if (!blockElement || blockElement.dataset.blockObject !== 'true') return
      selectNameRowStable(blockElement.dataset.entityId ?? null)
    }
    return editor.registerRootListener((rootElement, previousElement) => {
      if (previousElement) previousElement.removeEventListener('click', onClick)
      if (rootElement) rootElement.addEventListener('click', onClick)
    })
  }, [editor, enabled, selectNameRowStable, touchCompact, touchEditId])

  // 名字行与第一个子块那处接缝的光标跨越（`04` §3.1 R04-NAME-12）：锚点会挡住 Lexical 沿
  // 「上一个节点」做的光标移动与合并，这四个方向必须显式补。Shift 组合（扩展选区）让给 Lexical，
  // 判定与动作都在 `crossNameRow`（纯函数 `decideNameRowCross` 只判「整行边界」）。
  useEffect(() => {
    if (!enabled) return
    const cross = (event: KeyboardEvent, options: { backward: boolean; deletes: boolean }): boolean => {
      if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false
      if (!nameRowCross(editor, options)) return false
      event.preventDefault()
      return true
    }
    const unregisterLeaveList = editor.registerCommand(KEY_BACKSPACE_COMMAND, (event: KeyboardEvent) => (enabled ? leaveList(editor, event) : false), COMMAND_PRIORITY_HIGH)
    const unregisterBackspace = editor.registerCommand(KEY_BACKSPACE_COMMAND, (event: KeyboardEvent) => cross(event, { backward: true, deletes: true }), COMMAND_PRIORITY_HIGH)
    const unregisterDelete = editor.registerCommand(KEY_DELETE_COMMAND, (event: KeyboardEvent) => cross(event, { backward: false, deletes: true }), COMMAND_PRIORITY_HIGH)
    const unregisterLeft = editor.registerCommand(KEY_ARROW_LEFT_COMMAND, (event: KeyboardEvent) => cross(event, { backward: true, deletes: false }), COMMAND_PRIORITY_HIGH)
    const unregisterRight = editor.registerCommand(KEY_ARROW_RIGHT_COMMAND, (event: KeyboardEvent) => cross(event, { backward: false, deletes: false }), COMMAND_PRIORITY_HIGH)
    // Home / End：光标在名字行时不交给 Lexical 算「行尾」（它会算到锚点之后，见 decideNameRowEdge）。
    const edge = (event: KeyboardEvent, end: boolean): boolean => {
      if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false
      if (!nameRowEdgeStable(editor, end)) return false
      event.preventDefault()
      return true
    }
    const unregisterHome = editor.registerCommand(MOVE_TO_START, (event: KeyboardEvent) => edge(event, false), COMMAND_PRIORITY_HIGH)
    const unregisterEnd = editor.registerCommand(MOVE_TO_END, (event: KeyboardEvent) => edge(event, true), COMMAND_PRIORITY_HIGH)
    return () => { unregisterLeaveList(); unregisterBackspace(); unregisterDelete(); unregisterLeft(); unregisterRight(); unregisterHome(); unregisterEnd() }
  }, [editor, enabled, nameRowCross, nameRowEdgeStable])

  useEffect(() => {
    if (!enabled) return
    // ⌘↑ / Ctrl+↑ 折叠子树。注意：Lexical 的 KEY_ARROW_UP_COMMAND 只在按住 Shift/Alt 时才派发，
    // 用它监听纯 ⌘↑ 会变成永不触发的死代码，所以这里用 KEY_DOWN_COMMAND。
    return editor.registerCommand(KEY_DOWN_COMMAND, (event: KeyboardEvent) => {
      if (event.key !== 'ArrowUp' || event.shiftKey || event.altKey) return false
      if (!event.metaKey && !event.ctrlKey) return false
      const blockId = currentBlockId(editor)
      if (!blockId) return false
      event.preventDefault()
      toggleCollapse(editor, blockId)
      return true
    }, COMMAND_PRIORITY_HIGH)
  }, [editor, enabled, toggleCollapse])

  useEffect(() => {
    if (!enabled) return
    // ⌘⇧↑ / ⌘⇧↓ 块上移 / 下移（`R09-BEDIT-12` / `R09-KEY-20`）：与 ⌘↑ 折叠同一条路——
    // Lexical 的 KEY_ARROW_UP / DOWN 命令只在 Shift/Alt 下派发、且会先动选区，所以用 KEY_DOWN_COMMAND 先接。
    return editor.registerCommand(KEY_DOWN_COMMAND, (event: KeyboardEvent) => {
      if ((event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || !event.shiftKey || event.altKey) return false
      if (!event.metaKey && !event.ctrlKey) return false
      event.preventDefault()
      moveStep(event.key === 'ArrowUp' ? -1 : 1)
      return true
    }, COMMAND_PRIORITY_HIGH)
  }, [editor, enabled, moveStep])

  // ⌘⇧S 删除线 / ⌘⇧H 高亮：RichTextPlugin 只默认绑定加粗与斜体。
  // 与常驻格式栏同一个作用域（docs/09 §6.9）：折叠光标上就是「接下来输入的字」的格式，
  // 有选区时作用在选区——两者都是 Lexical `formatText` 的原生语义，这里不做折叠判断。
  useEffect(() => {
    if (!enabled) return
    return editor.registerCommand(KEY_DOWN_COMMAND, (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return false
      const key = event.key.toLowerCase()
      const format: TextFormatType | null = key === 's' ? 'strikethrough' : key === 'h' ? 'highlight' : null
      if (!format) return false
      event.preventDefault()
      // 与常驻格式栏同一个入口（三层作用域见 src/editor/formatState.ts）：折叠光标 = 接下来输入的字，
      // 有选区 = 作用在选区。命令只在 [editor, enabled] 变化时重注册，走 props 拿当前渲染的入口。
      toggleFormat(format)
      return true
    }, COMMAND_PRIORITY_NORMAL)
  }, [editor, enabled, toggleFormat])

  // ⌘U 下划线（`R09-KEY-24`，0.5 新增）：Lexical 的 RichTextPlugin 只默认绑定加粗与斜体，
  // 下划线要自己接（与 ⌘⇧S / ⌘⇧H / ⌘E 同一条路：`toggleFormat` = 格式栏同一个入口）。
  useEffect(() => {
    if (!enabled) return
    return editor.registerCommand(KEY_DOWN_COMMAND, (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return false
      if (event.key.toLowerCase() !== 'u') return false
      event.preventDefault()
      toggleFormat('underline')
      return true
    }, COMMAND_PRIORITY_NORMAL)
  }, [editor, enabled, toggleFormat])

  // ⌘E 行内代码：补齐格式栏五件套的快捷键（加粗 ⌘B / 斜体 ⌘I 由 RichTextPlugin 提供，
  // 删除线 ⌘⇧S / 高亮 ⌘⇧H 见上，行内代码原先没有键）。docs/09 §六 R09-KEY-19。
  useEffect(() => {
    if (!enabled) return
    return editor.registerCommand(KEY_DOWN_COMMAND, (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return false
      if (event.key.toLowerCase() !== 'e') return false
      event.preventDefault()
      toggleFormat('code')
      return true
    }, COMMAND_PRIORITY_NORMAL)
  }, [editor, enabled, toggleFormat])

  // 正文里的行内引用跳转（点击 [[ ]] / (( )) 直接跳转）。折叠箭头与待办勾选已改为装饰层的真实按钮，
  // 不再用「块的横坐标落在某个区间」这种方式判定，避免和多选/把手/输入抢命中。
  useEffect(() => {
    if (!enabled) return
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      // 外部链接优先：`.el` 上没有 data-ref-target，两者不会撞（R09-ELINK-3）。
      const external = target?.closest<HTMLElement>('[data-url]')
      const externalUrl = external?.dataset.url
      if (externalUrl) { event.preventDefault(); openExternal(externalUrl); return }
      const element = target?.closest<HTMLElement>('[data-ref-target]')
      const targetId = element?.dataset.refTarget
      if (!targetId) return
      event.preventDefault()
      jumpRef(targetId)
    }
    // 根元素由 Lexical 在挂载后提供，用 rootListener 保证监听器总是挂在正确的节点上。
    return editor.registerRootListener((rootElement, previousElement) => {
      if (previousElement) previousElement.removeEventListener('click', onClick)
      if (rootElement) rootElement.addEventListener('click', onClick)
    })
  }, [editor, enabled, jumpRef])

  // 触控编辑层的效果与三件浮动面都在 `useTouchEditorLayer` 里（2026-10-11 体量门拆模块）。

  // 粘贴纯 URL → 当场变外部链接（`R09-ELINK-4` / `04` `R04-PASTE-1`）：判据在输入规则层，
  // 写入走与对话框**同一条命令入口**；其余粘贴（含 `[文字](url)` 语法）一律按普通文本进来。
  // 一次撤销回到纯文本（领域一步事务），不抢菜单、IME 组合态不触发。
  //
  // MD 输入层 · 粘贴侧（`R09-MD-3`，2026-10-06）：整段像是 Markdown 大纲（含记号行）时，
  // 解析成草稿树**一个事务**插到光标块之后（`R09-MD-4.4`：一次撤销整批退掉）；
  // 记号表与导出侧的转义共用一份（`domain/mdSyntax`），`\-` 读回字面——导出 → 粘贴的往返无歧义。
  // 打字侧（打 `- ` / `# ` / 行内成对即转）还没有；`R09-MD-4.5`（不抢菜单）在打字侧才需要管。
  useEffect(() => {
    if (!enabled) return
    return editor.registerCommand(PASTE_COMMAND, (event) => {
      if (editor.isComposing()) return false
      // PASTE_COMMAND 的载荷是 ClipboardEvent | InputEvent：没有 clipboardData 的那支直接放行。
      const clipboardData = 'clipboardData' in event ? event.clipboardData : null
      // 粘贴截图（13-媒体设计（已归档） §4 的 spike ②）：剪贴板里有图就直接落图片块（截图是最高频的贴图路径）
      const imageFile = [...(clipboardData?.items ?? [])].find((item) => item.kind === 'file' && item.type.startsWith('image/'))?.getAsFile() ?? null
      if (imageFile && pasteMedia) {
        event.preventDefault()
        pasteMedia(imageFile)
        return true
      }
      // 换行统一成 `\n`（Windows 剪贴板给 `\r\n`，旧 Mac 给 `\r`）——后面所有支路（URL / 引用 / 大纲 /
      // 行内直写）都按同一份文本判断与落库，块正文里不出现 `\r`。
      const text = (clipboardData?.getData('text/plain') ?? '').replace(/\r\n?/g, '\n')
      const url = decideBareUrlPaste(text)
      if (url) {
        event.preventDefault()
        pasteUrl(url)
        return true
      }
      // 锚点取光标所在块；拿不到就当普通粘贴（别猜）。锚点在**代码块**里时多行文本不拆块——整段
      // 代码带 `\n` 进同一个块正是代码块的正常用法（行内引用的既有支不受影响）。
      const anchorId = currentBlockId(editor)
      if (!anchorId) return false
      const anchorInCode = editor.getEditorState().read(() => $findBlockNode(anchorId)?.getBlockType() === 'code')
      // 贴进代码块的多行文本：**逐行写**——`insertText` 管文字、`insertLineBreak` 管换行
      // （换行在编辑器里是 `LineBreakNode`、由适配器序列化成 `\n` 落库；机制 A 之后同一形态）。
      // 不走默认粘贴：那里对多行纯文本的处理不受控（可能吞换行或拆块）。
      if (anchorInCode && /\n/.test(text)) {
        event.preventDefault()
        editor.update(() => {
          const selection = $getSelection()
          if (!$isRangeSelection(selection)) return
          const lines = text.split('\n')
          lines.forEach((line, index) => {
            if (line.length > 0) selection.insertText(line)
            if (index < lines.length - 1) selection.insertLineBreak()
          })
        }, { tag: [HISTORIC_TAG, 'moqi-paste'], discrete: true })
        return true
      }
      // `parseMarkdownOutline` 见「整篇没有块记号」就返回 null（放行走默认粘贴）——但**行内引用语法本身**
      // 也得被认（`[[页名]]` / `((块名))` 可以出现在无记号的纯文字里，用户 2026-10-08 报的正是这种粘法）：
      // 这时按「文档」解析出一棵树（永远给树），让下游的 `resolveInlineRefs` 有活干。
      // **多行无记号纯文本同样按行建块**（`R04-ENTER-5` 的另一半，W6 2026-10-10 裁决：软换行从根上
      // 取消——「多行全挤进一个块」正是它的一种表现）；单行（含尾随换行）与贴进代码块的多行仍走
      // 默认粘贴，不无谓转换。
      const outline = parseMarkdownOutline(text)
        ?? (/\[\[|\(\(/.test(text) || (!anchorInCode && /\n/.test(text.trim())) ? parseMarkdownDocument(text).roots : null)
      if (!outline) return false
      event.preventDefault()
      pasteOutline(anchorId, outline)
      return true
    }, COMMAND_PRIORITY_HIGH)
  }, [editor, enabled, pasteUrl, pasteOutline, pasteMedia])

  // 根级只能有页面容器：任何落到根上的正文（新建页面后直接打字、点在容器内边距、
  // 粘贴或拖放）都在这一步被收进容器，成为真正的 Block——否则它会活在块模型之外，
  // 既没有块装饰，刷新后也不属于任何页面。identity 由装饰层之外的领域通路写入（见 onAdoptRoot）。
  useEffect(() => {
    if (!enabled) return
    return editor.registerNodeTransform(RootNode, (root) => {
      const container = root.getChildren().find((node) => $isBlockNode(node) && node.isPageObject())
      if (!container || !$isBlockNode(container)) return
      if (root.getChildren().every((node) => node === container)) return
      const adopted = $adoptRootContent(container, () => ({ entityId: crypto.randomUUID(), blockUid: newBlockUid() }))
      adoptRoot(container.getEntityId(), adopted.map(({ entityId, blockUid }) => ({ entityId, blockUid })))
    })
  }, [editor, enabled, adoptRoot])

  // MD 输入层 · 打字触发（`R09-MD-2` / `R09-MD-4`，2026-10-06）：判据在输入规则层（纯函数），这里只做转发。
  //
  // 两条纪律写在守卫里：**IME 组合态不触发**、**光标必须就在这个文本节点末尾**——程序化写回
  // （AI 流式、撤销、粘贴解析）都不在节点末尾，因此天然不误触（`R09-MD-4.2「不打扰写作」`）。
  // 为什么挂在 TextNode 上而不是 BlockNode：改**子文本**不会把父节点标脏，父节点的 transform 根本不会跑
  // （accept 实测：打 `- ` 什么也没发生）。
  useEffect(() => {
    if (!enabled) return
    return editor.registerNodeTransform(TextNode, (node) => {
      if (editor.isComposing()) return
      const selection = $getSelection()
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return
      if (selection.anchor.key !== node.getKey() || selection.anchor.offset !== node.getTextContentSize()) return

      // ① 行内成对收尾：抹掉记号、内层上格式（同一次 update ⇒ ⌘Z 一步退回）
      const pairTrigger = decideInlinePairTrigger(node.getTextContent())
      if (pairTrigger) {
        const prefix = node.getTextContent().slice(0, pairTrigger.index)
        const format = INLINE_TEXT_FORMAT[pairTrigger.mark]
        const originalFormat = node.getFormat()
        node.setTextContent(pairTrigger.inner)
        if (!node.hasFormat(format)) node.toggleFormat(format)
        if (prefix.length > 0) {
          const before = $createTextNode(prefix)
          before.setFormat(originalFormat)
          node.insertBefore(before)
        }
        node.selectEnd()
        return
      }

      // ② 块级记号：整块的文字正好是触发词（`- ` / `# ` / `---` …）→ 转块。
      // 转换**延到下一个 tick**：divider 那条要走「整篇重建」，不能在 transform 里改编辑器。
      let block: LexicalNode | null = node.getParent()
      while (block && !$isBlockNode(block)) block = block.getParent()
      if (!block) return
      // 触发词必须在块**末尾**（前面可能还有别的节点，比如空文本节点）——accept 实测：加了「只有一个子节点」
      // 这个守卫，块记号永远触发不了
      const lastChild = block.getChildren()[block.getChildren().length - 1]
      if (!lastChild || lastChild.getKey() !== node.getKey()) return
      const marker = decideBlockMarkerTrigger(block.getTextContent())
      if (!marker) return
      const blockId = block.getEntityId()
      window.setTimeout(() => markerTrigger(blockId, marker), 0)
    })
  }, [editor, enabled, markerTrigger])
  // 行内引用不变式（docs/04 §1 R04-CARET-5）：链接文字首尾不留空白（空白挪到链接之外）、
  // 链接后面永远有一个能落字的普通文本节点。两者都是自维护：用户点/敲进链接边缘时也能自愈。
  useEffect(() => {
    if (!enabled) return
    return editor.registerNodeTransform(InlineFragmentNode, (node) => {
      $trimInlineRef(node)
    })
  }, [editor, enabled])

  // 名字行锚点（自维护不变式，docs/04 §3.1 R04-NAME-11）：容器自己那一行在「删掉名字最后一个字」
  // 「首行 Enter 拆走整行文字」之后会被 Lexical 的归一化收走，指向它的光标随之掉进下一个块
  // （用户实测：删光页名光标跑到下面的块开头、点占位没反应）。规则只写在 `$ensureNameLineAnchor`
  // 一处，这里只负责在每个编辑器更新后把它补回来。注册一次（回调见上方 useStableCallback 说明）。
  useEffect(() => {
    if (!enabled) return
    return registerNameLineAnchor(editor)
  }, [editor, enabled])


  return editor
}
