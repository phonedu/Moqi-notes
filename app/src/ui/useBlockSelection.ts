import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { clipboardPort } from '../composition'
import { DomainStore } from '../application/store'
import type { BlockMap } from '@moqi/editor'
import { selectionAsText, type SelectionTextMode } from '@moqi/editor'
import { paintSelection } from './Overlays'
import { anchorOf, type AnchorRect } from './Popover'

/**
 * 选区与批量（`docs/11` §3.7 / `docs/09` §6.2）。
 *
 * 还债 #2 的模块②：2026-10-04 从 `EditorShell.tsx` 整块搬出来，**行为零变化**（安全网 =
 * `SELECT-1..6` 单测 + `accept:SHELL-SELECT-1/2`：单击选中 / ⌘ 加选计数 / ⇧ 选一整段 /
 * 批量删除一步撤销 / Esc 取消不起事务）。
 *
 * 这个模块只拥有三件事：
 * ① **谁被选中**——`selectedIds` 与范围锚点（⌘ 加选、⇧ 范围；父级去重与删除语义归领域，不在这）；
 * ② **对整份选区的批量动作**——就地复制（`store.copy`）与删除（`store.deleteSelection`），
 *   各一个领域事务、各占一步撤销，走完清空选择；**剪贴板三件**（复制 / 复制为块引用 / 剪切，
 *   `docs/09` §九 `R09-KEY-21`）也在这里——文本由域层的 `selectionAsText` 出（纯函数、单一所有者），
 *   本模块只负责把它写进系统剪贴板并提示（剪贴板不可用不吞掉动作：剪切照旧执行，只提示失败）；
 * ③ **呈现配套**——浮动工具条的落点（滚动 / 改窗口要重新量）与选中样式（正文被整篇重建后要重刷）。
 *
 * 不做的事，也是接口故意不暴露的：格式、缩进、AI 这些「对选中块执行的动作」由调用方拿
 * `selectedIds` 去派发——本模块不认识编辑器命令、不认识 AI、不认识页面库。抽出去的目的是
 * 让选区有单一所有者，而不是把 EditorShell 换一个地方继续堆。
 */
export type SelectMode = 'single' | 'toggle' | 'range'

type BlockSelectionOptions = {
  store: DomainStore
  activePageId: string | null
  reloadFromStore: (pageId?: string | null) => void
  notify: (message: string, actionLabel?: string, onAction?: () => void) => void
  /** 正文被整篇重建的时刻（换页 / 同步应用 / 撤销重做）：选中样式画在 class 上，重建后就没了。 */
  surfaceRevision: number
  /** 正文根元素（Lexical 的 contentEditable）。**必须是稳定引用**（`useCallback([])` 读 ref），否则测量 effect 每轮重挂。 */
  editorRoot: () => HTMLElement | null
}

type BlockSelection = {
  /** 文档序的选中块 id；空数组 = 没有选区。 */
  selectedIds: string[]
  /** 把手手势的入口：单击 / ⌘ 加选 / ⇧ 范围（父级去重留给领域）。 */
  selectBlock: (blockId: string, mode: SelectMode) => void
  exitSelection: () => void
  /** 就地复制（duplicate）：副本紧跟源之后，一个事务一步撤销。菜单里的「创建副本」。 */
  copySelection: () => void
  /** 不给 ids = 删当前选区；给 ids = 定点删（图片工具条那种）。 */
  deleteSelection: (ids?: string[]) => void
  /** 复制到系统剪贴板（不动文档、保留选区）：`plain` = 正文文本，`ref` = `((…))` / `[[…]]` 引用。 */
  copySelectionToClipboard: (mode: SelectionTextMode) => Promise<void>
  /** 剪切：文本进剪贴板 + 删除（一个事务一步撤销）。 */
  cutSelection: () => Promise<void>
  /** 浮动工具条的锚点（第一个选中块的矩形）；没有选区时为 null。 */
  selectionRect: AnchorRect | null
}

