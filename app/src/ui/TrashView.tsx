import type { ReactNode } from 'react'
import { Icon } from '@moqi/editor'
import { Sheet } from './Overlays'
import type { TrashEntry } from './types'

type TrashViewProps = {
  entries: TrashEntry[]
  onBack: () => void
  onRestore: (id: string) => void
  onPurge: (id: string) => void
  onEmptyTrash: () => void
  /** 手机档形态（`10` §4.6，4b-②）：住底部 Sheet 里——返回与大标题由 Sheet 头承担，这里只留计数 + 清空。 */
  compact?: boolean
  /** 就地提示带的插槽（θ10 · `R09-STATE-1b`）：回收站里的契约（「已从本机彻底删除」）必须就地可见——
   *  桌面整屏视图与手机 Sheet 共用这一份渲染（`.view` / Sheet 都会把编辑器列盖掉）。 */
  noticeSlot?: ReactNode
}

/**
 * 回收站视图（docs/09 §4.7）：软删除闭环的浏览终点——删除 → 浏览 → 恢复 / 彻底删除。
 * 列表只显示真实被软删除的根 Block；恢复按子树完整还原。
 */
export function TrashView({ entries, onBack, onRestore, onPurge, onEmptyTrash, compact, noticeSlot }: TrashViewProps) {
  return (
    <div className={`tr-wrap${compact ? ' is-compact' : ''}`}>
        {noticeSlot}
        <div className="tr-head">
          {compact ? null : (
          <button type="button" className="tb-btn" aria-label="返回页面库" title="返回页面库" onClick={onBack} style={{ alignSelf: 'center' }}>
            <Icon name="arrow-left" size={16} decorative />
          </button>
          )}
          {compact ? null : <h2>回收站</h2>}
          <span className="tr-cnt">{entries.length} 个页面</span>
          {entries.length > 0 ? (
            <button type="button" className="tr-clear" onClick={onEmptyTrash} title="把列表内全部页面从本机彻底删除（不可恢复）">清空回收站</button>
          ) : null}
        </div>
        <div className="tr-sub">删除的页面在此保留 30 天，到期自动彻底删除；恢复时按子树完整还原。</div>

        {entries.length === 0 ? (
          <div className="lib-empty">
            <div className="le-ico"><Icon name="trash" size={30} decorative /></div>
            <div className="le-t">回收站是空的</div>
            <div className="le-d">删除的页面会在这里保留 30 天，可随时恢复</div>
          </div>
        ) : (
          <div className="tr-list">
            {entries.map((entry) => (
              <div className="tr-row" key={entry.id}>
                <div className="trp">
                  <h4>{entry.name || '未命名页面'}</h4>
                  <div className="tr-meta">
                    删除于 <b>{entry.deletedLabel}</b> · 剩余 <b>{entry.remainingDays} 天</b>
                    {entry.childCount > 0 ? <> · 含 <b>{entry.childCount}</b> 个子块</> : null}
                    {entry.backlinkCount > 0 ? <> · <b>{entry.backlinkCount}</b> 个反链指向本页</> : null}
                  </div>
                </div>
                <div className="tr-act">
                  <button type="button" className="tr-restore" onClick={() => onRestore(entry.id)}>恢复</button>
                  <button type="button" className="tr-kill" onClick={() => onPurge(entry.id)} title="从本机彻底删除，不可恢复">彻底删除</button>
                </div>
              </div>
            ))}
          </div>
        )}

      </div>
  )
}

/**
 * 手机档的回收站 Sheet（`10` §4.6「回收站（浏览）」，4b-②）：抽屉「回收站」在窄档开它——
 * 不开整屏视图。它与「移至回收站」的**确认**弹窗是两个独立浮层（规格明文）。
 */
export function TrashSheet({ entries, onClose, onRestore, onPurge, onEmptyTrash, noticeSlot }: Omit<TrashViewProps, 'onBack' | 'compact'> & { onClose: () => void }) {
  return (
    <Sheet title="回收站" tall onClose={onClose}>
      <TrashView entries={entries} compact onBack={onClose} onRestore={onRestore} onPurge={onPurge} onEmptyTrash={onEmptyTrash} noticeSlot={noticeSlot} />
    </Sheet>
  )
}
