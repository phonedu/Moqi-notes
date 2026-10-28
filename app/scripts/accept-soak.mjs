/**
 * `pnpm accept` 的浸泡跑法（套件稳定性立项，）。
 *
 * 为什么需要它：**单遍全绿区分不了「稳」和「走运」**——连续四轮挂在四个不同项目
 * （PAGENAME-* → D-003 → BLOCK-19/20 → REF-DANGLE）就是单遍口径看不出来的东西。
 * 这个脚本把 accept 连跑 N 遍（默认 3），每遍串行（同一时刻只允许一个 accept——`06` §4 的
 * 既有口径），汇总每遍的 合计 / 用时 / 预热 / 失败项，并留一份机器可读的浸泡报告。
 *
 * 用法：
 *   pnpm dev            # 另开终端，先把 dev server 起好（与 pnpm accept 同一前置）
 *   pnpm accept:soak    # 默认 3 遍
 *   pnpm accept:soak 5  # 指定遍数
 *
 * 判据（立项文档：`05` 的「套件稳定性专项」）：N 连全绿 = 该轮通过；有红 → 按失败项回到
 * 加固清单（`07-V3-验收记录.md` 的同名专节记着「挂点 → 根因 → 修法」的账）。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const RUNS = Math.max(1, Number(process.argv[2] ?? 3))
const REPORT_DIR = join(tmpdir(), 'moqi-acceptance', 'reports')
const LATEST = join(REPORT_DIR, 'editor-acceptance.json')
const ACCEPT = join(dirname(fileURLToPath(import.meta.url)), 'accept-editor.mjs')

const runs = []
for (let i = 1; i <= RUNS; i += 1) {
  console.log(`\n========== 浸泡 第 ${i}/${RUNS} 遍 ==========`)
  const startedAt = Date.now()
  const result = spawnSync(process.execPath, [ACCEPT], { stdio: 'inherit' })
  let report = null
  try { report = JSON.parse(readFileSync(LATEST, 'utf8')) } catch { /* 崩在半路时按退出码判 */ }
  const failedNames = report ? report.results.filter((r) => !r.ok).map((r) => r.name.split(' ')[0]) : ['（无报告——按退出码判）']
  runs.push({
    run: i,
    exitCode: result.status,
    total: report?.results.length ?? 0,
    failed: failedNames,
    warmupMs: report?.warmupMs ?? null,
    durationMs: Date.now() - startedAt,
    at: report?.at ?? null,
    aborted: report?.aborted === true,
  })
  console.log(`第 ${i} 遍结束：退出码 ${result.status} · ${report ? `${report.results.length - failedNames.length}/${report.results.length}` : '无报告'} · ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
}

const bad = runs.filter((r) => r.exitCode !== 0 || r.failed.length > 0)
console.log(`\n========== 浸泡汇总（${RUNS} 遍）==========`)
for (const r of runs) {
  console.log(`第 ${r.run} 遍：${r.total ? `${r.total - r.failed.length}/${r.total}` : '（无报告）'} · ${(r.durationMs / 1000).toFixed(1)}s · 预热 ${r.warmupMs ?? '-'}ms · at=${r.at ?? '-'}${r.aborted ? ' · 崩在半路' : ''}${r.failed.length ? ' · 失败：' + r.failed.join(' / ') : ''}`)
}
mkdirSync(REPORT_DIR, { recursive: true })
const soakPath = join(REPORT_DIR, 'accept-soak.json')
writeFileSync(soakPath, JSON.stringify({ runs: RUNS, at: new Date().toISOString(), ok: bad.length === 0, results: runs }, null, 1))
if (bad.length === 0) console.log(`结论：${RUNS} 连全绿 ✓（浸泡报告：${soakPath}）`)
else console.log(`结论：${bad.length}/${RUNS} 遍有红 —— 按失败项回到加固清单（${soakPath}）`)
process.exit(bad.length === 0 ? 0 : 1)