export function useBlockSelection(options: BlockSelectionOptions): BlockSelection {
  const { store, activePageId, reloadFromStore, notify, surfaceRevision, editorRoot } = options

  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const rangeAnchorRef = useRef<string | null>(null)

  function selectBlock(blockId: string, mode: SelectMode) {
    // γ3（2026-10-12 裁定）：**页面容器不参与块选区**——容器是选区的**边界**（对它做批量块操作
    // 无意义或危险：置为待办 / 缩进 / 剪切 = 删整页内容；页内对容器也没有合法落点 ⇒ 拖拽恒死角）。
    // 一处守卫挡住**所有入口**（左滑滑选 / 模式内点块 / toggle / 全选）——比逐个入口补稳。
    if (store.get(blockId)?.isObject) return
    /** 容器不进选区：范围选会顺带把页面根圈进来，这里统一滤掉。 */
    const blocksOnly = (ids: string[]) => ids.filter((id) => !store.get(id)?.isObject)
    setSelectedIds((current) => {
      if (mode === 'toggle') {
        const next = blocksOnly(current.includes(blockId) ? current.filter((id) => id !== blockId) : [...current, blockId])
        rangeAnchorRef.current = blockId
        return next
      }
      if (mode === 'range') {
        const anchor = rangeAnchorRef.current ?? current[0]
        if (!anchor) { rangeAnchorRef.current = blockId; return [blockId] }
        const order = subtreeOrder(store.snapshot(), activePageId)
        const from = order.indexOf(anchor)
        const to = order.indexOf(blockId)
        if (from < 0 || to < 0) return [blockId]
        return blocksOnly(order.slice(Math.min(from, to), Math.max(from, to) + 1))
      }
      rangeAnchorRef.current = blockId
      return current.length === 1 && current[0] === blockId ? [] : [blockId]
    })
  }

  // 清空选区**只有一个入口**：id 与范围锚点是同一件事（锚点留着，回到编辑器再 ⇧ 点会从一把
  // 已经看不见的锚上拉范围）。引用稳定，调用点可以放进 effect 依赖里。
  const exitSelection = useCallback(() => {
    setSelectedIds([])
    rangeAnchorRef.current = null
  }, [])

  function copySelection() {
    const rootIds = store.copy(selectedIds)
    if (!rootIds || rootIds.length === 0) return
    reloadFromStore()
    exitSelection()
  }

  /** `ids` 只在**显式传数组**时生效；其余（不传 / 被当 onClick 处理器传进 MouseEvent）一律用当前选区——
   *  飞条那颗删除就是 `onDelete={deleteSelection}` 直接接线（`2026-10-15` 实测：签名一改就静默失效）。 */
  function deleteSelection(ids?: unknown) {
    const rootIds = store.deleteSelection(Array.isArray(ids) ? (ids as string[]) : selectedIds)
    if (!rootIds || rootIds.length === 0) return
    reloadFromStore()
    exitSelection()
  }

  async function copySelectionToClipboard(mode: SelectionTextMode) {
    const text = selectionAsText(store.snapshot(), selectedIds, mode)
    if (text.length === 0) return
    try {
      await clipboardPort.writeText(text)
      /* B 批（`R09-STATE-5`）：复制到剪贴板成功不弹通知（剪贴板自证）；失败分支仍在下一行 */
    } catch {
      notify('复制失败：剪贴板不可用')
    }
    // 复制不动文档：选区留着（用户常要连按两次复制），也不 reload。
  }

  async function cutSelection() {
    const text = selectionAsText(store.snapshot(), selectedIds, 'plain')
    // 剪贴板失败不吞掉剪切（与文字工具栏同一条口径）：先尽力写，写不进去照样删并提示。
    let clipboardOk = true
    try {
      await clipboardPort.writeText(text)
    } catch {
      clipboardOk = false
    }
    const rootIds = store.deleteSelection(selectedIds)
    if (!rootIds || rootIds.length === 0) return
    reloadFromStore()
    exitSelection()
    if (!clipboardOk) notify('剪贴板不可用：内容已删除（可用撤销找回）')
  }

  // 浮动工具条浮在第一个选中块的上方：正文滚动 / 窗口尺寸变化时要重新量。
  // （只登记一帧再量的循环有 `ui/blockAnchor.ts` 的 `useFrameMeasure`，但那一条是 rAF 里
  //  `setState` 的测量；这里是一串同步量取的矩形，保持原样搬过来，别顺手改拍子。）
  const [scrollTick, setScrollTick] = useState(0)
  useEffect(() => {
    if (selectedIds.length === 0) return
    const onScroll = () => setScrollTick((value) => value + 1)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [selectedIds])

  const selectionRect = useMemo<AnchorRect | null>(() => {
    void scrollTick
    if (selectedIds.length === 0) return null
    const root = editorRoot()
    if (!root) return null
    const first = root.querySelector<HTMLElement>(`.moqi-block[data-entity-id="${selectedIds[0]}"]`)
    return first ? anchorOf(first) : null
  }, [selectedIds, scrollTick, editorRoot])

  // 选中高亮：只切换 class，不改写编辑器 DOM 结构（`docs/09` §6.2）。
  useEffect(() => {
    paintSelection(editorRoot(), selectedIds)
  }, [selectedIds, surfaceRevision, editorRoot])

  return { selectedIds, selectBlock, exitSelection, copySelection, deleteSelection, copySelectionToClipboard, cutSelection, selectionRect }
}

/** 子树在文档中的先后顺序，用于 ⇧ 范围选择（父级去重之后按它排）。 */
function subtreeOrder(blocks: BlockMap, pageId: string | null): string[] {
  if (!pageId) return []
  const order: string[] = []
  const visit = (id: string) => {
    const block = blocks.get(id)
    if (!block || block.deleted) return
    order.push(id)
    for (const childId of block.children) visit(childId)
  }
  visit(pageId)
  return order
}
