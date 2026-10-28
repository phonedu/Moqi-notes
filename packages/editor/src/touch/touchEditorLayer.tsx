/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import * as React from 'react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { DropPosition } from '../editor/dropTargets'
import { BlockCapsule, SelectionBar, type BlockCapsuleOps } from './BlockCapsule'
import { MobileFmtBar } from './MobileFmtBar'
import { TouchBubble } from './TouchBubble'
import { clearDropLine, showDropLine } from './dropLine'
import { useImeInset } from './useImeInset'
import { useStableCallback } from '../editor/useStableCallback'
import { Icon } from './Icon'
import { ensureCaretVisible } from '../editor/touchFocus'

/**
 * 触控编辑层（`10` §6.2 / §6.3， 从 `editorPlugins` 抽出——体量门「按主题拆模块」）：
 * 触控编辑态的**事件路由**（可编辑开关 / 只读态双击进编辑 / 编辑态**点另一块 = 光标一步到位**（θ6）/ 点空白退 /
 * 左滑进选择模式（**选中唯一入口**，γ1）/ 选择模式内拖拽（γ2））与
 * **三件浮动面**（键盘上方格式栏 · 选区气泡 · 块操作栏 / 选择栏）的渲染。
 * 宿主只负责把它接进来；`ui/` 不直连内核——内核开关走结构型 `editor` 口、整块格式读数由宿主传入。
 */

/**
 * 稳定的回调包装（自 `editorPlugins` 随触控面同迁，逐字保留）：返回值引用恒定，
 * 内部永远调用最新的 `fn`。用途见 `EditorPlugins` 顶部说明——「注册一次、回调取最新值」
 * 是编辑器插件 effect 的唯一形态：依赖里放父组件每次渲染新建的回调，会让 `registerNodeTransform`
 * 每次渲染都重跑，而它会把节点标脏并触发一次 `editor.update`，在焦点不在编辑器里时把焦点抢回正文
 * （用户现象：点页面标题进不去）。
 */

type TouchFmt = 'bold' | 'italic' | 'underline' | 'strikethrough' | 'code' | 'highlight'

