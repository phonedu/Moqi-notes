import * as React from 'react'
import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { MobileInsertPanel, type InsertTile } from './MobileFmtBar'

/**
 * 块操作栏（`10` §6.2 定稿）= 单块选中时的**两行胶囊**；选择栏 = 多选时的**复刻**。
 *
 * 口径（维护者复核通过，`13-两端工具栏重规划` §3.8）：
 * - **两排语义固定 ＋ 每排均分**：上排 = 内容与搬运、下排 = 结构与收尾；
 * - **同一动作只出现一处**：整块格式 / 单块「转换为」/ AI / 创建副本 / 撤销重做 / 折叠菜单项 **全撤**
 *   （各自的家在打字态面板、主条 `✦`、桌面块菜单、主条 `↩↪`、沟槽箭头）；
 * - **无隐藏层**：五类动作全部外露（没有 `⋯`）；
 * - `✓ 完成` **恒在右下角**（两栏同位，1 块 ↔ 多块切换不跳）；三勾图标三形
 *   （全选 = 虚线选框 / 待办 = 方框勾 / 完成 = 对勾）；
 * - `＋` = **插入面板**（顶部 `↑上方 / ↓下方` 段控 · 落点 = 选区上 / 下）。
 *
 * 命中区：每排 `flex: 1` 均分 ⇒ 键宽 ≈68（胶囊）/ ≈48（选择栏）× 高 44——**≥44×44 达标、不带例外**。
 */

export type BlockCapsuleOps = {
  selectedIds: string[]
  copy: (scope: 'plain') => void
  copyRef: () => void
  cut: () => void
  /** 删除：不给 ids 就删当前选区；给 ids = 定点删（图片工具条那种「就删这一块」）。 */
  remove: (ids?: string[]) => void
  /** 在块的上方 / 下方插一个**正文块**（图片工具条的上/下加块；与把手 ＋ 同一套落点算法）。 */
  insertSibling: (blockId: string, where: 'above' | 'below') => void
  /** 上移 / 下移（`-1` / `1`；同级，一步一撤销）。 */
  moveStep: (direction: -1 | 1) => void
  indent: (blockId: string, direction: 'indent' | 'outdent') => void
  /** 插入面板：落点方向 × 格位（文本型按方向落；媒体走光标块——既有通路）。 */
  insertTile: (direction: 'above' | 'below', tile: InsertTile, sub?: 'ext' | 'page' | 'today' | 'now') => void
  /** 选择模式（`10` §6.2 · 3b/3c）：点块 = 加入 / 移出选区（`selectBlock` 的 toggle 档）。 */
  toggleSelect: (blockId: string) => void
  /** 全选：当前页可见块（折叠子树不在 DOM 里，天然"不含折叠隐藏块"）。 */
  selectAll: () => void
  /** 批量转待办（真实转换，一块一笔）。 */
  batchTodo: () => void
  /** 批量缩进（每块一笔，同 Tab 的触控替代）。 */
  batchIndent: () => void
  /** γ2（2026-10-12）：选择模式内**拖整个选区**——落点 + 域层一次事务（`moveBlockGroup`）。 */
  moveGroup: (targetId: string, position: 'before' | 'after' | 'into') => void
}

/** 上排（内容与搬运）：插入 · 复制 · 剪切 · 引用 · 删除。 */
const TOP_ROW: { key: string; label: string; icon: 'plus' | 'copy' | 'scissors' | 'brackets' | 'trash'; danger?: boolean }[] = [
  { key: 'insert', label: '插入', icon: 'plus' },
  { key: 'copy', label: '复制', icon: 'copy' },
  { key: 'cut', label: '剪切', icon: 'scissors' },
  { key: 'copyRef', label: '复制为块引用', icon: 'brackets' },
  { key: 'remove', label: '删除块', icon: 'trash', danger: true },
]

/** 下排（结构与收尾）：缩进 · 反缩进 · 上移 · 下移 · [删除 ·] 完成——`✓` 恒在右下角。 */
const BOTTOM_ROW: { key: string; label: string; icon: 'indent' | 'outdent' | 'chevron-up' | 'chevron-down' | 'trash' | 'check'; danger?: boolean }[] = [
  { key: 'indent', label: '缩进', icon: 'indent' },
  { key: 'outdent', label: '反缩进', icon: 'outdent' },
  { key: 'up', label: '上移', icon: 'chevron-up' },
  { key: 'down', label: '下移', icon: 'chevron-down' },
  { key: 'done', label: '完成', icon: 'check' },
]

