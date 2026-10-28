/**
 * 主题引用层护栏（；来源：外部《主题配色审计方案》——L1 + L3 并入 `08` §7.1，挂 `pnpm check`）。
 *
 * 为什么：`check-theme-contrast.mjs` 只查**值层**（令牌值对不对——20 套 × 浅深 × 六项 = 160 项读数）；
 *   查不出**引用层**：组件有没有**用对**令牌。值全绿，但填充用了 `--accent` 本尊而不是深档 `-hover`，
 *   翻转字对比照样破线（26/39 块 < 4.5:1，最差 2.12）——这类错值层校验零报警。这是那份外部方案的核心论点。
 *
 * 判据：
 *   ① L1 主题块完整性：`themes.css` 的 `[data-theme]` 块**浅深成对**，且每块令牌集合与首块一致
 *      （缺位 = 该主题切换后回落默认主题，出现"混色"——最隐蔽的缺项症状）。
 *   ② L3 硬编码色：组件 CSS/TSX 里不许出现具体色值（白名单 = 阴影 / 遮罩的中性黑白，每条带理由）。
 *   ③ L3 家族错用：背景用 `--accent` 本尊（应深档 `-hover`）· 文字用 `--accent` 本尊（应 `-text`）·
 *      焦点环用 `-hover`（应本尊）。初筛命中后按 `08` §7.1 人审（判据 = §3 令牌用途表 + 三类合法用法）：
 *      **图形件 / 透明淡彩 / 规定组合**进 `MISUSE_ALLOW`（**每条写明理由**，同冻结名单的规矩——
 *      只增不减：新命中要么改代码、要么在豁免单补一条理由，不许默默放行）。
 *  ④ 段落级配对（ 补，D-034 / D-035 收口后——**门跟着规范长**）：③ 是行级初筛，这两条比的是
 *      **同一规则体内两条声明的配对关系**：④a 态色填充（`--danger` / `--ok` / `--star`）上的翻转字必须是
 *      `--ink-t`（D-034 的死法：白字铺危险底，21/40 套破线）；④b 中性透明叠色层（rgba 白 / 黑）不许再写死
 *      字色，要 `--ink-t` 或 `inherit`（D-035 的死法：亮底白字 36/40 套破线）。
 *
 * 不在本门：**L4 切换矩阵**（渲染层——已做成 `accept:THEME-5`，无头 Edge 逐格拨主题 × 模式比 computed 值）与
 *   **L5 真机走查**（强光 / 深色 / 移动档观感——归真机）。三层分工见 `08` §7.1。
 *
 * 负例自测（，照「门禁必须能红」的规矩）：临时 CSS 件注入 `background: var(--accent)` 与 `#123456`
 *   → 门红（③ / ② 各指到该行）；`themes.css` 尾加一个不成对的预留块 → 门红（① 不成对 ＋ 逐块缺令牌清单）；
 *   临时件注入 `.a { background: var(--danger); color: #fff }` 与 `.b { background: rgba(255,255,255,.18); color: #fff }`
 *   → 门红（④ 两条各指到该行）；三处均清理 → 绿。
 *
 * 用法：`pnpm check:theme-usage`。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const APP = process.cwd() // app/（照 check-docs-refs.mjs 的写法：脚本从 app/ 跑）

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])
const rel = (p) => relative(APP, p).replace(/\\/g, '/')
const linesOf = (p) => readFileSync(p, 'utf8').split('\n')

const failures = []

// ---------- ① L1 主题块完整性 ----------
// 注意：移动档分叉层（`@media (pointer:coarse) { … }`）里的 `html[data-theme="x"]` 是**带缩进**的，
// 不会被下面的行首正则当成主题块；但**最后一个主题块**会把“追加在文件尾”的媒体块内容一块吞进去
// （块是按行首切分的）⇒ 令牌集合必不一致。所以先把它**整段创掉**再切块。
const stripMediaCoarse = (text) => {
  let out = text
  let at = out.indexOf('@media')
  while (at >= 0) {
    const braceAt = out.indexOf('{', at)
    if (braceAt > 0 && /pointer\s*:\s*coarse/i.test(out.slice(at, braceAt))) {
      let depth = 0
      let i = braceAt
      for (; i < out.length; i += 1) {
        if (out[i] === '{') depth += 1
        else if (out[i] === '}') { depth -= 1; if (depth === 0) break }
      }
      out = out.slice(0, at) + ' '.repeat(i + 1 - at) + out.slice(i + 1)
    }
    at = out.indexOf('@media', at + 1)
  }
  return out
}
let lightCount = 0
let darkCount = 0
let tokenCount = 0
{
  const source = stripMediaCoarse(linesOf(join(APP, 'src/ui/themes.css')).join('\n'))
  const lightNames = [...source.matchAll(/^html\[data-theme="([^"]+)"\]\s*\{/gm)].map((m) => m[1])
  const darkNames = [...source.matchAll(/^html\[data-theme="([^"]+)"\]\[data-mode="dark"\]\s*\{/gm)].map((m) => m[1])
  lightCount = lightNames.length
  darkCount = darkNames.length
  const unpaired = [...new Set([...lightNames, ...darkNames])].filter((n) =>
    !(lightNames.includes(n) && darkNames.includes(n)))
  if (unpaired.length) failures.push(`L1 不成对：${unpaired.join('、')}（每主题必须浅 + 深成对交付）`)
  // 每块令牌集合一致（按块切分后比 `--x:` 名字集合）
  const blocks = source.split(/^html\[data-theme="/m).slice(1)
  const sets = blocks.map((b) => [...b.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]).sort().join(','))
  const kinds = [...new Set(sets)]
  tokenCount = kinds[0]?.split(',').length ?? 0
  if (kinds.length !== 1) {
    failures.push(`L1 令牌集合不一致：${kinds.length} 种（缺位的主题切过去会回落默认主题的色）`)
    for (const [i, s] of sets.entries()) {
      if (s === kinds[0]) continue
      const missing = kinds[0].split(',').filter((t) => !s.split(',').includes(t))
      const extra = s.split(',').filter((t) => !kinds[0].split(',').includes(t))
      failures.push(`  第 ${i + 1} 块（${blocks[i].slice(0, 60).split('"')[0]}）缺：${missing.join('、') || '—'}${extra.length ? ` · 多出：${extra.join('、')}` : ''}`)
    }
  }
}

// ---------- ② L3 硬编码色 + ③ 家族错用 ----------
// 注释**整份剥**（按行剥会漏跨行 `/* … */`：`#33303a` 那种"讲历史坑"的注释会被误报）。
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|\s)\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '))