export function useTouchEditorLayer({ editor, enabled, touchCompact, touchEditId, blockOps, formats, blockKind = 'text', onToggleFormat, onConvertBlock, onIndent, onMoveStep, onHistory, onInsertTile, onConvertLink, onLinkDialog, onOpenAiPanel, onOpenMedia, media = true, clipboard, onTouchActivate, onTouchFollow, onTouchBlank, onTouchExit }: {
  /** 结构型内核口（`ui/` 不许直连 lexical——边界门 ③）。 */
  editor: {
    setEditable: (value: boolean) => void
    registerRootListener: (listener: (rootElement: HTMLElement | null, previousElement: HTMLElement | null) => void) => () => void
    /** θ12：进选择模式要**收键盘**（blur 正文字根）——`LexicalEditor` 结构上就有这一口。 */
    getRootElement: () => HTMLElement | null
    /** D-098：滚动跟随订阅每次编辑器更新（打字/换行后把光标块保持在视口内）。 */
    registerUpdateListener: (listener: () => void) => () => void
  }
  enabled: boolean
  touchCompact: boolean
  touchEditId: string | null
  blockOps: BlockCapsuleOps
  formats: string[]
  /** 当前**编辑块**的类型（`Tт` / `☰` 面板点亮；宿主从领域读，缺省 = 正文）。 */
  blockKind?: string
  onToggleFormat: (format: TouchFmt) => void
  /** `Tт` / `☰` 就地面板：转当前编辑块的类型（定稿九键的主条面板）。 */
  onConvertBlock: (kind: string) => void
  /** `≡` 段落面板：缩进 / 反缩进（对标册 `A-1` 落位）与上移 / 下移。 */
  onIndent: (direction: 'indent' | 'outdent') => void
  onMoveStep: (direction: -1 | 1) => void
  /** `↩` / `↪`：走与 `⌘Z` 同一条路由（`θ11`）。 */
  onHistory: (redo: boolean) => void
  /** 插入面板格位（`image` / `camera` / …；链接与日期时间的二态由 `sub` 区分）。 */
  onInsertTile: (tile: string, sub?: 'ext' | 'page' | 'today' | 'now') => void
  onConvertLink: () => void
  onLinkDialog: () => void
  onOpenAiPanel: () => void
  /** 开图片预览（灯箱）——图片工具条的「扩展」键走它（`R09-BLOCK-19/20`）。 */
  onOpenMedia: (blockId: string) => void
  /** M5 可选能力：媒体关闭时插入面板不出媒体格（透传给胶囊 / 选择栏 / 格式栏）。 */
  media?: boolean
  /** 剪贴板端口注入（D-104）：透传给选区气泡（复制 / 粘贴走宿主能力）。 */
  clipboard: { readText(): Promise<string>; writeText(text: string): Promise<void> }
  onTouchActivate: (blockId: string) => void
 /** θ6（）：编辑态点另一块——**只**把「编辑块」标记跟过去，不抢焦点、不动光标。 */
  onTouchFollow: (blockId: string) => void
  onTouchBlank: () => void
  onTouchExit: () => void
}): ReactNode {
  // 键盘高度（`#8`）：**全应用唯一挂载点**——写运行时变量 `--kb-h`，供 `app.css` 的
  // `.doc-col` 底部预留与下沿浮层族（`.mbar`/`.capsule`/`.sheet`/`.mdock`/`.side-panel`/compact `.mask`）消费。
  // 住这里而不是各组件各读一遍：本 hook 随编辑器常驻（`editorPlugins` 无条件调用），是天然的单一挂载点。
  useImeInset()
  const imeInset = useImeInset()
  const [bubbleFormatAsk, setBubbleFormatAsk] = useState(0)
  const [selectMode, setSelectMode] = useState(false)
  /** 图片工具条（真机第 4 条）：编辑态点图**不直接开灯箱**，先在地弹一条（扩展 / 上插 / 下插 / 删除）。 */
  const [imageBarId, setImageBarId] = useState<string | null>(null)
  const [imageBarBox, setImageBarBox] = useState<{ top: number; left: number } | null>(null)
  // γ2：拖拽手势要用「**当下的**」选区与 `moveGroup`（事件监听 effect 只注册一次，闭包会过期）——用 ref 读最新值。
  const selectedIdsRef = useRef<string[]>(blockOps.selectedIds)
  const moveGroupRef = useRef(blockOps.moveGroup)
  useEffect(() => { selectedIdsRef.current = blockOps.selectedIds }, [blockOps.selectedIds])
  useEffect(() => { moveGroupRef.current = blockOps.moveGroup }, [blockOps.moveGroup])

 // `#8` 焦点可见性**硬保证**（）：块高于可视区时 `block:'nearest'` 只保证块边缘——
  // 键盘高度一变（弹起 / 收起 / 切输入法）就按**光标矩形**再把当前行顶进可视区。
  useEffect(() => {
    if (touchCompact && touchEditId !== null) ensureCaretVisible()
  }, [imeInset, touchCompact, touchEditId])
  const toggleSelectStable = useStableCallback((blockId: string) => blockOps.toggleSelect(blockId))
  const activateStable = useStableCallback(onTouchActivate)
  const followStable = useStableCallback(onTouchFollow)
  /* D-098：触控编辑态的**滚动跟随**——此前 followTouchBlock 只改状态、从不滚动，点另一块（θ6）
     或键盘弹出后页面不动（用户  报「编辑时页面不随移动」）。三个触发点共用 nearest
     滚动（块已在视口内 = no-op，不抖动）：① 进入/切换编辑块立刻滚一次；② visualViewport resize
     （键盘弹出/收起都触发，.doc-col 底部 padding 已含 --kb-h ⇒ nearest 一定可达键盘上方）；
     ③ 编辑器每次更新（打字/换行把光标顶下去时）。 */
  useEffect(() => {
    if (!touchCompact || touchEditId === null) return
    const scroll = () => {
      document.querySelector<HTMLElement>(`.moqi-block[data-entity-id="${touchEditId}"]`)?.scrollIntoView({ block: 'nearest' })
    }
    scroll()
    const vv = window.visualViewport
    vv?.addEventListener('resize', scroll)
    const unlisten = editor.registerUpdateListener(scroll)
    return () => { vv?.removeEventListener('resize', scroll); unlisten() }
  }, [editor, touchCompact, touchEditId])
  const blankStable = useStableCallback(onTouchBlank)

  // 退编辑态（含 Esc / 完成）时一并退选择模式；选择模式的圈钮画在 `.doc-col` 的类上。
  useEffect(() => { if (touchEditId === null || !touchCompact) setSelectMode(false) }, [touchEditId, touchCompact])
  useEffect(() => {
    // 选择模式的圈钮要**同一条线**（真机第 5 条）：子块右缘比父块内收，逐块量出差值写在块上，
    // CSS 用 `right: calc(41px - var(--sel-dx))` 补偿；退出模式时清干净（别把量值留在 DOM 上）。
    const col = document.querySelector<HTMLElement>('.doc-col')
    const on = selectMode && touchCompact && touchEditId !== null
    const measure = () => {
      if (!col) return
      const right = col.getBoundingClientRect().right
      for (const element of col.querySelectorAll<HTMLElement>('.editor-content .moqi-block[data-entity-id]:not([data-block-object="true"])')) {
        element.style.setProperty('--sel-dx', `${Math.round(right - element.getBoundingClientRect().right)}px`)
      }
    }
    if (on && col) measure()
    else if (col) for (const element of col.querySelectorAll<HTMLElement>('.moqi-block[data-entity-id]')) element.style.removeProperty('--sel-dx')
    // 模式内**结构会变**（拖拽移动 / 缩进 / 删除都改块的宽度与位置）⇒ 量值要跟着重算，否则圈钮又错位。
    // 只挂一条 childList 观察者、回调走 rAF（不做属性观察，避免自己写 `--sel-dx` 触发循环）。
    const content = col?.querySelector('.editor-content')
    const observer = on && content ? new MutationObserver(() => requestAnimationFrame(measure)) : null
    if (observer && content) observer.observe(content, { childList: true, subtree: true })
    document.querySelector('.doc-col')?.classList.toggle('is-select-mode', selectMode && touchCompact && touchEditId !== null)
    return () => observer?.disconnect()
  }, [selectMode, touchCompact, touchEditId])
 // θ9（ 用户走查「多选后取消不掉」）：**选区清空 ⇒ 退出选择模式**——形态阶梯里 0 块没有形态。
  // 旧行为：模式留着 ⇒ `.is-select-mode` 还挂在 `.doc-col` 上（圈钮照画、点块仍走 toggle 分支），
  // 「谁点都取消不掉」。这条是**兜底**（删除 / 剪切 / ✓完成 / 点块 等所有清空路径都收口在这里）。
  useEffect(() => { if (selectMode && blockOps.selectedIds.length === 0) setSelectMode(false) }, [selectMode, blockOps.selectedIds]) // eslint-disable-line react-hooks/set-state-in-effect -- 一次性纠正（置 false 后条件即不成立，无级联）；清空路径多且不在本层（删除 / 剪切 / ✓完成），只能在这收口

  // 图片工具条的落点：跟着图片走（滚动 / 转屏都重算）；图片滚出视口就收起来（没有可锚的东西）。
  useEffect(() => {
    if (imageBarId === null) { setImageBarBox(null); return }
    const place = () => {
      const element = document.querySelector<HTMLElement>(`.moqi-block-image[data-entity-id="${imageBarId}"]`)
      if (!element) { setImageBarBox(null); return }
      const rect = element.getBoundingClientRect()
      const BAR = 48
      const top = rect.top > BAR + 12 ? rect.top - BAR - 6 : Math.min(rect.bottom + 6, window.innerHeight - BAR - 8)
      setImageBarBox({ top: Math.max(8, top), left: Math.max(8, Math.min(rect.left, window.innerWidth - 176 - 8)) })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [imageBarId])

  // 触控编辑态（`10` §6.3）：compact 档且不在编辑态 ⇒ 编辑器**整体只读**（只读态单击无操作、
 // 双击块进编辑）；编辑态内**点另一块 = 光标一步到位**（θ6，：`mousedown` 不再拦，
  // 让 Lexical 把光标放到点按处）、点空白 = 退编辑。
  useEffect(() => {
    editor.setEditable(!touchCompact || touchEditId !== null)
  }, [editor, touchCompact, touchEditId])

  useEffect(() => {
    if (!enabled || !touchCompact) return
    const blockIdOf = (event: Event): string | null => {
      const target = event.target instanceof HTMLElement ? event.target : null
      return target?.closest<HTMLElement>('.moqi-block')?.dataset.entityId ?? null
    }
    /** 点到图片块了没有（图片工具条的入口条件；点图注不算——图注是文字，走正常编辑）。 */
    const imageIdOf = (event: Event): string | null => {
      const target = event.target instanceof HTMLElement ? event.target : null
      const image = target?.closest<HTMLElement>('.moqi-block-image')
      if (!image) return null
      const rect = image.getBoundingClientRect()
      const ratio = Number(image.dataset.assetRatio ?? '') || 16 / 9
      return event instanceof MouseEvent && event.clientY - rect.top > rect.width / ratio + 4 ? null : (image.dataset.entityId ?? null)
    }
    const onMouseDown = (event: MouseEvent) => {
      if (touchEditId === null) return
      const blockId = blockIdOf(event)
      // **只**在选择模式里拦光标（点块 = 增删选区，不让光标挪动）。编辑态点另一块**不拦**：
      // 让 Lexical 把光标放到点按处 = θ6 的「一步到位」（旧行为是拦掉 ⇒ 要点两下才过去）。
      if (blockId && selectMode) event.preventDefault()
   // 还得截住冒泡（`D-058`，探针实证 ）：正文根的 `onMouseDown` 是 React 合成层
      // 派发的「点正文退块选中」出口——不截它，选区会在 mousedown 阶段被清空，随后 click 里的
      // toggle 从空集加回，点块只剩「替换式单选」（选中子块后点容器 → 只落成 {容器}）。
      if (blockId && selectMode) event.stopPropagation()
    }
    const onClick = (event: MouseEvent) => {
      if (touchEditId === null) return
      // 滑动进入选择模式后浏览器还会补发一次 click（同点同位），吞掉它——否则刚滑选的块当场又被切掉。
      if (swallowed) { swallowed = false; return }
      const blockId = blockIdOf(event)
      if (selectMode) {
        setImageBarId(null)
        if (!blockId) { setSelectMode(false); blankStable(); return }
        // θ9：点掉**最后一块** = 回打字态（模式退出由上面那条兜底 effect 收口；这里顺手把焦点还回去）。
        const wasLast = selectedIdsRef.current.length === 1 && selectedIdsRef.current[0] === blockId
        toggleSelectStable(blockId)
        if (wasLast) blankStable()
        return
      }
      // 图片（真机第 4 条）：编辑态点图 = 就地弹工具条（**不**开灯箱；扩展键才进）。图注 / 已点开的再点 = 收起。
      const imageId = imageIdOf(event)
      if (imageId) { setImageBarId((current) => (current === imageId ? null : imageId)); return }
      setImageBarId(null)
   // θ6（ 用户走查「点另一块要双击、光标不灵敏」）：编辑态单击另一块 = **光标一步到位**——
      // 光标已由 Lexical 落在点按处（`onMouseDown` 不再拦），这里只把「编辑块」标记跟过去。
      // **不调 `activateStable`**：那条会 `focusBlockEnd` 把光标推到块尾，正好毁掉「点哪儿落哪儿」。
      // γ1 不动：**选中**入口仍只剩左滑（点块不入选区）。
      if (blockId && blockId !== touchEditId) followStable(blockId)
    }
    const onDblClick = (event: MouseEvent) => {
      // 只读态专用入口（`10` §6.3）：编辑态里单击已「一步到位」（θ6）⇒ 双击不再换焦点——
      // 留着它只会在连点时把光标推到块尾（`focusBlockEnd`），与上一条打架。
      if (touchEditId !== null) return
      const blockId = blockIdOf(event)
      if (blockId) activateStable(blockId)
    }
    // 点空白退（`10` §6.3）：空白的命中区在**编辑器根之外**（`.doc-col` 的内边距 / 块间空带）——
    // 根上的监听收不到它，挂在滚动容器上；块内点击一概放过（否则与根监听双响）。
    const onBlankClick = (event: Event) => {
      if (touchEditId === null) return
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target?.closest('.moqi-block')) return
      setSelectMode(false)
      blankStable()
    }
    // 选择模式入口（`10` §6.2 · 3b）：**左滑**（非边缘 32dp 起手、横移 ≥40、纵移 ≤24）——
    // 滑到的块顺手选上（备忘录式，进去就能多选）。
    let swipe: { x: number; y: number; blockId: string | null } | null = null
    let swallowed = false
  // γ2（）：**选择模式内拖整个选区**——按住**已选块**即刻成为候选（不等 400ms：
    // 「已选才能拖」本身就把歧义除干净），位移 > slop(10px) 才真进拖拽；**按住未选块不进拖拽**（让给滚动）。
    let dragCandidate: { x: number; y: number; ids: string[] } | null = null
    let dragging: { target: { id: string; position: DropPosition } | null } | null = null
    const blockElementOf = (id: string) => document.querySelector<HTMLElement>(`.moqi-block[data-entity-id="${id}"]`)
    const clearDropMarkers = () => { clearDropLine() }
    const clearDragVisual = () => {
      clearDropMarkers()
      for (const element of document.querySelectorAll<HTMLElement>('.moqi-block.is-dragging')) element.classList.remove('is-dragging')
    }
    /** 返回 true = 本次事件已被拖拽吃掉（调用方不再走左滑判据 / 不调 `preventDefault` 的默认路径）。 */
    const updateDrag = (x: number, y: number): boolean => {
      if (!selectMode) return false
      if (!dragging) {
        if (!dragCandidate) return false
        if (Math.hypot(x - dragCandidate.x, y - dragCandidate.y) <= 10) return false
        dragging = { target: null }
        swallowed = true // 吞掉随后的 click（否则抬手会把这块移出选区）
        for (const id of dragCandidate.ids) blockElementOf(id)?.classList.add('is-dragging')
      }
      const element = document.elementFromPoint(x, y)?.closest<HTMLElement>('.moqi-block[data-entity-id]') ?? null
      const targetId = element?.dataset.entityId ?? null
      const insideSelection = element !== null && dragCandidate !== null && dragCandidate.ids.some((id) => {
        const dragged = blockElementOf(id)
        return dragged === element || dragged?.contains(element) === true
      })
      clearDropMarkers()
      // 非法落点（自身 / 自身子树内）⇒ **不画插入线**，抬起回弹（不给「没反应」的错觉）
      if (!element || !targetId || insideSelection) { dragging.target = null; return true }
      const rect = element.getBoundingClientRect()
      const ratio = rect.height > 0 ? (y - rect.top) / rect.height : 0.5
      const position: DropPosition = ratio < 0.3 ? 'before' : ratio > 0.7 ? 'after' : 'into'
      dragging.target = { id: targetId, position }
      showDropLine(element, position)
      // 靠近视口上/下缘 ~48px ⇒ 自动滚（唯一滚动容器 = `.doc-col`）
      const scroller = document.querySelector<HTMLElement>('.doc-col')
      const box = scroller?.getBoundingClientRect()
      if (scroller && box) {
        if (y < box.top + 48) scroller.scrollTop -= 12
        else if (y > box.bottom - 48) scroller.scrollTop += 12
      }
      return true
    }
    /** 松手：有合法落点 ⇒ **一次事务**移动整组（`moveGroup`）；否则清干净回弹。**拖完留在选择模式**（不动 `selectMode`）。 */
    const finishDrag = () => {
      const ids = dragCandidate?.ids ?? []
      const target = dragging?.target ?? null
      clearDragVisual()
      dragging = null
      dragCandidate = null
      if (target && ids.length > 0) moveGroupRef.current(target.id, target.position)
    }
    const startSwipe = (x: number, y: number, target: EventTarget | null) => {
      // θ9：新一次按压 = 上一次手势的「吞一次」到此为止。拖拽时浏览器**不补发** click（移出过 slop），
      // 漏下的 `swallowed` 会把**下一次**真实点击吃掉（点块去不掉）——只有在这里清才安全：
      // 同一次手势补发的 click 一定早于下一次 `pointerdown`。
      swallowed = false
      if (touchEditId === null) return
      const element = target instanceof HTMLElement ? target : null
      swipe = { x, y, blockId: element?.closest<HTMLElement>('.moqi-block')?.dataset.entityId ?? null }
      // γ2：选择模式内按住**已选块** = 拖拽候选（选区随当时快照，避免拖到一半被改）
      if (selectMode && swipe.blockId && selectedIdsRef.current.includes(swipe.blockId)) {
        dragCandidate = { x, y, ids: [...selectedIdsRef.current] }
      }
    }
    const onPointerDown = (event: PointerEvent) => { startSwipe(event.clientX, event.clientY, event.target) }
    const advanceSwipe = (x: number, y: number) => {
      if (!swipe) return
      if (swipe.x <= 32) { swipe = null; return }
      const dx = x - swipe.x
      const dy = Math.abs(y - swipe.y)
      if (dx > -40 || dy > 24) return
      const start = swipe
      swipe = null
      swallowed = true
      setSelectMode(true)
   // θ12（ 用户裁定「做块操作时没人会动键盘」）：进选择模式 ⇒ **收键盘**——blur 正文字根，
      // 软键盘随焦点收起（下半屏让给块胶囊 / 选择栏）。退出的三个出口（✓完成 / 点空白 / 点掉最后一块）
      // 走 `blankStable` 的 `focus()`，键盘与格式栏按 `10` 二册 §6.2 回来。
      editor.getRootElement()?.blur()
      if (start.blockId) toggleSelectStable(start.blockId)
    }
    const onPointerMove = (event: PointerEvent) => { if (!updateDrag(event.clientX, event.clientY) && !selectMode) advanceSwipe(event.clientX, event.clientY) }
    // 窄窗模拟用鼠标拖：桌面鼠标拖拽下 Chromium 的 `pointermove` 流不到根上（实测）——`mousemove` 兜底，
    // 两条刺激共用同一套判据（触发后 `swipe` 置空，第二条事件自然空转）。
    const onMouseMove = (event: MouseEvent) => { if (!updateDrag(event.clientX, event.clientY) && !selectMode) advanceSwipe(event.clientX, event.clientY) }
    const onPointerUp = () => { swipe = null; finishDrag() }
    // **γ1 尾刀·触摸路径**（`10` 二册 §6.2「左滑」在真机上失效的成因）：编辑态正文是 `contentEditable`，
    // 浏览器会把横向拖动先判成**文字选区**、随后发 `pointercancel` 掐断 `pointermove` 流 —— 只靠
    // `pointermove` 的左滑判据在真机上永远拿不到阈值。修法：
    //   ① `touchstart`/`touchmove`（`passive: false`）与 pointer 刺激共用同一套判据；
    //   ② **命中左滑阈值的那一瞬 `preventDefault()`** —— 抢在浏览器提交选区之前吃掉这次手势；
    //   ③ `pointercancel` = 清空半截的 `swipe`（浏览器取消指针序列时不留脏状态）。
    // `touch-action: pan-y` 与 `-webkit-touch-callout: none` 在编辑态 CSS（`.doc-col.is-touch-edit`）里。
    const onTouchStart = (event: TouchEvent) => { if (event.touches.length === 1) startSwipe(event.touches[0].clientX, event.touches[0].clientY, event.target) }
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) return
      const touch = event.touches[0]
      const pending = swipe
      const moved = updateDrag(touch.clientX, touch.clientY)
      if (!moved && !selectMode) advanceSwipe(touch.clientX, touch.clientY)
      // 这一次手势刚被判为左滑（swipe 由非空变空）⇒ 吃掉它，别让浏览器接着做选区/滚动。
      if (pending && !swipe) event.preventDefault()
      // 拖拽中一律吃掉：不让浏览器滚动 / 选词（模式内也已 `user-select:none`）。
      if (moved) event.preventDefault()
    }
    const onPointerCancel = () => { swipe = null; clearDragVisual(); dragging = null; dragCandidate = null }
    // 根元素由 Lexical 在挂载后提供，用 rootListener 保证监听器总是挂在正确的节点上。
    // 本 effect 会重注册（`selectMode` / `touchEditId` 变），旧挂点摘/加都走这个回调；cleanup 里
    // 再显式摘一次是**防御性对称**（`removeEventListener` 幂等；本版 Lexical 退订会回调 `(null, prev)`，
  // 读 `lexical/dist/Lexical.dev.js` 核过—— 的「退订不回调、监听器泄漏」旧线索已证伪，
    // 它不是点块替换式单选的成因，真因见 `onMouseDown` 里的 `D-058` 注）。
    let attached: HTMLElement | null = null
    const detach = (element: HTMLElement) => {
      element.removeEventListener('mousedown', onMouseDown)
      element.removeEventListener('click', onClick)
      element.removeEventListener('dblclick', onDblClick)
      element.removeEventListener('pointerdown', onPointerDown)
      element.removeEventListener('pointermove', onPointerMove)
      element.removeEventListener('pointerup', onPointerUp)
      element.removeEventListener('pointercancel', onPointerCancel)
      element.removeEventListener('touchstart', onTouchStart)
      element.removeEventListener('touchmove', onTouchMove)
      element.removeEventListener('mousemove', onMouseMove)
      element.closest('.doc-col')?.removeEventListener('click', onBlankClick)
    }
    const attach = (element: HTMLElement) => {
      element.addEventListener('mousedown', onMouseDown)
      element.addEventListener('click', onClick)
      element.addEventListener('dblclick', onDblClick)
      element.addEventListener('pointerdown', onPointerDown)
      element.addEventListener('pointermove', onPointerMove)
      element.addEventListener('pointerup', onPointerUp)
      element.addEventListener('pointercancel', onPointerCancel)
      element.addEventListener('touchstart', onTouchStart, { passive: false })
      element.addEventListener('touchmove', onTouchMove, { passive: false })
      element.addEventListener('mousemove', onMouseMove)
      element.closest('.doc-col')?.addEventListener('click', onBlankClick)
    }
    const unregister = editor.registerRootListener((rootElement) => {
      if (attached) detach(attached)
      attached = rootElement
      if (rootElement) attach(rootElement)
    })
    return () => {
      unregister()
      if (attached) detach(attached)
      attached = null
    }
  }, [editor, enabled, touchCompact, touchEditId, selectMode, toggleSelectStable, activateStable, followStable, blankStable])

  if (!(touchCompact && touchEditId !== null)) return null
  return (
    <>
      {/* 图片工具条（真机第 4 条）：扩展 = 进灯箱；上下加块 = 正文块；删除 = 定点删这一块。 */}
      {imageBarId !== null && imageBarBox ? (
        <div className="img-bar" role="toolbar" aria-label="图片工具" style={{ top: imageBarBox.top, left: imageBarBox.left }}>
          <button type="button" aria-label="扩展" title="扩展（打开图片预览）" onClick={() => { const id = imageBarId; setImageBarId(null); onOpenMedia(id) }}>
            <Icon name="expand" size={18} decorative />
          </button>
          <button type="button" aria-label="在上方加块" title="在上方加一个正文块" onClick={() => { blockOps.insertSibling(imageBarId, 'above'); setImageBarId(null) }}>
            <Icon name="chevron-up" size={18} decorative />
          </button>
          <button type="button" aria-label="在下方加块" title="在下方加一个正文块" onClick={() => { blockOps.insertSibling(imageBarId, 'below'); setImageBarId(null) }}>
            <Icon name="chevron-down" size={18} decorative />
          </button>
          <button type="button" className="is-danger" aria-label="删除图片块" title="删除这个图片块" onClick={() => { blockOps.remove([imageBarId]); setImageBarId(null) }}>
            <Icon name="trash" size={18} decorative />
          </button>
        </div>
      ) : null}
      {blockOps.selectedIds.length > 0 ? (
    // **形态阶梯**（`10` 二册 §6.2， 裁定）：左滑是唯一入口；进模式后
        // **恰好 1 块 → 块胶囊（两行制）**、**≥2 块 → 选择栏（单行）**。两栏互斥。
        // 切栏 = 底边对齐 + `--dur-mid` 交叉淡入（`.capsule` 的 `animation`），**不做高度动画**。
        selectMode && blockOps.selectedIds.length > 1 ? (
          <SelectionBar
            count={blockOps.selectedIds.length}
            ops={blockOps}
            onDone={() => { setSelectMode(false); blankStable() }}
            media={media}
          />
        ) : (
          <BlockCapsule ops={blockOps} onDone={onTouchBlank} media={media} />
        )
      ) : (
        <>
          <MobileFmtBar
            formats={formats}
            blockKind={blockKind}
            openCharSignal={bubbleFormatAsk}
            onToggleFormat={onToggleFormat}
            onConvert={onConvertBlock}
            onIndent={onIndent}
            onMoveStep={onMoveStep}
            onHistory={onHistory}
            onOpenAiPanel={onOpenAiPanel}
            media={media}
            onInsert={(tile, sub) => onInsertTile(String(tile), sub)}
            onOpenInsertPanel={(open) => {
              // `10` §6.3：插入面板**占键盘位**——开 = 快照键盘高并 blur 正文字根（键盘真收）；
              // 关 = 焦点与键盘回来。快照写成 `--kb-snap` 供面板 `max-height` 用（键盘动画期不抖）。
              const root = editor.getRootElement()
              if (open) {
                // 面板高度 = 打开时的键盘高快照；键盘不在场（或很矮）时给 340 兜底——
                // 否则面板会是 0 高（连点都点不到）。主条留在面板正上方（`.mbar.is-insert`）。
                const kb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--kb-h'))
                document.documentElement.style.setProperty('--kb-snap', Number.isFinite(kb) && kb > 120 ? `${Math.round(kb)}px` : '340px')
                root?.blur()
              } else {
                root?.focus()
              }
            }}
            onExit={onTouchExit}
          />
          <TouchBubble editingBlockId={touchEditId} onFormat={() => setBubbleFormatAsk((value) => value + 1)} onLinkDialog={onLinkDialog} onConvertLink={onConvertLink} clipboard={clipboard} />
        </>
      )}
    </>
  )
}
