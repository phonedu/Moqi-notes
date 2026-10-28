/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import * as React from 'react'
import { useEffect, useState } from 'react'
import { Icon, type IconName } from './Icon'

/**
 * 键盘上方格式栏（`10` §6.3 · 定稿）= 桌面常驻格式栏的移动端。
 *
 * 形态（工具栏线框（已归档） §一 · 先整体后局部）：
 * - **主条九键**（一行 · 贴键盘顶 46px）：`plus 插入` · `heading 文本` · `type 文字` · `indent 段落`
 *   · `list 列表` · `undo 撤销` · `redo 重做` · `sparkles AI 助手` · `check 完成`。
 *  **九键一律 Lucide 线条图标（20px / 2px 圆头）**，与左滑胶囊 / 选择栏同一套 `Icon`——
 *   字阶与图标批：此前用 `＋ / Tт / Aa / ≡ / ☰ / ↩ / ↪ / ✦ / ✓` 字形拼贴，笔画、大小、基线各不相同。
 * - **四张就地面板**（点主条键 → 浮在主条正上方；**键盘不退、选区不丢**；再点同键收起、点其他键切换；
 *   当前值点亮）：`heading` T＋H₁–H₆ · `type` 六枚线条图标（bold / italic / strike / underline /
 *   inline-code / highlight）· `indent` 缩进/反缩进/上移/下移 · `list` 无序/有序/待办。
 * - **插入面板**（点 `plus` → **收键盘、占键盘位**；2 列 5 行；选一格 = 插入并恢复键盘与焦点）：
 *   图片 / 拍照 / 待办 / 引用 / 代码块 / 分割线 / `链接 ›` / `日期时间 ›` / 附件块 / 嵌入块。
 *   列表面板格子**只印图标**（中文名进 aria/title，`MOBILE-ICON-1`）；插入面板 2 列大格带名是设计。
 *
 * **退役（同批）**：两段式与 `⇄` 段切换 · 左端常驻「完成」文字键 · 主条 `[[` · `＋块` 纵向 Sheet ·
 * 有选区自动切段（自动段机制）。**撤销 / 重做**无历史时**不假禁用**（引擎不暴露字符级历史可用性——
 * 点击为 no-op，见 `10` §6.3）；`check 完成` = 退出编辑。
 *
 * 不 import 内核（边界门 ③）：格式集合、块类型、历史步进都由外壳 / 触控层递进来。
 */

/** 行内格式集合（`10` §6.3 · `Aa` 面板六项；结构型收窄，免 import lexical 的类型）。 */
export type InlineFormat = 'bold' | 'italic' | 'underline' | 'strikethrough' | 'code' | 'highlight'

/** `Tт` / `☰` 面板能转的块类型（结构型收窄）。 */
export type ConvertKind = 'text' | 'heading1' | 'heading2' | 'heading3' | 'heading4' | 'heading5' | 'heading6' | 'bullet' | 'numbered' | 'todo'

/** 插入面板的格位（`10` §6.3 格位表十格）。 */
export type InsertTile = 'image' | 'camera' | 'todo' | 'quote' | 'code' | 'divider' | 'link' | 'datetime' | 'file' | 'embed'

type Panel = 'text' | 'char' | 'list' | null

/** 记法 = 图标语义（`10` §6.3 首段）：主条九个动作键与 `Aa` 面板六项都用 Lucide 线条图标
 *  （20px / 2px 圆头），与左滑胶囊 / 选择栏同一套；`Tт` 面板的 H₁–H₆ 是**样式名**，保留文字标签。
 *  中文名进 aria / title。 */
const TEXT_ITEMS: { kind: ConvertKind; label: string }[] = [
  { kind: 'text', label: 'T' },
  { kind: 'heading1', label: 'H₁' }, { kind: 'heading2', label: 'H₂' }, { kind: 'heading3', label: 'H₃' },
  { kind: 'heading4', label: 'H₄' }, { kind: 'heading5', label: 'H₅' }, { kind: 'heading6', label: 'H₆' },
]

const CHAR_ITEMS: { format: InlineFormat; icon: IconName; title: string }[] = [
  { format: 'bold', icon: 'bold', title: '加粗' },
  { format: 'italic', icon: 'italic', title: '斜体' },
  { format: 'strikethrough', icon: 'strike', title: '删除线' },
  { format: 'underline', icon: 'underline', title: '下划线' },
  { format: 'code', icon: 'inline-code', title: '行内代码' },
  { format: 'highlight', icon: 'highlight', title: '高亮' },
]