const targets = walk(join(APP, 'src')).filter((f) => /\.(css|ts|tsx)$/.test(f) && !/tokens\.css$|themes\.css$/.test(f))

const COLOR = /#[0-9A-Fa-f]{3,8}\b|\brgba?\([^)]*\)/g
// 白名单（每条都写明理由——**有理由才放行**，跟冻结名单一个规矩）：
const WHITELIST = [
  [/^#fff(f|fff)?$/i, '纯白（--panel 的等值写法）'],
  [/^rgba?\(\s*0\s*,\s*0\s*,\s*0\b/, '中性黑：阴影 / 遮罩'],
  [/^rgba?\(\s*255\s*,\s*255\s*,\s*255\b/, '中性白：阴影 / 遮罩 / 高光'],
  [/^rgba\(12,\s*12,\s*16,\s*\.72\)$/, '遮罩（带紫调的黑；待收进 `--scrim` 令牌后可移出名单）'],
  [/^rgba\(32,\s*32,\s*39,\s*\.32\)$/, '阴影（带紫调的黑；同上）'],
  [/^rgba\(255,\s*205,\s*0,/, '搜索命中的闪烁黄（定位反馈，不是主题色）'],
  [/^#9CA6EF$|^#4F5AC0$/, 'toast 动作按钮：反转面上的**跨模式**取值（值同两档 --accent-text；`var()` 会取错模式）'],
]
const MISUSE = [
  [/background(-color)?\s*:[^;{}]*var\(--accent\)(?![\w-])/, '背景用 `--accent` 本尊——填充应深档 `-hover`（图形件除外，人审）'],
  [/[^-]color\s*:[^;{}]*var\(--accent\)(?![\w-])/, '文字用 `--accent` 本尊——链接族文字应 `-text`'],
  [/outline[^;{}]*var\(--accent-hover\)/, '焦点环用深档 `-hover`——应本尊 `--accent`'],
]
// 人审豁免（ 首轮 11 处；判据 = `08` §7.1 家族语义表，**图形件 / 透明淡彩 / 规定组合**三类合法用法）：
const MISUSE_ALLOW = [
  [/\.sb-sync\[data-st="saving"\] \.sdot/, '同步中状态点（7px 圆点，图形件；其上无字）'],
  [/\.b-plus:hover \{ background: var\(--panel\); color: var\(--accent\); \}/, '轨道 +/−/⌄ 图标按钮悬停色（图标件）'],
  [/^color: var\(--accent\);$/, '嵌入卡图标块（`.eb-icon`：`-soft` 背 + 本尊图标，规定组合）'],
  [/color-mix\(in srgb, var\(--accent\) 1[28]%/, '透明淡彩底（op-tag / 命中 mark，小面积；派生式，随主题自动变）'],
  [/color-mix\(in srgb, var\(--accent\) 22%/, '透明淡彩底（查找 / 反链命中 mark，小面积；同上）'],
  [/\.ai-dots i \{.*background: var\(--accent\);/, 'AI 等待点（4px 圆点，图形件）'],
  [/\.ed-empty \.ee-ic \{ color: var\(--accent\);/, '空状态大图标（图形件）'],
  [/\.resizer:hover::after, \.resizer\.is-dragging::after/, '列宽拖拽高亮条（2px 图形件）'],
  [/^background: var\(--accent\);$/, '拖拽落点指示线（`.drop-line` 3px 图形件，线不是填充面；其上无字）'],
  [/^\.drop-line::before, \.drop-line::after \{[^}]*background: var\(--accent\); \}$/, '落点线翘头（同上，图形件）'],
]
const hardcoded = []
const misuse = []
let allowed = 0
for (const f of targets) {
  const raw = stripComments(readFileSync(f, 'utf8')).split('\n')
  raw.forEach((code, i) => {
    for (const m of code.matchAll(COLOR)) {
      if (WHITELIST.some(([re]) => re.test(m[0]))) continue
      hardcoded.push(`${rel(f)}:${i + 1}  ${m[0]}`)
    }
    for (const [re, why] of MISUSE) {
      if (!re.test(code)) continue
      if (MISUSE_ALLOW.some(([allow]) => allow.test(code.trim()))) { allowed++; break }
      misuse.push(`${rel(f)}:${i + 1}  ${why}`)
    }
  })
}
if (hardcoded.length) failures.push(`② 硬编码色 ${hardcoded.length} 处（绕过主题系统 = 切主题不变色的钉死色）：\n    ` + hardcoded.slice(0, 20).join('\n    '))
if (misuse.length) failures.push(`③ 家族错用 ${misuse.length} 处（按 \`08\` §7.1 语义表人审：真错用就改，合法就进 MISUSE_ALLOW 补理由）：\n    ` + misuse.slice(0, 20).join('\n    '))

// ---------- ④ 段落级配对（D-034 / D-035 收口后补，：门跟着规范长）----------
// ③ 是**行级**初筛（看单个声明）；这两条是**规则体级**的**配对关系**——同一体内两条声明必须互相成立：
//   ④a 态色填充（`--danger` / `--ok` / `--star`）上的翻转字必须是 `--ink-t`（`08` §3 态色行；D-034 的死法）；
//   ④b 中性透明叠色层（rgba 白 / 黑）**不许再写死字色**——要 `--ink-t` 或 `inherit`（D-035 的死法：亮底白字）。
const pairFindings = []
{
  const cssFiles = targets.filter((f) => f.endsWith('.css'))
  for (const f of cssFiles) {
    const code = stripComments(readFileSync(f, 'utf8'))
    for (const m of code.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = m[2]
      const selector = m[1].trim().split('\n').filter((part) => part.trim().length > 0).pop()?.trim() ?? ''
      const at = code.slice(0, m.index).split('\n').length
      const colorDecl = body.match(/[^-]color\s*:\s*([^;]+);/)
      const colorValue = colorDecl ? colorDecl[1].trim() : null
      if (colorValue === null) continue
      if (/background(-color)?\s*:\s*var\(--(danger|ok|star)\)/.test(body) && !/^var\(--ink-t\)$/.test(colorValue)) {
        pairFindings.push(`${rel(f)}:${at}  ${selector}  态色填充上写死字色（${colorValue}）——应 \`--ink-t\``)
      }
      if (/background(-color)?\s*:\s*rgba?\(\s*(?:255\s*,\s*255\s*,\s*255|0\s*,\s*0\s*,\s*0)/.test(body) && /#(?:fff|ffffff|000|000000)$/i.test(colorValue)) {
        pairFindings.push(`${rel(f)}:${at}  ${selector}  透明叠色层上写死字色（${colorValue}）——应 \`--ink-t\` / \`inherit\``)
      }
    }
  }
}
if (pairFindings.length) failures.push(`④ 配对 ${pairFindings.length} 处（态色填充的翻转字 = \`--ink-t\`；透明叠色层不写死字色）：\n    ` + pairFindings.slice(0, 20).join('\n    '))

if (failures.length) {
  console.error(`主题引用层护栏：L1 主题块 + L3 引用，共 ${failures.length} 类不过：`)
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}
console.log(`主题引用层护栏：L1 浅 ${lightCount} + 深 ${darkCount} 块成对、令牌集合一致（${tokenCount} 个）；` +
  `L3 硬编码色 0 处；L3 家族错用 0 处（豁免 ${allowed} 处，理由见脚本 MISUSE_ALLOW 与 \`08\` §7.1）；` +
  `④ 段落级配对 0 处（态色填充的翻转字 / 透明叠色层）。`)
