import assert from 'node:assert/strict'
import test from 'node:test'
import { isoWeek, localDay, recoveryRows, restoreStamp } from '../../src/application/backup'
import { BrowserBackupPort } from '../../src/adapters/backup'

/**
 * 数据安全：快照的**命名与保留**（`docs/03` §15.9；用户 2026-10-05 裁决排 0.5 第一项）。
 *
 * 两侧（Rust / 浏览器通道）各有一份保留策略，语义必须一致：**7 日 + 4 周 + 3 份后悔药**。
 * Rust 那份在 `src-tauri/src/backup.rs` 的 `prune_plan`（单测 `retention_*`）；这份是浏览器侧的镜像，
 * 同时钉住「日期串怎么算」——快照文件名就是按时间排序的依据，算错就等于保留错。
 */

const withMockStorage = () => {
  const store = new Map<string, string>()
  const localStorage = {
    get length() { return store.size },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
    clear: () => store.clear(),
  }
  const globalWithStorage = globalThis as unknown as { localStorage?: unknown }
  const previous = globalWithStorage.localStorage
  globalWithStorage.localStorage = localStorage
  return { store, restore: () => { globalWithStorage.localStorage = previous } }
}

test('BACKUP-NAME-1 日期串按本地时间算：日 = YYYY-MM-DD；ISO 周跨年归到有周四的那一年', () => {
  assert.equal(localDay(new Date(2026, 9, 5)), '2026-10-05', '10 月是 month=9（零基）')
  assert.equal(localDay(new Date(2026, 0, 1)), '2026-01-01')
  // 2026-01-01 是周四 ⇒ 它那一周（2025-12-29 ~ 2026-01-04）算 2026-W01
  assert.equal(isoWeek(new Date(2026, 0, 1)), '2026-W01')
  assert.equal(isoWeek(new Date(2025, 11, 29)), '2026-W01', '跨年那一周归到有周四的年')
  assert.equal(isoWeek(new Date(2026, 0, 5)), '2026-W02', '下一个周一开始新的一周')
  assert.equal(isoWeek(new Date(2026, 9, 5)), '2026-W41')
  assert.equal(restoreStamp(new Date(2026, 9, 5, 9, 12, 3)), '2026-10-05T091203', '后悔药的戳不含冒号（文件名安全）')
})

test('BACKUP-BROWSER-1 浏览器通道：同一天建两次只留一份、周快照补齐、恢复先留后悔药', async () => {
  const mock = withMockStorage()
  try {
    globalThis.localStorage.setItem('moqi-project-b:blocks', JSON.stringify([{ entityId: 'a' }]))
    const port = new BrowserBackupPort()

    const first = await port.createSnapshot('2026-10-05', '2026-W41')
    assert.ok(first, '第一次要产出快照')
    const again = await port.createSnapshot('2026-10-05', '2026-W41')
    assert.equal(again, null, '同一天再建是 no-op')
    assert.deepEqual((await port.list()).map((entry) => entry.name).sort(), ['2026-10-05.sqlite3', '2026-W41.sqlite3'])

    // 快照之后又改了内容 ⇒ 恢复要回到快照那一刻，并把「恢复前」留成后悔药
    globalThis.localStorage.setItem('moqi-project-b:blocks', JSON.stringify([{ entityId: 'a' }, { entityId: 'b' }]))
    await port.restore('2026-10-05.sqlite3')
    assert.equal(JSON.parse(globalThis.localStorage.getItem('moqi-project-b:blocks')!).length, 1, '恢复回到快照那一刻')
    assert.ok((await port.list()).some((entry) => entry.kind === 'restore'), '恢复前先留后悔药')
    // 浏览器通道的能力如实上报：文件导出与数据目录不可用（界面据此禁用）
    assert.deepEqual(port.capabilities, { snapshots: true, exportFile: false, dataDirectory: false })
    await assert.rejects(() => port.exportDatabase(), /浏览器预览不提供文件导出/)
  } finally {
    mock.restore()
  }
})

test('BACKUP-BROWSER-2 浏览器侧保留策略与 Rust 侧同一条：7 日 + 4 周 + 3 份后悔药', async () => {
  const mock = withMockStorage()
  try {
    globalThis.localStorage.setItem('moqi-project-b:blocks', '[]')
    const port = new BrowserBackupPort()
    for (let day = 1; day <= 9; day += 1) await port.createSnapshot(`2026-09-0${day}`, `2026-W3${day}`)
    const names = (await port.list()).map((entry) => entry.name)
    assert.equal(names.filter((name) => name.startsWith('2026-09')).length, 7, '日快照留 7 份')
    assert.equal(names.filter((name) => name.includes('-W')).length, 4, '周快照留 4 份')
    assert.ok(!names.includes('2026-09-01.sqlite3'), '最老的那份被清掉')
    assert.ok(names.includes('2026-09-09.sqlite3'), '最新的那份留着')
  } finally {
    mock.restore()
  }
})

test('LOAD-RECOVER-1 载入失败屏的恢复序：新的在前（最可能救回来的先给）、标签按类型、meta 给大小与时间（G-34 最小步）', () => {
  const rows = recoveryRows([
    { name: '2026-W40.sqlite3', kind: 'weekly', sizeBytes: 3 * 1024 * 1024, modifiedMs: 3000 },
    { name: '2026-10-09.sqlite3', kind: 'daily', sizeBytes: 2048, modifiedMs: 1000 },
    { name: 'restore-backup-2026-10-10T0930.sqlite3', kind: 'restore', sizeBytes: 512, modifiedMs: 2000 },
  ])
  assert.deepEqual(rows.map((row) => row.name), [
    '2026-W40.sqlite3',
    'restore-backup-2026-10-10T0930.sqlite3',
    '2026-10-09.sqlite3',
  ], '新的在前——恢复屏的默认建议永远是最新那一份')
  assert.deepEqual(rows.map((row) => row.kindLabel), ['周快照', '恢复前后悔药', '日快照'])
  assert.match(rows[0]!.meta, /^3\.0 MB · /, 'meta = 大小 + 本地时间')
  assert.match(rows[2]!.meta, /^2 KB · /, '小文件按 KB 显示（不足 1 KB 也至少 1）')
  assert.deepEqual(recoveryRows([]), [], '空表就空——界面按「还没有快照」如实说')
})