const LIST_ITEMS: { kind: ConvertKind; icon: 'list' | 'list-numbered' | 'check-square'; label: string }[] = [
  { kind: 'bullet', icon: 'list', label: '无序' },
  { kind: 'numbered', icon: 'list-numbered', label: '有序' },
  { kind: 'todo', icon: 'check-square', label: '待办' },
]

const INSERT_TILES: { tile: InsertTile; icon: IconName; label: string; sub?: true }[] = [
  { tile: 'image', icon: 'image', label: '图片' },
  { tile: 'camera', icon: 'camera', label: '拍照' },
  { tile: 'todo', icon: 'check-square', label: '待办' },
  { tile: 'quote', icon: 'quote', label: '引用' },
  { tile: 'code', icon: 'code', label: '代码块' },
  { tile: 'divider', icon: 'minus', label: '分割线' },
  { tile: 'link', icon: 'link', label: '链接', sub: true },
  { tile: 'datetime', icon: 'calendar', label: '日期时间', sub: true },
  { tile: 'file', icon: 'paperclip', label: '附件块' },
  { tile: 'embed', icon: 'embed', label: '嵌入块' },
]

/** M5：媒体类插入格（与桌面 `MEDIA_INSERT_KINDS` 同一口径——图片 / 拍照 / 附件 / 嵌入）。 */
const MEDIA_TILES: ReadonlySet<InsertTile> = new Set(['image', 'camera', 'file', 'embed'])

/**
 * **保焦点**（与选区气泡同一条做法，见 `TouchBubble` 的 `onMouseDown={prevent}`）：
 * 真机上点主条 / 面板 / 插入面板的 `<button>` 会先把焦点从正文根抢走 ⇒ 软键盘收起、视口重排
 * （宿主 `adjustResize` + IME inset 让 WebView 变高），点按落在移位后的位置、选区也可能塌掉——
 * 用户 报的「工具栏没法点、不能操作」就是这条。`mousedown` 取消默认 = 焦点不离开正文，
 * 键盘不退、选区不丢（`10` §6.3 的「键盘不退、选区不丢」由此兑现）；**click 仍照常派发**。
 */
const prevent = (event: { preventDefault: () => void }) => event.preventDefault()

