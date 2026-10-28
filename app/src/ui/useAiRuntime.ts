import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AiService } from '../application/aiService'
import type { DomainStore } from '../application/store'
import { OpenAICompatibleAIPort, type AiConfig } from '../composition'
import { createTextBlock, orderedRootIds, textContent, type AiAction, type AiMeta, type BlockMap } from '@moqi/editor'
import { dedupeSelection } from '@moqi/editor'
import { activePageSubtreeIds, owningPageId } from '@moqi/editor'
import { aiAnswerPageName, expandAiSources, resolveAiAnchor, type AiRequestPlan } from '@moqi/editor'
import { currentBlockId } from '@moqi/editor'
import { applyAiBlockStatus, insertAiBlockNode, markAiBlockAccepted, type AiEditorHandle } from '@moqi/editor'
import type { AiAnswer } from './Panels'

/**
 * AI 块的一生：生成（流式）→ 停止 / 失败 → 采用 / 丢弃，外加助手面板的问答与载入收口。
 *
 * 还债 #2 的模块③：2026-10-04 从 `EditorShell.tsx` 整块搬出来，**行为零变化**
 * （安全网 = `accept:AI-STREAM-1 / AI-UNDO-1 / AI-STOP-1 ×2 / AI-ERROR-1 / AI-REGEN-1`
 * + `accept:R09-AIB-5 / R09-AIB-6` + `AI-*` 单测）。
 *
 * 这个模块拥有三件事：
 * ① **一次生成**——落「生成中」占位块（`R09-AIB-6` 的落点）、流式写回、状态流转（生成中 / 完成 /
 *    取消 / 失败）、停止与重试入口，以及**中间态一律走镜像**（`applyMirror`）这条契约：
 *    一次生成在撤销栈里只留「落块」那一条，⌘Z 一次撤掉整块（`04` §5 / `11` UNDO-AI-1）；
 * ② **AI 块的去向**——采用（方案 A：界面无痕、只留数据，`R09-AIB-5`）与丢弃；
 * ③ **问答与收口**——助手面板的问答流（逐字、可停、可插入为块）与载入时把残留的「生成中」落回。
 *
 * 不做的事，也是接口故意不暴露的：读什么 / 落哪的口径由调用方用 `aiSourcePlan` 声明后传进来
 * （`R09-AIB-12`：不许从数组是否非空反推），浮层、工具栏、面板长什么样也不归它。
 */
type AiRuntimeOptions = {
  store: DomainStore
  /** 领域快照（外壳按 `revision` 缓存的那一份）：只读，用来判断页内有没有「生成中」的块。 */
  snapshot: BlockMap
  /** 当前页：来源回落与「光标块」档位都按它判定。 */
  activePageId: string | null
  /** 编辑器实例：落块 / 流式写回 / 采用都要在 Lexical 更新上下文里动节点。 */
  getEditor: () => AiEditorHandle | null
  /** AI 助手面板开着时，一次生成 / 一问会把结果追加进面板的问答列表。 */
  panelOpen: boolean
  aiConfig: AiConfig
  /** 把块文本写回（含镜像与落盘）——外壳已有的那一条通路，流式与定稿写回都走它。 */
  replaceBlockText: (editor: AiEditorHandle | null, blockId: string, text: string, options?: { selectEnd?: boolean; mirror?: boolean }) => void
  /** 落盘调度（外壳的 `persist`）。 */
  persist: (ids: string[]) => void
  /** 整篇重建（外壳的 `reloadFromStore`）。 */
  reloadFromStore: (pageId?: string | null) => void
  notify: (message: string, actionLabel?: string, onAction?: () => void) => void
  /** 选区模块的入口：一次生成结束会清掉选中（结果块是新块，旧选区没有意义）。 */
  exitSelection: () => void
  /** AI 没配置时的去向（外壳的 `setView('settings')`）。 */
  openSettings: () => void
}

