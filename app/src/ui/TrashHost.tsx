import type { ReactNode } from 'react'
import { TrashSheet, TrashView } from './TrashView'
import type { TrashEntry, ViewKind } from './types'

type TrashHostProps = {
  view: ViewKind
  compact: boolean
  entries: TrashEntry[]
  noticeSlot: ReactNode
  onBack: () => void
  onCloseSheet: () => void
  onRestore: (id: string) => void
  onPurge: (id: string) => void
  onEmptyTrash: () => void
}

/**
 * 回收站视图宿主（模块化 M1.2a）：桌面整屏 `<section>` 与手机档 Sheet 的挂载点。
 *
 * 视图仍在 `.main` 内、DOM 顺序不变；动作由 `useTrashActions` 提供。下一刀再把
 * `WindowBar` / 视图路由和这部分一起搬进 `AppShell`。
 */
export function TrashHost({ view, compact, entries, noticeSlot, onBack, onCloseSheet, onRestore, onPurge, onEmptyTrash }: TrashHostProps) {
  return (
    <>
      <section className={`view ${view === 'trash' ? 'is-on' : ''}`} aria-label="回收站" aria-hidden={view !== 'trash'}>
        {compact ? null : (
          <TrashView
            entries={entries}
            onBack={onBack}
            onRestore={onRestore}
            onPurge={onPurge}
            onEmptyTrash={onEmptyTrash}
            noticeSlot={view === 'trash' ? noticeSlot : null}
          />
        )}
      </section>

      {view === 'trash' && compact ? (
        <TrashSheet entries={entries} onClose={onCloseSheet} onRestore={onRestore} onPurge={onPurge} onEmptyTrash={onEmptyTrash} noticeSlot={noticeSlot} />
      ) : null}
    </>
  )
}
