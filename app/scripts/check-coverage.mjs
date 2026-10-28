/**
 * 覆盖率读数门（2026-10-11，「体检读数」批）：**只防倒退，不设高门**。
 *
 * 为什么：覆盖率不是目标（高覆盖 ≠ 测得好），但它是一条诚实的读数——没有它，
 * 「这轮改动让多少代码失去了测试照看」只能靠感觉。规矩：`Lines` 低于基线（允许 0.5pp 抖动）即红；
 * 涨了把基线往上改（写在这里，和 `check-code-size.mjs` 的例外名单同一个写法：基线只许更严）。
 *
 * 度量口径：`c8 --reporter=json-summary pnpm test`——跑的就是 `pnpm test` 那一套；
 * **桌面原生窗口与 accept 不在这份读数里**（那是 `pnpm accept`，另一条链）。
 * TS 侧量的是「被测试加载到的文件」：数字低不丢人（UI 大件加载少），**倒退**才红。
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 2026-10-11 首测：Lines 79.17% / 复测 79.04%（逐次波动 ≈0.13pp）——基线取整到 79.0。只许升。
 *  2026-10-26 下调 79.0 → 76.0：M7 触控交互层入包（Icon / TouchBubble / MobileFmtBar / BlockCapsule /
 *  touchEditorLayer 五件，≈1100 行）进测量面——这些是 DOM 集成组件，覆盖归 accept 浏览器断言
 *  （MOBILE-* 三十余项）而非单测；包内单测补了纯逻辑（placement / memoryHost / MoqiEditor 三态）。 */
const BASELINE_LINES = 85.5
/** 允许的抖动（pp）：TS 侧读数在本机是确定性的，留一点防环境噪声。 */
const TOLERANCE = 0.5

const root = process.cwd()
// 口径（0.6.1 M7 之后）：覆盖率只量 **app 自己的源码**——编辑器已是独立单元
// （packages/editor），有自己的测试套件（`pnpm -C ../packages/editor test`，
// 挂在本 check 链首）；不再用 --allowExternal 把包文件混进 app 的分母。
execSync('npx c8 --exclude ../packages/** --exclude coverage/** --reporter=json-summary pnpm test', { stdio: 'inherit' })

const summaryPath = join(root, 'coverage', 'coverage-summary.json')
if (!existsSync(summaryPath)) {
  console.error('覆盖率读数门：没有产出 coverage/coverage-summary.json——c8 或测试链坏了，先修那条。')
  process.exit(1)
}
const total = JSON.parse(readFileSync(summaryPath, 'utf8')).total
const lines = Number(total.lines.pct)
console.log(`覆盖率读数：Lines ${lines}%（基线 ${BASELINE_LINES}，容差 ${TOLERANCE}pp）｜ Branches ${total.branches.pct}% ｜ Functions ${total.functions.pct}%`)
if (lines < BASELINE_LINES - TOLERANCE) {
  console.error(`覆盖率读数门：Lines ${lines}% 低于基线 ${BASELINE_LINES}%（容差 ${TOLERANCE}pp）——`)
  console.error('新增代码没被测试照看到、或测试被删了。修法：补用例；确属测量口径变化时，把基线改到新值并在提交信息里写明理由。')
  process.exit(1)
}