/** 选择栏下排（比胶囊多一枚删除——批量删除紧挨完成放右下角）。 */
const SELECT_BOTTOM: { key: string; label: string; icon: 'indent' | 'outdent' | 'chevron-up' | 'chevron-down' | 'trash' | 'check'; danger?: boolean }[] = [
  ...BOTTOM_ROW.slice(0, 4),
  { key: 'remove', label: '删除块', icon: 'trash', danger: true },
  { key: 'done', label: '完成', icon: 'check' },
]

/** 选择栏上排（选区工具 ＋ 内容与搬运）：计数 · 全选（虚线选框）· 待办（方框勾）· 插入 · 复制 · 剪切 · 引用。 */
const SELECT_TOP: { key: string; label: string; icon: 'square-dashed' | 'check-square' | 'plus' | 'copy' | 'scissors' | 'brackets' }[] = [
  { key: 'selectAll', label: '全选', icon: 'square-dashed' },
  { key: 'batchTodo', label: '待办', icon: 'check-square' },
  { key: 'insert', label: '插入', icon: 'plus' },
  { key: 'copy', label: '复制', icon: 'copy' },
  { key: 'cut', label: '剪切', icon: 'scissors' },
  { key: 'copyRef', label: '复制为块引用', icon: 'brackets' },
]

function runTop(key: string, ops: BlockCapsuleOps, blockId: string | null, openInsert: () => void) {
  if (key === 'insert') { openInsert(); return }
  if (key === 'copy') { ops.copy('plain'); return }
  if (key === 'cut') { ops.cut(); return }
  if (key === 'copyRef') { ops.copyRef(); return }
  if (key === 'remove') { ops.remove(); return }
  if (!blockId) return
  if (key === 'indent') ops.indent(blockId, 'indent')
  if (key === 'outdent') ops.indent(blockId, 'outdent')
  if (key === 'up') ops.moveStep(-1)
  if (key === 'down') ops.moveStep(1)
}

function runSelectTop(key: string, ops: BlockCapsuleOps, openInsert: () => void) {
  if (key === 'selectAll') { ops.selectAll(); return }
  if (key === 'batchTodo') { ops.batchTodo(); return }
  if (key === 'insert') { openInsert(); return }
  if (key === 'copy') { ops.copy('plain'); return }
  if (key === 'cut') { ops.cut(); return }
  if (key === 'copyRef') { ops.copyRef(); return }
}

function runSelectBottom(key: string, ops: BlockCapsuleOps, onDone: () => void) {
  if (key === 'indent' || key === 'outdent') { ops.batchIndent(); return }
  if (key === 'up') { ops.moveStep(-1); return }
  if (key === 'down') { ops.moveStep(1); return }
  if (key === 'remove') { ops.remove(); return }
  if (key === 'done') onDone()
}

/** 插入面板（占位 = 胶囊所在的底部条）。**落在宿主栏上方**：把栏高写进 `--sheet-bottom`——
   胶囊是两排（选择栏 7+6），面板若按 `bottom: 0` 摆就会被两排键压住（真机：显示不全 + 滑不动）。 */
function CapsuleInsert({ ops, onClose, media = true }: { ops: BlockCapsuleOps; onClose: () => void; media?: boolean }) {
  const [direction, setDirection] = useState<'above' | 'below'>('below')
  useEffect(() => {
    const bar = document.querySelector<HTMLElement>('.capsule')
    const height = bar ? Math.round(bar.getBoundingClientRect().height) : 96
    document.documentElement.style.setProperty('--sheet-bottom', `${height}px`)
    return () => { document.documentElement.style.removeProperty('--sheet-bottom') }
  }, [])
  return (
    <MobileInsertPanel
      direction={{ value: direction, onChange: setDirection }}
      onPick={(tile, sub) => { ops.insertTile(direction, tile, sub); onClose() }}
      media={media}
    />
  )
}

/**
 * 选择栏（`10` §6.2 定稿）= **复刻胶囊**：同形两排、`✓ 完成` 同位；上排多三枚选区键
 * （计数 · 全选 · 待办）。批量转换等长尾曾经在 `⋯`——既定口径下来后**无隐藏层**。
 */
