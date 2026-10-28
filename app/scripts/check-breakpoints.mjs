/**
 * 断点一致性门（2026-10-09；来源：0.6 的「断点体系」——**同一组宽度值散在 CSS 字面量、TS 的
 * matchMedia 字符串与 `tauri.conf.json` 三处**，改一处忘一处就出现「拖到某个宽度版面不换」的
 * 静默错误：CSS 不报、typecheck 不报，只有真窗口量出来才知道。门能静态看出来）。
 *
 * 判据（**阻断**，三组）：
 *   ① CSS 不许有档外断点：`src/**\/*.css` 里 `@media (min-width|max-width: Npx)` 的每个 N 必须是
 *      `src/ui/breakpoints.ts` 的 `TIER_MAX_WIDTH` 登记值**或其补数**（`701` 是 `≤700` 从另一侧写的
 *      同一个边界——两边都收）。**不许发明档外断点**（`08`：600 / 840 / 960 那类旧值是跨产品参考，
 *      墨契共四档）。
 *   ② TS 不许出现裸的宽度媒体字符串：`matchMedia('(max-width: …)')` 式的字面量一律走 `MQ`
 *      （`breakpoints.ts` 自身除外——它就是生成 MQ 的地方）。
 *   ③ `tauri.conf.json` 的窗口下限 ↔ TS 常量：`minWidth` == `MIN_WINDOW_FLOOR`（`ui/minWindowSize.ts`）、
 *      `minHeight` == `MIN_WINDOW_HEIGHT`（`adapters/windowShell.ts`）——两处都在（配置管 JS 起来之前、
 *      运行时由 `R09-RESP-19` 现算），漂了就是「窗口能拖到比判据更窄」。
 *
 * 负例自测（照「门禁必须能红」）：把 app.css 某个 `@media (max-width: 700px)` 改成 `720px` → 门红；
 *   改回 → 绿。把 `tauri.conf.json` 的 `minWidth` 改成 720 → 门红；改回 → 绿。
 *
 * 用法：`pnpm check:breakpoints`（挂 `pnpm check`）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const APP = process.cwd() // app/（照 check-css-order.mjs 的写法：脚本从 app/ 跑）
const rel = (p) => relative(APP, p).replace(/\\/g, '/')
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])

const failures = []

// 登记表：断点值从 TS 唯一来源里读（不在这里再抄一遍）
const breakpointsTs = readFileSync(join(APP, 'src/ui/breakpoints.ts'), 'utf8')
const tableBlock = breakpointsTs.match(/TIER_MAX_WIDTH\s*=\s*\{([^}]*)\}/)
if (!tableBlock) {
  console.error('断点门：读不到 `src/ui/breakpoints.ts` 的 `TIER_MAX_WIDTH`（登记表的形状变了就改本门）。')
  process.exit(1)
}
const registered = new Map([...tableBlock[1].matchAll(/(\w+)\s*:\s*(\d+)/g)].map((m) => [Number(m[2]), m[1]]))
/** 合法集合 = 登记值 ∪ 补数（`min-width: 701px` 与 `max-width: 700px` 是同一个边界的两侧写法）。 */
const allowed = new Set([...registered.keys(), ...[...registered.keys()].map((w) => w + 1)])

// ① CSS 不许有档外断点
const cssFiles = walk(join(APP, 'src')).filter((f) => f.endsWith('.css'))
for (const file of cssFiles) {
  const text = readFileSync(file, 'utf8')
  for (const line of text.split('\n')) {
    for (const m of line.matchAll(/\((min|max)-width:\s*(\d+)px\)/g)) {
      const width = Number(m[2])
      if (!allowed.has(width)) {
        failures.push(`① 档外断点：${rel(file)} 里的 \`${m[1]}-width: ${width}px\` 不在登记表（${[...registered].map(([w, n]) => `${n}=${w}`).join(' / ')}；补数写法 = 登记值 +1）—— 修法：用登记值，或先在 breakpoints.ts / \`08\` 的四档表里登记新档`)
      }
    }
  }
}

// ② TS 不许裸写宽度媒体字符串（生成 MQ 的 breakpoints.ts 除外；先剥注释——写法说明不算违规）
const tsFiles = walk(join(APP, 'src')).filter((f) => /\.tsx?$/.test(f) && !rel(f).endsWith('src/ui/breakpoints.ts'))
for (const file of tsFiles) {
  const text = readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')
  for (const m of text.matchAll(/matchMedia(Safe)?\(\s*['"`][^'"`]*\((?:min|max)-width[^'"`]*['"`]/g)) {
    failures.push(`② 裸媒体字符串：${rel(file)} 里的 \`${m[0].slice(0, 48)}…\` —— 修法：引用 \`MQ\`（\`ui/breakpoints.ts\`）`)
  }
}

// ③ tauri.conf.json 的窗口下限 ↔ TS 常量
const conf = JSON.parse(readFileSync(join(APP, 'src-tauri/tauri.conf.json'), 'utf8'))
const windowConf = conf?.app?.windows?.[0] ?? {}
const readConst = (file, name) => {
  const m = readFileSync(join(APP, file), 'utf8').match(new RegExp(`${name}\\s*=\\s*(\\d+)`))
  return m ? Number(m[1]) : null
}
const floor = readConst('src/ui/minWindowSize.ts', 'MIN_WINDOW_FLOOR')
const height = readConst('src/adapters/windowShell.ts', 'MIN_WINDOW_HEIGHT')
if (floor !== windowConf.minWidth) {
  failures.push(`③ 窗口下限漂了：\`tauri.conf.json\` 的 \`minWidth\` = ${windowConf.minWidth}，\`ui/minWindowSize.ts\` 的 \`MIN_WINDOW_FLOOR\` = ${floor} —— 两处同值（前者管 JS 起来之前）`)
}
if (height !== windowConf.minHeight) {
  failures.push(`③ 窗口下限漂了：\`tauri.conf.json\` 的 \`minHeight\` = ${windowConf.minHeight}，\`adapters/windowShell.ts\` 的 \`MIN_WINDOW_HEIGHT\` = ${height} —— 两处同值（\`setMinSize\` 会替换整组约束，运行时带着它一起给）`)
}

if (failures.length > 0) {
  console.error(`断点门（check:breakpoints）：发现 ${failures.length} 处问题。`)
  for (const f of failures) console.error('  ' + f)
  process.exit(1)
}
console.log(`断点门（check:breakpoints）：CSS 三档（${[...registered].map(([w, n]) => `${n}=${w}`).join(' / ')}）与 TS / tauri.conf 一致——全过。`)
