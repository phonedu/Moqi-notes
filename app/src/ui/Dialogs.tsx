import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@moqi/editor'
import { webUrlError } from '@moqi/editor'

type DialogProps = {
  title: string
  subtitle?: string
  small?: boolean
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  /** 打开时获得焦点的元素；缺省时聚焦弹窗本身。 */
  initialFocus?: React.RefObject<HTMLElement | null>
  /** 面板附加类名（设置弹窗用它拉宽高： 的 760×620 与 ≤700 全屏降级）。 */
  className?: string
}

/**
 * 弹窗外壳：esc 关闭、焦点进入弹窗、点遮罩关闭（docs/08 §4 组件状态矩阵）。
 * 触发元素的焦点恢复由调用方在 onClose 里完成。
 */
export function Dialog({ title, subtitle, small = false, onClose, children, footer, initialFocus, className }: DialogProps) {
  const panelRef = useRef<HTMLDivElement | null>(null)
  // **焦点 effect 必须只跑一次**（2026-10-08 修）：它的依赖里若放 （调用方一律传内联箭头、
  // 每次渲染都是新身份），effect 就每渲染重跑一次、把焦点从输入框抢回面板——症状是「打一个字，选中态
  // 从输入框跳到整张卡片」（用户实测）。onClose 走 ref 取最新值即可。
  const closeRef = useRef(onClose)
  // 渲染期不许写 ref（React 规则 + 本仓库 lint 会拦）⇒ 用一条效果同步最新值，供只跑一次的焦点/键盘 effect 取用。
  useEffect(() => { closeRef.current = onClose })

  useEffect(() => {
    const panel = panelRef.current
    const target = initialFocus?.current ?? panel
    target?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        /* 「一层一个返回」（`R09-KEY-13` 的原文精神）：弹窗里**就地展开的子层**（θ4 属性库的面板）
           在它自己身上标 `data-esc-claim`——命中就不收弹窗，把 Esc 让给那一层（它自己接、自己收）。
           没有标记 = 老行为（Esc 关弹窗）。 */
        const target = event.target
        if (target instanceof Element && target.closest('[data-esc-claim]')) return
        event.stopPropagation(); closeRef.current(); return
      }
      if (event.key !== 'Tab' || !panel) return
      const focusable = [...panel.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((element) => !element.hasAttribute('disabled'))
      if (focusable.length === 0) { event.preventDefault(); panel.focus(); return }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])   // 只在挂载时聚焦一次 + 绑一次键盘（Esc / Tab 环）；onClose 经 closeRef 取最新

  return (
    <div className="mask" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className={`dlg ${small ? 'is-small' : ''} ${className ?? ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={panelRef}>
        <header className="dlg-h">
          <div>
            <h3>{title}</h3>
            {subtitle ? <div className="hint">{subtitle}</div> : null}
          </div>
          <button type="button" className="dlg-x" aria-label="关闭" onClick={onClose}><Icon name="x" size={16} decorative /></button>
        </header>
        {children}
        {footer ? <footer className="dlg-f">{footer}</footer> : null}
      </div>
    </div>
  )
}

export function ConfirmDialog({ title, body, confirmLabel, cancelLabel = '取消', danger = false, onConfirm, onClose }: {
  title: string
  body: ReactNode
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  return (
    <Dialog
      title={title}
      small
      onClose={onClose}
      initialFocus={confirmRef as React.RefObject<HTMLElement | null>}
      footer={<>
        <button type="button" className="btn-plain" onClick={onClose}>{cancelLabel}</button>
        <button
          type="button"
          className={danger ? 'btn-danger' : 'btn-brand'}
          ref={confirmRef}
          // 弹窗可能位于带拖拽 / 点击关闭逻辑的应用外壳内；确认动作必须只由按钮自己消费。
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); onConfirm() }}
        >
          {confirmLabel}
        </button>
      </>}
    >
      <div className="dlg-b">{body}</div>
    </Dialog>
  )
}

export function BulkDeleteDialog({ count, refs, hasChildren, onConfirm, onClose }: {
  count: number
  refs: number
  hasChildren: boolean
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <ConfirmDialog
      title={hasChildren ? `删除 ${count} 个块（含子块）？` : `删除 ${count} 个块？`}
      confirmLabel="删除块"
      danger
      body={<>
        <p>将删除 <b>{count}</b> 个块{hasChildren ? '及其子块' : ''}。</p>
        {refs > 0 ? <p className="dlg-note">有 {refs} 处引用会失效。</p> : null}
        <p className="dlg-note">删除后可用 ⌘Z 撤销。</p>
      </>}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  )
}

export function DiscardAiBlockDialog({ onConfirm, onClose }: { onConfirm: () => void; onClose: () => void }) {
  return (
    <ConfirmDialog
      title="丢弃这个 AI 块？"
      confirmLabel="丢弃"
      danger
      body={<>
        <p>这个 AI 块会从本机删除，<b>不进回收站，也不能撤销</b>。</p>
        <p className="dlg-note">AI 面板里的回答还在，需要时可以再插一次。</p>
      </>}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  )
}

export function TagMergeDialog({ sourceName, sourceCount, targetName, onConfirm, onClose }: {
  sourceName: string
  sourceCount: number
  targetName: string
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <ConfirmDialog
      title={`合并 #${sourceName}？`}
      confirmLabel="合并"
      body={<>
        <p>把 <b>{sourceCount}</b> 篇页面从 #{sourceName} 改指向 #{targetName}，源标签删除；正文文字不变。</p>
        <p className="dlg-note">合并后可用 ⌘Z 撤销。</p>
      </>}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  )
}

/**
 * 插入外部链接（`09-桌面端交互规范` §6.13 `R09-ELINK-2`）：文字 + URL 两行，回车提交、Esc 取消；
 * URL 不合法时**确定按钮禁用并写明原因**（不写半截链接）；文字为空时用 URL 原文兜底（提交时处理）。
 * 取消 = 不留痕：这个组件自己不写任何数据，调用方在 onSubmit 里才动领域。
 */
export function LinkDialog({ initialText = '', onSubmit, onClose }: {
  initialText?: string
  onSubmit: (text: string, url: string) => void
  onClose: () => void
}) {
  const [text, setText] = useState(initialText)
  const [url, setUrl] = useState('')
  const textRef = useRef<HTMLInputElement | null>(null)
  const urlRef = useRef<HTMLInputElement | null>(null)
  const error = webUrlError(url)
  const submit = () => {
    if (webUrlError(url) !== null) return
    onSubmit(text.trim(), url.trim())
  }
  return (
    <Dialog
      title="插入外部链接"
      subtitle="回车提交 · Esc 取消（取消不留痕）"
      onClose={onClose}
      initialFocus={(initialText.trim().length > 0 ? urlRef : textRef) as React.RefObject<HTMLElement | null>}
      footer={<>
        <button type="button" className="btn-plain" onClick={onClose}>取消</button>
        <button
          type="button"
          className="btn-brand"
          disabled={error !== null}
          title={error ?? '插入这条链接'}
          // 弹窗可能位于带拖拽逻辑的应用外壳内：确认动作只由按钮自己消费（同 ConfirmDialog）。
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); submit() }}
        >
          确定
        </button>
      </>}
    >
      <div className="dlg-b">
        <label className="frow" style={{ borderTop: 'none', paddingTop: 0 }}>
          <span style={{ width: 72 }}>文字</span>
          <span className="ctl">
            <input
              className="inp"
              ref={textRef}
              value={text}
              placeholder="显示文字（留空就用地址原文）"
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit() } }}
            />
          </span>
        </label>
        <label className="frow">
          <span style={{ width: 72 }}>URL</span>
          <span className="ctl">
            <input
              className="inp"
              ref={urlRef}
              value={url}
              placeholder="https://… 或 mailto:…"
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit() } }}
            />
          </span>
        </label>
        {error !== null && url.length > 0 ? <p className="dlg-note">{error}</p> : null}
      </div>
    </Dialog>
  )
}

