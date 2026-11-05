import assert from 'node:assert/strict'
import test from 'node:test'
import { syncPresentation } from '../../src/ui/Sidebar'
import type { SyncStatus } from '../../src/ui/types'

/**
 * 状态门（治理期还债 #4b，）：同步态与保存态的**用户可见面**。
 *
 * `09-桌面端交互规范` `R09-SYNC-1` 把同步写成一个四态自动状态机（未配置 / 同步中 / 已同步 / 离线队列），
 * `R09-SYNC-2…5` 规定了每一态的文案与圆点。转换本身在 `ui/useSyncEngine.ts` 里由真实事件驱动，
 * 界面路径由 `accept:STATE-SYNC-1` 跑；这里锁**每一态的呈现**——四态一个都不许漏、
 * 文案改动要有人看见（改文案就是改用户看到的契约）。
 * 保存态的转换同样在界面路径上验（`accept:STATE-SAVE-1/2`：保存中 → 已保存 / 保存失败）。
 */
test('STATE-SYNC-1 四态各有文案与圆点：未配置 / 同步中 / 已同步 / 离线队列（R09-SYNC-2…5）', () => {
  const cases: Array<[SyncStatus, string, string]> = [
    [{ kind: 'unconfigured' }, 'idle', '未配置同步'],
    [{ kind: 'syncing', done: 2, total: 3 }, 'saving', '同步中 · 2/3'],
    [{ kind: 'syncing', done: 0, total: 0 }, 'saving', '同步中…'],
    [{ kind: 'synced', at: Date.now() }, 'ok', '已同步 · 刚刚'],
    [{ kind: 'offline', pending: 4 }, 'warn', '离线 · 4 条待同步'],
  ]
  for (const [status, st, text] of cases) {
    const shown = syncPresentation(status)
    assert.equal(shown.st, st, `${status.kind} 的圆点档位`)
    assert.equal(shown.text, text, `${status.kind} 的文案`)
    assert.ok(shown.title.length > 0, `${status.kind} 必须有 hover 说明（title）`)
  }
})

test('STATE-SYNC-1 「离线」是一个正常状态而不是错误：文案里说清「编辑照常 + 会补传」（R09-SYNC-4）', () => {
  const offline = syncPresentation({ kind: 'offline', pending: 1 })
  assert.match(offline.title, /编辑照常|补传/, '离线态必须说明编辑不受影响')
  assert.match(offline.text, /待同步/, '离线态要给出待同步条数，让用户知道积压了多少')
})

test('STATE-SYNC-1 待同步条数是实时数字，不是写死的占位（R09-SYNC-4）', () => {
  assert.match(syncPresentation({ kind: 'offline', pending: 0 }).text, /0 条待同步/)
  assert.match(syncPresentation({ kind: 'offline', pending: 12 }).text, /12 条待同步/)
  assert.match(syncPresentation({ kind: 'syncing', done: 1, total: 7 }).text, /1\/7/)
})

test('同步完成读数：已同步态带出「合并 / 跳过 / 失败」，失败转 warn 档、跳过有解释', () => {
  const clean = syncPresentation({ kind: 'synced', at: Date.now(), merged: 0, skipped: 0, failed: 0 })
  assert.equal(clean.text, '已同步 · 刚刚', '全零时不上读数（成功零噪音）')

  const merged = syncPresentation({ kind: 'synced', at: Date.now(), merged: 3, skipped: 1, failed: 0 })
  assert.equal(merged.st, 'ok')
  assert.match(merged.text, /合并 3/)
  assert.match(merged.text, /跳过 1/)
  assert.match(merged.title, /本机版本更新|保留/, '跳过要说清是本机版本更新被保留')

  const failed = syncPresentation({ kind: 'synced', at: Date.now(), merged: 0, skipped: 0, failed: 2 })
  assert.equal(failed.st, 'warn', '有失败就不再是干净的 ok 档')
  assert.match(failed.text, /失败 2/)
  assert.match(failed.title, /整组跳过|其余照常/, '失败要说明影响范围（坏组跳过、其余落地）')
})

test('死读数：「同步中」不再报假分数——交换时总数未知只显示旋转点', () => {
  const unknown = syncPresentation({ kind: 'syncing', done: 0, total: 0 })
  assert.equal(unknown.text, '同步中…')
  assert.doesNotMatch(unknown.text, /0\/0/, '总数未知时不许出现 0/0')
  const known = syncPresentation({ kind: 'syncing', done: 2, total: 5 })
  assert.equal(known.text, '同步中 · 2/5', '知道总数时分数是真的（已处理批次 / 总批次）')
})
