import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Dialog } from './Dialogs'

/**
 * 代码块「语言…」选择器（块 ⋯ 菜单进）：候选＝设置页「代码块语言」**自选子集**（纯界面偏好，
 * 存 ui-prefs），**自由输入兜底**照存任意语言（不做白名单），**清除**入口保留。
 * 选完即落块属性并关弹窗；当前语言在候选里高亮、再点不动作（清除走下面的按钮，语义不混）。
 */
export function LangPickerDialog({ current, codeLangs, onSetLang, onClose }: {
  /** 当前块的语言（无语言为 null）。 */
  current: string | null
  /** 设置页自选子集（候选清单）。 */
  codeLangs: string[]
  /** `null` ＝ 清除。 */
  onSetLang: (lang: string | null) => void
  onClose: () => void
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [draft, setDraft] = useState('')
  const apply = (lang: string | null) => { onSetLang(lang); onClose() }

  return (
    <Dialog
      title="代码块语言"
      subtitle={current ? `当前：${current}` : '未设置语言'}
      initialFocus={inputRef as React.RefObject<HTMLElement | null>}
      onClose={onClose}
      footer={<div className="fd-foot">↵ 保存输入 · Esc 关闭</div>}
    >
      <div className="lang-chips" role="listbox" aria-label="候选语言">
        {codeLangs.map((lang) => (
          <button
            key={lang}
            type="button"
            role="option"
            aria-selected={lang === current}
            className={`lang-chip ${lang === current ? 'is-cur' : ''}`}
            onClick={() => { if (lang !== current) apply(lang) }}
          >
            {lang}
          </button>
        ))}
      </div>
      <div className="frow">
        <input
          ref={inputRef}
          className="inp"
          value={draft}
          placeholder="其它语言…（原样保存大小写）"
          aria-label="自定义语言"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            const lang = draft.trim()
            if (lang) apply(lang)
          }}
        />
        <button type="button" className="btn" disabled={!draft.trim()} onClick={() => apply(draft.trim())}>保存</button>
      </div>
      <div className="frow">
        <button type="button" className="btn" disabled={!current} onClick={() => apply(null)}>清除语言</button>
        <span className="note">任意语言照存，不做白名单；清除后导出不再写语言标记。</span>
      </div>
    </Dialog>
  )
}