export function PromptDialog({ title, label, initialValue, placeholder, submitLabel, onSubmit, onClose }: {
  title: string
  label: string
  initialValue?: string
  placeholder?: string
  submitLabel: string
  onSubmit: (value: string) => void
  onClose: () => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const submit = () => {
    const value = inputRef.current?.value.trim() ?? ''
    if (!value) return
    onSubmit(value)
  }
  return (
    <Dialog
      title={title}
      small
      onClose={onClose}
      initialFocus={inputRef as React.RefObject<HTMLElement | null>}
      footer={<>
        <button type="button" className="btn-plain" onClick={onClose}>取消</button>
        <button type="button" className="btn-brand" onClick={submit}>{submitLabel}</button>
      </>}
    >
      <div className="dlg-b">
        <label className="frow" style={{ borderTop: 'none', paddingTop: 0 }}>
          <span style={{ width: 72 }}>{label}</span>
          <span className="ctl">
            <input
              className="inp"
              ref={inputRef}
              defaultValue={initialValue ?? ''}
              placeholder={placeholder}
              onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit() } }}
            />
          </span>
        </label>
      </div>
    </Dialog>
  )
}

export function PickDialog<T extends { id: string; name: string }>({ title, label, items, emptyText, onPick, onClose }: {
  title: string
  label: string
  items: T[]
  emptyText: string
  onPick: (item: T) => void
  onClose: () => void
}) {
  return (
    <Dialog title={title} small onClose={onClose} footer={<button type="button" className="btn-plain" onClick={onClose}>取消</button>}>
      <div className="dlg-b">
        <div className="rp-sec">{label}</div>
        {items.length === 0 ? <p className="rp-empty">{emptyText}</p> : (
          <div className="pop" style={{ position: 'static', boxShadow: 'none', width: '100%', padding: 0 }}>
            {items.map((item) => (
              <button type="button" key={item.id} onClick={() => onPick(item)}>
                <span className="mi"><Icon name="tag" size={16} decorative /></span>
                <span>{item.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  )
}