export function useAiRuntime(options: AiRuntimeOptions) {
  const { store, snapshot, activePageId, getEditor, panelOpen, aiConfig, replaceBlockText, persist, reloadFromStore, notify, exitSelection, openSettings } = options

  const [aiState, setAiState] = useState<{ status: 'idle' | 'running'; action?: AiAction }>({ status: 'idle' })
  const [aiAnswers, setAiAnswers] = useState<AiAnswer[]>([])
  const [aiQuestions, setAiQuestions] = useState<string[]>([])
  const aiAbortRef = useRef<AbortController | null>(null)
  /** 流式生成的累积缓冲：按节拍写回 AI 块，而不是每个增量都写一次事务。 */
  const aiStreamRef = useRef<{ blockId: string; text: string; dirty: boolean } | null>(null)
  const lastAiRequestRef = useRef<{ action: AiAction; plan: AiRequestPlan } | null>(null)

  const aiReady = Boolean(aiConfig.baseUrl && aiConfig.apiKey && aiConfig.model)
  const aiService = useMemo(() => (aiReady ? new AiService(new OpenAICompatibleAIPort(aiConfig)) : null), [aiReady, aiConfig])

  /**
   * 流式写入的节流刷新：把累积文本按节奏写回块，避免每个增量都走一次事务。
   * 走镜像（不占撤销栈）：一次生成在撤销栈里只留「落块」那一条，⌘Z 一次撤掉整块（docs/04 §5）。
   */
  function flushAiStream() {
    const stream = aiStreamRef.current
    const editor = getEditor()
    if (!stream || !stream.dirty || !editor) return
    stream.dirty = false
    replaceBlockText(editor, stream.blockId, stream.text, { mirror: true })
  }

  /**
   * AI 块的状态流转与定稿文本写回：都是生成过程的一部分，不是用户动作，一律走镜像。
   * 这样「撤销」只针对这次生成的落块那一步，撤销后的光标与正文都不会被流式中间态牵走。
   */
  function setAiBlockStatus(blockId: string, status: AiMeta['status'], text?: string) {
    const editor = getEditor()
    const block = store.get(blockId)
    if (!block?.aiMeta) return
    if (text !== undefined) replaceBlockText(editor ?? null, blockId, text, { mirror: true })
    store.applyMirror({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      source: 'ai',
      operations: [{
        type: 'update',
        opId: crypto.randomUUID(),
        blockId,
        changes: { aiMeta: { ...block.aiMeta, status } },
        previous: { aiMeta: block.aiMeta },
      }],
    })
    if (editor) applyAiBlockStatus(editor, blockId, status)
    persist([blockId])
  }

  /**
   * 光标所在块，**只在本页且不是页面容器本身**时返回（`R09-AIB-6` 的「光标块」一档）。
   * 光标停在名字行（容器）或别的页面上时返回 null，由 `resolveAiAnchor` 回落到正文最后一块。
   */
  function caretBlockInPage(): string | null {
    const editor = getEditor()
    const caretId = editor ? currentBlockId(editor) : null
    if (!caretId || !activePageId) return null
    const caret = store.get(caretId)
    if (!caret || caret.isObject || caret.deleted) return null
    return owningPageId(store.snapshot(), caretId) === activePageId ? caretId : null
  }

  /** 停止当前生成（块上的 ■ 停止、忙碌条、卸载时都走它）。引用稳定，可直接进 effect 依赖。 */
  const cancelAi = useCallback(() => {
    aiAbortRef.current?.abort()
  }, [])

  /**
   * AI 生成（docs/09 §6.11）：先落一个「生成中」的 AI 块，再流式写入；
   * 停止保留已生成部分，重新生成就地重跑（targetBlockId）。
   */
  async function runAi(action: AiAction, plan: AiRequestPlan, options: { targetBlockId?: string } = {}) {
    if (!aiService) { openSettings(); notify('AI 不可用——先在设置里配置'); return }
    // 「读什么」= 入口声明（`aiSourcePlan`）经**领域层展开**（`expandAiSources`）：
    // - `page`（面板宫格：「基于本篇」）：传进来的是页面块 ⇒ 展开成**整棵子树、含页面块自己**
    //   （它的文字就是页名）。**展开后不再过 `dedupeSelection`**——它的规则是「外层的选中块吃掉内层」，
    //   页面 + 子孙一起送进去会被压成页面块一个 ⇒ 模型只收到页名（台账 D-018：真实模型实测时
    //   「润色」的输出就是「产品路线」四个字）。
    // - `selection`：那些块去重后的集合。
    const snapshot = store.snapshot()
    const declared = plan.sourceIds.length > 0 ? plan.sourceIds : (activePageId ? [activePageId] : [])
    const sources = plan.scope === 'page'
      ? expandAiSources(snapshot, { sourceIds: declared, scope: 'page', byBlockSelection: plan.byBlockSelection })
      : dedupeSelection(snapshot, plan.sourceIds)
    if (sources.length === 0) return
    const editor = getEditor()
    if (!editor) return
    lastAiRequestRef.current = { action, plan }

    // 来源**范围**（标签怎么说）与落点（`R09-AIB-6`：选中块 > 光标块 > 正文最后一块）都来自
    // 入口的那份声明（`aiSourcePlan`），不再由「数组非空」反推——反推会把「整篇」错认成
    // 「选中了页面容器这一个块」（用户实测 2026-09-29）。
    const sourceScope: 'page' | 'selection' = plan.scope
    let blockId = options.targetBlockId ?? null
    // 落点算一次，两条路径（流式占位块 / 行动项替换占位块）共用同一个锚点（`R09-AIB-6`）。
    const anchorId = blockId ? null : resolveAiAnchor({
      selected: plan.byBlockSelection ? plan.sourceIds : [],
      caretBlockId: caretBlockInPage(),
      sources,
    })
    if (blockId) {
      setAiBlockStatus(blockId, 'generating', '')
    } else {
      // 在**目标块**下方插入生成中的 AI 块（docs/09 §6.11 R09-AIB-6：选中块 > 光标块 > 正文最后一块）：
      // AI 结果永远是新块，不覆盖原文。「读什么」（sources）与「放哪」（anchor）是两件事——
      // 面板的「基于本篇」读整篇，结果落在光标那一块下面，不是文章末尾（用户实测 2026-09-29）。
      const anchor = anchorId ? store.get(anchorId) : undefined
      if (!anchorId || !anchor) return
      // 来源就是页面本身时，结果落进页面内部；落到根级会变成一个额外的"页面"。
      const parentId = anchor.parent ?? (anchor.isObject ? anchor.entityId : null)
      const block = createTextBlock({
        entityId: crypto.randomUUID(),
        blockUid: `a${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`,
        parent: parentId,
      })
      block.content = []
      block.aiMeta = { action, sourceBlockIds: [...sources], sourceScope, status: 'generating' }
      const index = parentId === anchorId
        ? anchor.children.length
        : parentId === null
          ? orderedRootIds(store.snapshot()).indexOf(anchorId) + 1
          : (store.get(parentId)?.children.indexOf(anchorId) ?? -1) + 1
      store.apply({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        source: 'ai',
        operations: [{ type: 'insert', opId: crypto.randomUUID(), block, parentId, index }],
      })
      insertAiBlockNode(editor, block, anchorId)
      persist([block.entityId, anchorId])
      blockId = block.entityId
    }

    const controller = new AbortController()
    aiAbortRef.current = controller
    const stream = { blockId, text: '', dirty: false }
    aiStreamRef.current = stream
    const tick = setInterval(() => flushAiStream(), 90)
    setAiState({ status: 'running', action })

    const result = await aiService.runStream(action, sources, sourceText(sources), controller.signal, (delta) => {
      stream.text += delta
      stream.dirty = true
    })
    clearInterval(tick)
    flushAiStream()
    aiStreamRef.current = null
    aiAbortRef.current = null
    setAiState({ status: 'idle' })

    if (!result.ok) {
      if (result.cancelled) {
        // 停止：保留已生成部分；空内容给出占位提示，块留在完成/取消态供重新生成或丢弃。
        const partial = stream.text.trim()
        setAiBlockStatus(blockId, partial.length > 0 ? 'complete' : 'cancelled', partial.length > 0 ? partial : '（已停止，未生成内容）')
        return
      }
      setAiBlockStatus(blockId, 'error', stream.text.trim() || `（生成失败：${result.error}）`)
      notify(`AI 失败：${result.error}`, '重试', () => { const last = lastAiRequestRef.current; if (last) void runAi(last.action, last.plan) })
      return
    }

    if (action === 'actions') {
      // 行动项按条目拆成多个 todo 块，并在**同一个事务里**替换掉流式占位块：
      // 一次「提取行动」只占一个撤销步（docs/04 §5），撤销一次就整批退掉。
      const blockIds = store.insertAiResults({
        sourceIds: sources,
        action,
        items: result.proposal.items,
        status: result.proposal.status,
        confidence: result.proposal.confidence,
        request: result.proposal.request,
        anchorId,
        sourceScope,
        removeBlockIds: [blockId],
      })
      if (panelOpen) {
        setAiAnswers((current) => [...current, { id: crypto.randomUUID(), action, text: result.proposal.items.join('\n'), status: result.proposal.status, sourceIds: sources }])
      }
      reloadFromStore()
      exitSelection()
      if (!blockIds) notify('AI 没有返回可用内容')
      return
    }

    const finalText = result.proposal.items.join('\n')
    setAiBlockStatus(blockId, result.proposal.status, finalText)
    if (panelOpen) {
      setAiAnswers((current) => [...current, { id: crypto.randomUUID(), action, text: finalText, status: result.proposal.status, sourceIds: sources }])
    }
    exitSelection()
  }

  /** 自由提问 · 基于本篇：回答在面板里逐字流式呈现，可随时停止（保留已生成部分）。 */
  async function askAi(question: string, scope?: { sourceIds: string[]; label: string }) {
    if (!aiService) { openSettings(); return }
    // 默认读整篇（`R09-AIASK-1`）；带 scope 时读**指定的那些块**——「有来源问答」就是从这里进来的
    // （范围 = 检索命中的 Block，`11` 的问答行）。领域层的来源范围字段仍是既有两个值，
    // 「基于检索命中的 N 块」这句话只活在界面标签里（不新增持久化取值，避免又踩一次载入白名单的坑）。
    // **整篇这条不能过 `dedupeSelection`**（同 `runAi`，台账 D-018）：子树列表里有页面块，去重会把
    // 它后面的子孙全吃掉，于是「基于本篇」的自由提问也只喂了页名。带 scope 的那些块照旧去重。
    const sources = scope
      ? dedupeSelection(store.snapshot(), scope.sourceIds)
      : activePageSubtreeIds(store.snapshot(), activePageId)
    if (sources.length === 0) return
    const controller = new AbortController()
    aiAbortRef.current = controller
    const answerId = crypto.randomUUID()
    setAiQuestions((current) => [...current, question])
    // 问句一起记在回答上：存成新页时页名要用它（`R09-AIPANEL-6b`——只活在界面，不落领域）。
    setAiAnswers((current) => [...current, { id: answerId, action: null, text: '', status: 'complete', sourceIds: sources, sourceLabel: scope?.label, question }])
    setAiState({ status: 'running' })
    let text = ''
    const patch = (changes: Partial<AiAnswer>) => setAiAnswers((current) => current.map((item) => item.id === answerId ? { ...item, ...changes } : item))
    const tick = setInterval(() => patch({ text }), 90)
    const result = await aiService.runStream('ask', sources, `笔记正文：\n${sourceText(sources)}\n\n问题：${question}`, controller.signal, (delta) => { text += delta })
    clearInterval(tick)
    aiAbortRef.current = null
    setAiState({ status: 'idle' })
    if (!result.ok) {
      patch({ text: text.length > 0 ? text : '（已停止）', status: 'error' })
      if (!result.cancelled) notify(`AI 失败：${result.error}`)
      return
    }
    patch({ text: result.proposal.items.join('\n'), status: result.proposal.status })
  }

  /**
   * 把一条回答落成 AI 块（`R09-AIPANEL-6b`，台账 D-016）。
   *
   * `target` 决定**落哪**（与「读什么」是两件事）：
   * - `current`：落当前页——锚点按 `R09-AIB-6` 那套档位（选中块 > 光标块 > 正文最后一块）；
   * - `new`：**新建一页**装它（页名取问句前 12 字），建页与插入同一个事务（一步撤销）。
   * 返回新建页的 id（调用方据此把用户带到那一页）；`current` 返回 null。失败返回 null。
   */
  function insertAnswerAsBlock(answer: AiAnswer, target: 'current' | 'new' = 'current'): string | null {
    const sourceIds = answer.sourceIds
    const status = answer.status
    if (target === 'new') {
      const created = store.insertAiResultsIntoNewPage({
        sourceIds,
        action: 'ask',
        items: [answer.text],
        status,
        sourceScope: 'page',
        pageName: aiAnswerPageName(answer.question),
      })
      if (!created) return null
      reloadFromStore()
      return created.pageId
    }
    const blockIds = store.insertAiResults({
      sourceIds,
      action: 'ask',
      items: [answer.text],
      status,
      sourceScope: 'page',
      anchorId: resolveAiAnchor({ selected: [], caretBlockId: caretBlockInPage(), sources: sourceIds }),
    })
    if (!blockIds) return null
    reloadFromStore()
    // 返回**落点块 id**（原来当前页模式恒回 null——调用方分不清成败，窄档「插入后收 Sheet」就没法做；
    // 2026-10-11 第 5 项）。存成新页模式回的是新页 id，两种模式调用方都拿得到「落在哪」。
    return blockIds[0] ?? null
  }

  function acceptAiBlock(blockId: string) {
    const block = store.get(blockId)
    if (!block?.aiMeta) return
    store.apply({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      source: 'user',
      // 采用 = 转普通块：块不再有任何 AI 外观（虚线框 / 标签行 / 操作条 / 标记全无），
      // 但 **`aiMeta` 留在数据里**——来源与操作类型「保留至采用或丢弃」（docs/09 R09-AIB-7，
      // 方案 A，用户 2026-09-29 裁决：界面什么都不显示，只留数据）。
      operations: [{ type: 'update', opId: crypto.randomUUID(), blockId, changes: { aiMeta: { ...block.aiMeta, status: 'accepted' } }, previous: { aiMeta: block.aiMeta } }],
    })
    const editor = getEditor()
    if (editor) markAiBlockAccepted(editor, blockId)
    persist([blockId])
  }

  /**
   * 丢弃 AI 块：**AI 程序产物不进回收站**（台账 `D-003`，2026-10-05 用户裁决走 (b)）。
   *
   * 回收站是「用户内容」的保险——AI 草稿不是用户写的，扔进去只会让 30 天后的清理面变脏
   * （2026-10-05 清真实库时，48 个页面根里混着一批 AI/测试产物）。所以走**真删**而不是软删：
   * 不产生回收站条目、也没有 `⌘Z`（面板的对话里还留着这条回答，想要可以再插一次）。
   */
  function discardAiBlock(blockId: string) {
    const removed = store.purge([blockId])
    if (removed === 0) return
    reloadFromStore()
  }

  /** 送给模型的正文：块文本；对象块没有正文时用页面名（AI 需要知道这一页叫什么）。 */
  function sourceText(sourceIds: string[]): string {
    return sourceIds.map((id) => {
      const block = store.get(id)
      if (!block) return ''
      const text = textContent(block)
      return block.isObject && !text ? (block.objectName ?? '') : text
    }).filter((line) => line.length > 0).join('\n')
  }

  /**
   * 本篇里是否已有「生成中」的 AI 块：有就由块内标签行承担 ■停止（常驻，不依赖 hover），
   * 不必再显示浮动的忙碌条。只认当前页面子树，库里别处残留的 generating 块（例如生成途中重载）不算。
   */
  const hasGeneratingAiBlock = useMemo(() => {
    if (!activePageId) return false
    for (const id of activePageSubtreeIds(snapshot, activePageId)) {
      if (snapshot.get(id)?.aiMeta?.status === 'generating') return true
    }
    return false
  }, [snapshot, activePageId])
  /** 关闭流程在事件回调里读「有没有生成中的块」，用 ref 保证拿到最新值（监听只注册一次）。 */
  const generatingRef = useRef(false)
  useEffect(() => { generatingRef.current = hasGeneratingAiBlock }, [hasGeneratingAiBlock])

  // 卸载时中断进行中的生成：生成不可能跨进程存活（同下面的载入收口），留着只会让请求挂在网络上。
  useEffect(() => () => { aiAbortRef.current?.abort() }, [])

  // 启动时收口「生成中」残留：生成中的 AI 块不可能跨进程存活，
  // 重载/崩溃后必须落回完成或取消态，否则会永远停在生成中（并让停止入口指向错误的块）。
  // 走镜像（`applyMirror`）：这是载入自愈，不是用户动作，不能占掉撤销栈里的一步。
  useEffect(() => {
    const stuck = [...store.snapshot().values()].filter((block) => block.aiMeta?.status === 'generating' && !block.deleted)
    if (stuck.length === 0) return
    store.applyMirror({
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      source: 'system',
      operations: stuck.map((block) => ({
        type: 'update' as const,
        opId: crypto.randomUUID(),
        blockId: block.entityId,
        changes: { aiMeta: { ...block.aiMeta!, status: textContent(block).trim().length > 0 ? 'complete' as const : 'cancelled' as const } },
        previous: { aiMeta: block.aiMeta },
      })),
    })
    persist(stuck.map((block) => block.entityId))
    // 只在首次挂载时执行一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store])

  return {
    aiReady,
    aiState,
    aiAnswers,
    aiQuestions,
    hasGeneratingAiBlock,
    generatingRef,
    caretBlockInPage,
    cancelAi,
    runAi,
    askAi,
    insertAnswerAsBlock,
    acceptAiBlock,
    discardAiBlock,
  }
}