export function MobileFmtBar({ formats, blockKind, openCharSignal = 0, onToggleFormat, onConvert, onIndent, onMoveStep, onHistory, onInsert, onOpenInsertPanel, onExit, media = true }: {
  /** 选区 / 待输入的现有格式（`Aa` 面板点亮）。 */
  formats: string[]
  /** 选区气泡「格式 ▸」的信号：变化一次 → 收起插入面板、`Aa` 面板就位。 */
  openCharSignal?: number
  /** 当前编辑块的类型（`Tт` / `☰` 面板点亮）。 */
  blockKind: string
  onToggleFormat: (format: InlineFormat) => void
  onConvert: (kind: ConvertKind) => void
  onIndent: (direction: 'indent' | 'outdent') => void
  onMoveStep: (direction: -1 | 1) => void
  onHistory: (redo: boolean) => void
  onOpenAiPanel: () => void
  onInsert: (tile: InsertTile, sub?: 'ext' | 'page' | 'today' | 'now') => void
  /** 插入面板开关：开 = 收键盘（触控层做 blur 与键盘高快照）、关 = 焦点与键盘回来。 */
  onOpenInsertPanel: (open: boolean) => void
  onExit: () => void
  /** M5 可选能力：透传给插入面板。 */
  media?: boolean
}) {
  const [panel, setPanel] = useState<Panel>(null)
  const [insert, setInsert] = useState(false)

  const closeInsert = () => { setInsert(false); onOpenInsertPanel(false) }
  const openInsert = () => {
    setPanel(null)
    setInsert(true)
    onOpenInsertPanel(true)
  }
  const togglePanel = (next: Exclude<Panel, null>) => {
    if (insert) closeInsert()
    setPanel((current) => (current === next ? null : next))
  }

  // 点面板 / 主条**之外**（正文等）= 收起面板（`10` §6.3 定稿的四条退出路之一）：
  // 捕获阶段听 `pointerdown`，落点在主条 / 就地面板 / 插入面板之内则不关。
  useEffect(() => {
    if (panel === null && !insert) return
    const onDown = (event: PointerEvent) => {
      // **Element 不是 HTMLElement**：图标化后就地面板的按钮里是 `<svg><path>`，用 HTMLElement 判定会把
   // 点图标当成「点了面板外面」——pointerdown 先把面板关掉，click 永远到不了按钮（ 验收
      // 逮到：`Aa` 六格全点不动、面板反而收起）。closest 在 Element 上就有，SVG 也吃。
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.mbar, .mbar-panel, .mbar-sheet')) return
      setPanel(null)
      if (insert) closeInsert()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [panel, insert]) // eslint-disable-line react-hooks/exhaustive-deps

  // 选区气泡「格式 ▸」：关气泡、`Aa` 面板就位（`10` §6.3）——信号变化一次就进面板。
  // 渲染期派生（React 官方"随 props 调整 state"式）：不能在 effect 里同步 setState（会级联渲染）。
  const [lastSignal, setLastSignal] = useState(openCharSignal)
  if (openCharSignal !== lastSignal) {
    setLastSignal(openCharSignal)
    if (openCharSignal > 0) { setInsert(false); setPanel('char') }
  }

  const inList = blockKind === 'bullet' || blockKind === 'numbered' || blockKind === 'todo'
  const inHeading = blockKind.startsWith('heading')
  const inCode = blockKind === 'code'

  return (
    <>
      {insert ? (
        <MobileInsertPanel
          onPick={(tile, subKind) => {
            if (subKind === 'ext') closeInsert(); else if (subKind === 'page') closeInsert();
            onInsert(tile, subKind)
            // 选一格 = 插入并**恢复键盘与焦点**（`10` §6.3）：关面板（触控层在关闭时 focus 正文字根）。
            if (!subKind) closeInsert()
          }}
          media={media}
        />
      ) : null}

      {panel === 'text' ? (
        <div className="mbar-panel" role="toolbar" aria-label="文本样式" onMouseDown={prevent}>
          {TEXT_ITEMS.map((item) => (
            <button key={item.kind} type="button" className={(!inList && !inHeading && !inCode && item.kind === 'text') || blockKind === item.kind ? 'is-on' : ''} aria-label={item.label} onClick={() => onConvert(item.kind)}>{item.label}</button>
          ))}
        </div>
      ) : null}
      {panel === 'char' ? (
        <div className="mbar-panel" role="toolbar" aria-label="文字格式" onMouseDown={prevent}>
          {CHAR_ITEMS.map((item) => {
            const on = formats.includes(item.format)
            return (
              <button key={item.format} type="button" className={on ? 'is-on' : ''} aria-pressed={on} aria-label={item.title} title={item.title} onClick={() => onToggleFormat(item.format)}>
                <span className="mi"><Icon name={item.icon} size={20} decorative /></span>
              </button>
            )
          })}
        </div>
      ) : null}
      {panel === 'list' ? (
        <div className="mbar-panel" role="toolbar" aria-label="列表与段落" onMouseDown={prevent}>
          {LIST_ITEMS.map((item) => (
            <button key={item.kind} type="button" className={blockKind === item.kind ? 'is-on' : ''} aria-label={item.label} title={item.label} onClick={() => onConvert(item.kind)}>
              <span className="mi"><Icon name={item.icon} size={20} decorative /></span>
            </button>
          ))}
          <span className="mbar-sep" aria-hidden="true" />
          <button type="button" aria-label="缩进" title="缩进" onClick={() => onIndent('indent')}><span className="mi"><Icon name="indent" size={20} decorative /></span></button>
          <button type="button" aria-label="反缩进" title="反缩进" onClick={() => onIndent('outdent')}><span className="mi"><Icon name="outdent" size={20} decorative /></span></button>
          <button type="button" aria-label="上移" title="上移" onClick={() => onMoveStep(-1)}><span className="mi"><Icon name="chevron-up" size={20} decorative /></span></button>
          <button type="button" aria-label="下移" title="下移" onClick={() => onMoveStep(1)}><span className="mi"><Icon name="chevron-down" size={20} decorative /></span></button>
        </div>
      ) : null}

      <div className={`mbar${insert ? ' is-insert' : ''}`} role="toolbar" aria-label="编辑工具栏" onMouseDown={prevent}>
        <button type="button" className={insert ? 'is-on' : ''} aria-expanded={insert} aria-label="插入" title="插入" onClick={() => (insert ? closeInsert() : openInsert())}><span className="mi"><Icon name="plus" size={20} decorative /></span></button>
        <button type="button" className={panel === 'text' ? 'is-on' : ''} aria-expanded={panel === 'text'} aria-label="文本样式" title="文本样式" onClick={() => togglePanel('text')}><span className="mi"><Icon name="heading" size={20} decorative /></span></button>
        <button type="button" className={panel === 'list' ? 'is-on' : ''} aria-expanded={panel === 'list'} aria-label="列表与段落" title="列表与段落" onClick={() => togglePanel('list')}><span className="mi"><Icon name="list" size={20} decorative /></span></button>
        <button type="button" aria-label="撤销" title="撤销" onClick={() => onHistory(false)}><span className="mi"><Icon name="undo" size={20} decorative /></span></button>
        <button type="button" aria-label="重做" title="重做" onClick={() => onHistory(true)}><span className="mi"><Icon name="redo" size={20} decorative /></span></button>
        <button type="button" className="mbar-done" aria-label="完成" title="完成（退出编辑）" onClick={onExit}><span className="mi"><Icon name="check" size={20} decorative /></span></button>
      </div>
    </>
  )
}

/** 插入面板（`10` §6.3 定稿 · 2 列 5 行十格）：打字态主条与块胶囊共用同一张。
 *  `direction` = 胶囊的方向段控（`↑上方 / ↓下方`，落点 = 选区上 / 下）；打字态不带（落点 = 光标块下方）。
 *  子菜单（`链接 ›` / `日期时间 ›`）**就地展开两行**，不另开层级。 */
export function MobileInsertPanel({ direction, onPick, media = true }: {
  direction?: { value: 'above' | 'below'; onChange: (value: 'above' | 'below') => void }
  onPick: (tile: InsertTile, sub?: 'ext' | 'page' | 'today' | 'now') => void
  /** M5 可选能力：媒体关闭时不出图片 / 拍照 / 附件 / 嵌入格。 */
  media?: boolean
}) {
  const [sub, setSub] = useState<'link' | 'date' | null>(null)
  return (
    <div className="mbar-sheet" role="dialog" aria-label="插入" onMouseDown={prevent}>
      {direction ? (
        <div className="mbar-dir">
          <span>插到：</span>
          <span className="seg">
            <button type="button" className={direction.value === 'above' ? 'on' : ''} onClick={() => direction.onChange('above')}>↑ 上方</button>
            <button type="button" className={direction.value === 'below' ? 'on' : ''} onClick={() => direction.onChange('below')}>↓ 下方</button>
          </span>
        </div>
      ) : null}
      {sub === 'link' ? (
        <div className="mbar-subrow">
          <button type="button" onClick={() => onPick('link', 'ext')}>
            <span className="mi"><Icon name="external-link" size={20} decorative /></span>
            <span>外部链接</span>
          </button>
          <button type="button" onClick={() => onPick('link', 'page')}>
            <span className="mi"><Icon name="brackets" size={20} decorative /></span>
            <span>页面链接</span>
          </button>
        </div>
      ) : sub === 'date' ? (
        <div className="mbar-subrow">
          <button type="button" onClick={() => onPick('datetime', 'today')}><span>今天</span></button>
          <button type="button" onClick={() => onPick('datetime', 'now')}><span>现在</span></button>
        </div>
      ) : null}
      <div className="mbar-grid">
        {(media ? INSERT_TILES : INSERT_TILES.filter((item) => !MEDIA_TILES.has(item.tile))).map((item) => (
          <button
            key={item.tile}
            type="button"
            className="mbar-tile"
            aria-label={item.label}
            /* D-100：Android 壳的文件选择器（wry ACTION_GET_CONTENT）不透传 capture ⇒「拍照」
               只会打开文档管理器（用户实测）——能力如实禁用；真相机要改原生 onShowFileChooser，登记原生批。 */
            disabled={item.tile === 'camera' && document.body.classList.contains('is-android')}
            title={item.tile === 'camera' && document.body.classList.contains('is-android') ? '当前安卓壳暂不能拉起相机——请用「图片」格从相册选照片' : item.label}
            onClick={() => {
              if (item.tile === 'link') { setSub('link'); return }
              if (item.tile === 'datetime') { setSub('date'); return }
              onPick(item.tile)
            }}
          >
            <span className="mi"><Icon name={item.icon} size={20} decorative /></span>
            <span>{item.label}</span>
            {item.sub ? <span className="chev"><Icon name="chevron-right" size={16} decorative /></span> : null}
          </button>
        ))}
      </div>
    </div>
  )
}
