import { useEffect, useMemo, useState } from 'react'

import { clipboardPort, createDefaultBackupPort } from '../composition'
import { recoveryRows, restoreStamp, type SnapshotInfo } from '../application/backup'

/**
 * 载入失败屏（`G-34` 的最小步；用户 2026-10-11 裁决选项 b）：「库打不开」不再是死胡同——
 * 先给一条最可能救回来的路（**从快照恢复**，与设置页同一条流程：Rust 先留「恢复前」后悔药 →
 * 覆盖 → 整页重载，`03` §15.9），再给两条手动路（重新尝试 / 复制数据目录路径）。
 *
 * 边界：**不碰任何领域状态**（这一刻没有可救的内存数据，只有磁盘上还在的数据目录）。
 * 独立成模块，是因为外壳体量门（`EditorShell.tsx` 的 3001 行棘轮）没有放这张屏的空间。
 * 样式住在 `app.css`——本模块**不 import CSS**：单测会按值 import 它，带 CSS 会让 node 报
 * 未知扩展名（`settings.css` 那笔旧账同款）。
 */
export function LoadErrorScreen({ message }: { message: string }) {
  const port = useMemo(() => createDefaultBackupPort(), [])
  /** `null` = 还没读到（区分「读到了、是空的」）。 */
  const [snapshots, setSnapshots] = useState<SnapshotInfo[] | null>(null)
  const [directory, setDirectory] = useState<string | null>(null)
  /** 两步恢复的第一击（`R09-SET-14` 的两步语义，与设置页同构）：第二次点击才真恢复。 */
  const [confirming, setConfirming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    void port.list().then(setSnapshots).catch(() => setSnapshots([]))
    void port.dataDirectory().then(setDirectory).catch(() => setDirectory(null))
  }, [port])

  function restore(name: string) {
    setBusy(true)
    setFailure(null)
    void port.restore(name, restoreStamp(new Date()))
      .then(() => {
        // 恢复后**整页重载**（恢复流程的老账：只重建编辑器不够，见 `03` §15.9）；结果用启动通知告诉用户。
        try { localStorage.setItem('moqi-project-b:restore-notice', name) } catch { /* 丢一条提示，不影响恢复本身 */ }
        window.location.reload()
      })
      .catch((error: unknown) => {
        setBusy(false)
        setConfirming(null)
        setFailure(error instanceof Error ? error.message : String(error))
      })
  }

  function copyDirectory() {
    if (directory === null) return
    void clipboardPort.writeText(directory).then(() => setCopied(true)).catch(() => undefined)
  }

  const rows = snapshots === null ? null : recoveryRows(snapshots)
  return (
    <main className="editor-loading load-error">
      <h1>无法打开墨契</h1>
      <p className="le-msg">{message}</p>
      <p className="le-hint">别急——数据文件还在数据目录里。先从下面的快照里挑一份恢复（恢复前会自动留一份「恢复前」的后悔药）；都不行的，复制路径做人工排查。</p>
      {rows === null ? <p className="le-muted">正在读快照…</p> : rows.length === 0 ? <p className="le-muted">这个数据目录里还没有快照。</p> : (
        <ul className="le-list">
          {rows.map((row) => (
            <li key={row.name}>
              <span className="le-kind">{row.kindLabel}</span>
              <span className="le-name">{row.name}</span>
              <span className="le-meta">{row.meta}</span>
              {confirming === row.name ? (
                <>
                  <span className="le-warn">会用这一份替换当前全部数据；之后的新改动会丢（会先留一份「恢复前」）</span>
                  <span className="le-ops">
                    <button type="button" className="btn danger" disabled={busy} onClick={() => restore(row.name)}>确认恢复</button>
                    <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(null)}>取消</button>
                  </span>
                </>
              ) : (
                <span className="le-ops">
                  <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(row.name)}>恢复</button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {failure !== null ? <p className="le-fail">恢复失败：{failure}</p> : null}
      <div className="le-actions">
        <button type="button" className="btn" onClick={() => window.location.reload()}>重新尝试打开</button>
        {directory !== null ? <button type="button" className="btn" onClick={copyDirectory}>{copied ? '已复制路径' : '复制数据目录路径'}</button> : null}
      </div>
      {directory !== null ? <p className="le-dir">数据目录：{directory}</p> : null}
    </main>
  )
}
