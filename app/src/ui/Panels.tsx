import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from '@moqi/editor'
import { AI_UI_OPS, aiActionLabel, type AiUiOp } from './aiMenu'
import { aiOpScope, type AiPanelGate } from '@moqi/editor'
import type { AiAction } from '@moqi/editor'

export type RefCard = {
  id: string
  title: string
  meta: string
  preview: string
  isBlock: boolean
}

type RefPanelProps = {
  open: boolean
  outgoing: RefCard[]
  incoming: RefCard[]
  includeDeleted: boolean
  onToggleIncludeDeleted: () => void
  onJump: (id: string) => void
  onClose: () => void
}

/**
 * 引用预览面板（docs/09 §4.5）：右侧 340px 覆盖式滑出，唯一入口是 … 菜单。
 * 正文里的 [[ ]]、(( ))、反链卡片一律直接跳转，不触发本面板。
 */
export function RefPanel({ open, outgoing, incoming, includeDeleted, onToggleIncludeDeleted, onJump, onClose }: RefPanelProps) {
  return (
    <aside className={`side-panel ref-panel ${open ? 'is-open' : ''}`} aria-label="引用预览面板" aria-hidden={!open || undefined}>
      <header className="side-panel-head">
        <h3>引用预览</h3>
        <div className="ops">
          <button type="button" className="x" aria-label="关闭引用预览面板" title="关闭" onClick={onClose}><Icon name="x" size={16} decorative /></button>
        </div>
      </header>
      <div className="side-panel-body">
        <div className="rp-sec">出链 · {outgoing.length}</div>
        {outgoing.length === 0 ? <p className="rp-empty">本页还没有指向其他页面或块的引用。正文输入 <b>[[</b> 或 <b>((</b> 即可建立。</p> : outgoing.map((card) => (
          <button type="button" className="rp-card" key={card.id} onClick={() => onJump(card.id)}>
            <div className="t">{card.isBlock ? '¶ ' : '📄 '}{card.title}</div>
            <div className="b">{card.meta ? `${card.meta} · ` : ''}{card.preview}</div>
          </button>
        ))}

        <div className="rp-sec" style={{ marginTop: 18 }}>反向链接 · {incoming.length}</div>
        {incoming.length === 0 ? <p className="rp-empty">还没有其他页面引用本页。</p> : incoming.map((card) => (
          <button type="button" className="rp-card" key={card.id} onClick={() => onJump(card.id)}>
            <div className="t is-plain">{card.title}</div>
            <div className="b">{card.preview}</div>
          </button>
        ))}

        <label className="pp-hint" style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <input type="checkbox" checked={includeDeleted} onChange={onToggleIncludeDeleted} />
          包含已删除来源
        </label>
      </div>
    </aside>
  )
}

export type AiAnswer = {
  id: string
  action: AiAction | null
  text: string
  status: 'complete' | 'needs-confirmation' | 'error'
  sourceIds: string[]
  /** V2c：这次问答的范围标签（如「检索命中的 3 块」）；缺省按「本篇」。 */
  sourceLabel?: string
  /** V2c 补：这次提问的问题原文——新建页面的页名与 `aiMeta.request` 都用它（`R09-AIPANEL-6b`）。 */
  question?: string
}

/**
 * 这次问答的**存入目标**（`R09-AIPANEL-2/6b`，台账 D-016）。
 *
 * `current` = 当前页；`new` = 新建一页（建完就打开那一页，于是后续回答自然继续存它）。
 * **范围（读什么）与存入（落哪）是两件事**：跨页范围从 ⌘K 进来时默认 `new`——不猜
 * （落进当时碰巧打开的那一页，是缺陷级的意外，见 D-016 的实现现状）。
 */
export type AskDestination = { mode: 'current' | 'new'; label: string }

type AiPanelProps = {
  open: boolean
  pageName: string
  aiReady: boolean
  running: boolean
  answers: AiAnswer[]
  questions: string[]
  onQuick: (op: string, action: AiAction | null) => void
  /** 宫格每项此刻的「能不能跑 / 为什么不能」（`R09-AIPANEL-3c`）：渲染与执行共用同一份判据。 */
  gates: Partial<Record<AiAction, AiPanelGate>>
  onAsk: (question: string) => void
  /** V2c 有来源问答：答案的来源 chips 点一下就跳到那一块（`REF-JUMP-1` 同一条通路）。 */
  onJumpSource: (blockId: string) => void
  /** 来源 chip 上显示什么（页面名 / 块首十字）。 */
  sourceTitleOf: (blockId: string) => string
  /** V2c：这次提问的范围标签（来自检索命中）；null = 基于本篇。 */
  askScopeLabel: string | null
  onClearAskScope: () => void
  /** V2c 补：答案的落点（头部写出来，插入按钮也写出来）。 */
  askDestination: AskDestination
  onAskDestinationChange: (mode: 'current' | 'new') => void
  onInsert: (answer: AiAnswer) => void
  onCopy: (answer: AiAnswer) => void
  onOpenSettings: () => void
  onClose: () => void
  /** 就地提示带的插槽（θ10 · `R09-STATE-1b`）：AI 失败 / 重试就地说在面板里——
   *  面板在窄档是盖住编辑器列的浮层，编辑器列顶那条提示带在这里看不见。 */
  noticeSlot?: ReactNode
}

/**
 * AI 助手面板（docs/09 §4.8）：右侧 340px 覆盖式滑出，六宫格快捷指令 + 自由提问。
 * 头部写**存入哪一页**、输入行写**范围**（两者是独立事实，`R09-AIPANEL-2/5b`）；
 * 回答可插入为块（落点写在按钮上），插入后走 AI 块生命周期；未实现项的死分支已删（B 批：现无数据命中，由 `accept:R09-SCOPE-17` 看护）。
 */
export function AiPanel({
  open, pageName, aiReady, running, answers, questions, onQuick, onAsk, onInsert, onCopy, onOpenSettings, onClose, onJumpSource, sourceTitleOf, askScopeLabel, onClearAskScope, askDestination, onAskDestinationChange, gates, noticeSlot,
}: AiPanelProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [destOpen, setDestOpen] = useState(false)

  /**
   * 宫格下方的范围说明（`R09-AIPANEL-3c` 的可见执行者）：改写型只作用于一段——能跑时要让用户知道
   * 作用在哪，不能跑时要说清为什么（只藏在 tooltip 里不算，同 `R09-SCOPE-17` 的精神）。
   */
  const rewriteOps = AI_UI_OPS.filter((item): item is AiUiOp & { action: AiAction } => item.action !== null && aiOpScope(item.action) === 'single')
  const pageOps = AI_UI_OPS.filter((item): item is AiUiOp & { action: AiAction } => item.action !== null && aiOpScope(item.action) === 'page')
  const blockedGate = rewriteOps.map((item) => gates[item.action]).find((gate) => gate?.kind === 'blocked')
  const scopeNote = blockedGate?.kind === 'blocked'
    ? `${rewriteOps.map((item) => item.label).join(' / ')}：${blockedGate.reason}`
    : `${rewriteOps.map((item) => item.label).join(' / ')} 作用于本段；${pageOps.map((item) => item.label).join(' / ')} 基于本篇`

  const send = () => {
    const value = inputRef.current?.value.trim() ?? ''
    if (!value) return
    onAsk(value)
    if (inputRef.current) inputRef.current.value = ''
  }
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); send() }
  }

  return (
    <aside className={`side-panel aip ${open ? 'is-open' : ''}`} aria-label="AI 助手" aria-hidden={!open || undefined}>
      <header className="aip-head">
        <span className="ai-ico"><Icon name="sparkles" size={16} decorative /></span>
        <h3>AI 助手</h3>
        {/* 头部写**存入哪**（范围写在输入行）——此前这里写「基于本篇」，跨页提问时它是错的（台账 D-016①）。 */}
        <div className="aip-dest">
          <button
            type="button"
            className="ctx"
            aria-haspopup="menu"
            aria-expanded={destOpen}
            title="答案存到哪一页（点开可改）"
            onClick={() => setDestOpen((value) => !value)}
          >
            存入：{askDestination.label}
          </button>
          {destOpen ? (
            <div className="aip-dest-menu" role="menu">
              <button
                type="button"
                role="menuitem"
                className={askDestination.mode === 'current' ? 'is-on' : ''}
                onClick={() => { onAskDestinationChange('current'); setDestOpen(false) }}
              >
                当前页「{pageName || '未命名页面'}」
              </button>
              <button
                type="button"
                role="menuitem"
                className={askDestination.mode === 'new' ? 'is-on' : ''}
                onClick={() => { onAskDestinationChange('new'); setDestOpen(false) }}
              >
                新建一页
              </button>
            </div>
          ) : null}
        </div>
        <button type="button" className="x" aria-label="关闭 AI 助手" title="关闭" onClick={onClose}><Icon name="x" size={16} decorative /></button>
      </header>

      {noticeSlot}

      <div className="aip-grid" role="group" aria-label="快捷指令">
        {AI_UI_OPS.map((item) => {
          // 改写型没有目标（没选中也没光标）或多块选中时禁用——判据来自 `aiPanelGate`（`R09-AIPANEL-3c`）。
          const gate = item.action ? gates[item.action] : undefined
          const blockedReason = gate?.kind === 'blocked' ? gate.reason : null
          return (
            <button
              key={item.op}
              type="button"
              title={blockedReason ?? item.hint}
              disabled={!item.action || running || !aiReady || blockedReason !== null}
              onClick={() => onQuick(item.op, item.action)}
            >
              <span className="gi"><Icon name={item.icon} size={16} decorative /></span>
              {item.label}
              {/* 未实现的指令必须**看得见地**标注版本——只有 tooltip 不够（`docs/09` `R09-SCOPE-17`：
                  「保留触发位置与形态，标注版本，不伪装可用」）。判据是 `item.action` 而不是按钮的
                  disabled：running / 未配置 AI 时整格都会禁用，那两项是实现了的。 */}
              {/* B 批（`R09-STATE-5` / “隐藏优于灰着”）：未实现项的「后续版本」死分支已删（同上，由 `accept:R09-SCOPE-17` 看护） */}
            </button>
          )
        })}
      </div>
      {/* 范围写在看得见的地方（`R09-AIPANEL-3c`）——宫格此前从不说自己读什么。 */}
      <p className="aip-scope-note">{scopeNote}</p>

      <div className="aip-chat">
        {!aiReady ? (
          <div className="aip-empty">
            还没有配置 AI 能力。<br />
            <button type="button" className="pe-add" style={{ marginTop: 12 }} onClick={onOpenSettings}>前往设置 →</button>
          </div>
        ) : null}

        {questions.map((question, index) => (
          <div className="aip-msg is-me" key={`q-${index}`}>
            <span className="who">我</span>
            <div className="bub">{question}</div>
          </div>
        ))}

        {answers.map((answer) => (
          <div className="aip-msg is-ai" key={answer.id}>
            <span className="who">
              ✦ AI 回答 · {answer.sourceLabel ?? '基于本篇'}{answer.action ? ` · ${aiActionLabel[answer.action]}` : ' · 自由问答'}
              {answer.status === 'needs-confirmation' ? ' · 需人工确认' : ''}
            </span>
            <div className="bub">{answer.text}</div>
            {/* 「答案里点得回来源」：范围是检索命中时，这些 chips 就是那次检索命中的块（`11` 的问答行）。 */}
            {answer.sourceIds.length > 0 ? (
              <div className="aip-src">
                <span className="lb">来源</span>
                {answer.sourceIds.slice(0, 6).map((blockId) => (
                  <button type="button" key={blockId} className="aip-src-chip" title="跳到这一块" onClick={() => onJumpSource(blockId)}>
                    {sourceTitleOf(blockId)}
                  </button>
                ))}
                {answer.sourceIds.length > 6 ? <span className="lb">…等 {answer.sourceIds.length} 块</span> : null}
              </div>
            ) : null}
            <div className="acts">
              {/* 落点写在按钮上：跨页提问时「插入为块 ↘」不说去哪，用户没法预判（台账 D-016②）。 */}
              <button type="button" onClick={() => onInsert(answer)}>
                {askDestination.mode === 'new' ? '存成新页 ↘' : `插入到「${askDestination.label}」`}
              </button>
              <button type="button" onClick={() => onCopy(answer)}>复制</button>
            </div>
          </div>
        ))}

        {running ? <div className="aip-msg is-ai"><div className="bub">AI 生成中…<span className="dots"><i /><i /><i /></span></div></div> : null}
      </div>

      <div className="aip-inbar">
        {/* 范围必须写在看得见的地方：带上检索范围时如果还写「基于本篇」，用户会以为整篇都在被喂给模型。 */}
        <div className="mode">
          自由提问 · {askScopeLabel ?? '基于本篇'}
          {askScopeLabel ? <button type="button" className="aip-scope-x" title="改回基于本篇" onClick={onClearAskScope}>改回本篇</button> : null}
        </div>
        <div className="row">
          <input
            ref={inputRef}
            type="text"
            placeholder={aiReady ? '问点什么…' : '需先在设置中配置 AI 能力'}
            aria-label="向 AI 提问"
            disabled={!aiReady || running}
            onKeyDown={onKeyDown}
          />
          <button type="button" className="send" disabled={!aiReady || running} onClick={send}>发送</button>
        </div>
      </div>
    </aside>
  )
}