export function SelectionBar({ count, ops, onDone, media = true }: {
  count: number
  ops: BlockCapsuleOps
  /** `✓ 完成`：退选择模式、清选中、回打字态（键盘与格式栏回来）。 */
  onDone: () => void
  /** M5 可选能力：透传给插入面板。 */
  media?: boolean
}) {
  const [insertOpen, setInsertOpen] = useState(false)
  /* D-101：复制/复制为块引用的**按键瞬时确认态**（用户 2026-10-26：「没有提示的确像是坏了」；
     不用通知带——R09-STATE-5 成功不弹，改按键自己说话：图标瞬时 ✓ ＋ 主题色，0.9s 还原。
     剪切不加：成功 = 块消失，界面自证）。 */
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  useEffect(() => {
    if (copiedKey === null) return
    const timer = window.setTimeout(() => setCopiedKey(null), 900)
    return () => window.clearTimeout(timer)
  }, [copiedKey])
  return (
    <>
      {insertOpen ? <CapsuleInsert ops={ops} onClose={() => setInsertOpen(false)} media={media} /> : null}
      <div className="capsule cap-select" role="toolbar" aria-label="选择栏">
        <div className="cap-row">
          <span className="cap-count">已选 {count} 块</span>
          {SELECT_TOP.map((item) => (
            <button key={item.key} type="button" className={copiedKey === item.key ? 'is-copied' : ''} aria-label={item.label} title={item.label} aria-expanded={item.key === 'insert' ? insertOpen : undefined} onClick={() => { if (item.key === 'insert') { setInsertOpen(insertOpen ? false : true); return } runSelectTop(item.key, ops, () => setInsertOpen(true)); if (item.key === 'copy' || item.key === 'copyRef') setCopiedKey(item.key) }}>
              <span className="mi"><Icon name={copiedKey === item.key ? 'check' : item.icon} size={20} decorative /></span>
            </button>
          ))}
        </div>
        <div className="cap-row">
          {SELECT_BOTTOM.map((item) => (
            <button key={item.key} type="button" className={`${item.danger ? 'is-danger' : ''}${item.key === 'done' ? ' cap-strong' : ''}`.trim() || undefined} aria-label={item.label} title={item.label} onClick={() => runSelectBottom(item.key, ops, onDone)}>
              <span className="mi"><Icon name={item.icon} size={20} decorative /></span>
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

/** 块操作栏（单块 · 两排 5 + 5）。 */
export function BlockCapsule({ ops, onDone, media = true }: {
  ops: BlockCapsuleOps
  /** `✓ 完成`：退块选中、回打字态（键盘与格式栏回来）。 */
  onDone: () => void
  /** M5 可选能力：透传给插入面板。 */
  media?: boolean
}) {
  const [insertOpen, setInsertOpen] = useState(false)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  useEffect(() => {
    if (copiedKey === null) return
    const timer = window.setTimeout(() => setCopiedKey(null), 900)
    return () => window.clearTimeout(timer)
  }, [copiedKey])
  const blockId = ops.selectedIds[0] ?? null
  return (
    <>
      {insertOpen ? <CapsuleInsert ops={ops} onClose={() => setInsertOpen(false)} media={media} /> : null}
      <div className="capsule" role="toolbar" aria-label="块操作栏">
        <div className="cap-row">
          {TOP_ROW.map((item) => (
            <button key={item.key} type="button" className={`${item.danger ? 'is-danger' : ''}${copiedKey === item.key ? ' is-copied' : ''}`.trim() || undefined} aria-label={item.label} title={item.label} aria-expanded={item.key === 'insert' ? insertOpen : undefined} onClick={() => { if (item.key === 'insert') { setInsertOpen(insertOpen ? false : true); return } runTop(item.key, ops, blockId, () => setInsertOpen(true)); if (item.key === 'copy' || item.key === 'copyRef') setCopiedKey(item.key) }}>
              <span className="mi"><Icon name={copiedKey === item.key ? 'check' : item.icon} size={20} decorative /></span>
            </button>
          ))}
        </div>
        <div className="cap-row">
          {BOTTOM_ROW.map((item) => (
            <button key={item.key} type="button" className={item.key === 'done' ? 'cap-strong' : ''} aria-label={item.label} title={item.label} onClick={() => (item.key === 'done' ? onDone() : runTop(item.key, ops, blockId, () => setInsertOpen(true)))}>
              <span className="mi"><Icon name={item.icon} size={20} decorative /></span>
            </button>
          ))}
        </div>
      </div>
    </>
  )
}
