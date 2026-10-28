/**
 * 生成／刷新「移动档分叉」块（`docs/08` §3；A3 批）。
 *
 * 口径（`docs/08` §3，**A3 落码时按实测收口**）：
 *   · 底族 `--side-bg` / `--bg` / **`--panel-2`**：每通道 ≈ **−6**（档位 97%–98% = −7 ~ −5，取 97.65%）；
 *       —— `--panel-2` **必须同向压暗**：不压它时浅色阶梓 `弱面 < 底` 会**直接翻转**（A3 实测，`check:theme` 的 S-1 报 `--bg 不 > --panel-2`）；
 *       —— **卡 `--panel` 不压暗**（它要不压才与底拉开距离，这就是“底色差优先”加带宽的本意）。
 *   · `--accent-hover`：**提亮一档**，但**受约束② 收敛**——取「满足 `--ink-t` on 移动档 `--accent-hover` ≥ 4.5:1」的**最大提亮量**
 *       （浅色主题的 `--ink-t` 是近白 ⇒ 无条件提亮反而破 4.5；A3 实测 3.69–4.40）。
 *   · `--shadow` / `--shadow-lg`：同一几何、**alpha ×1.8**（shadow 只定义在 `tokens.css` ⇒ 一处）；
 *   · **深色不参与**（靠选择器特异性自动生效：`html[data-mode="dark"]` 高过 `:root` / `html[data-theme]`）。
 *
 * 维护纪律（`08` §3）：**本文件只写差值公式，绝对 hex 只活在生成的 CSS 里**。
 *
 * 用法：`node scripts/gen-mobile-fork.mjs`（幂等：先删上次生成的块再重写）
 * 生成物标记：`BEGIN mobile-fork (generated)` … `END mobile-fork (generated)`（行注释形式；常量见 `BEGIN` / `END`）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd() // app/
// 标记用拼接写，避免在源码里出现会提前闭合块注释的字符；也避免任何不可见字符（lint：`no-irregular-whitespace`）。
const BEGIN = '/* BEGIN mobile-fork ' + '(generated) */'
const END = '/* END mobile-fork ' + '(generated) */'
const BEGIN_KEY = '/* BEGIN mobile-fork'
const END_KEY = '/* END mobile-fork'
const DARKEN = 0.9765 // ≈ 每通道 −6（档位 97% ~ 98% = −7 ~ −5）
const WHITE_MIX_MAX = 0.15 // `--accent-hover` 提亮上限：15% 白（实际提亮量按约束② 收敛）
const SHADOW_SCALE = 1.8 // 只给浮层

const hex2rgb = (hex) => {
  const v = hex.replace('#', '')
  const full = v.length === 3 ? v.split('').map((c) => c + c).join('') : v
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
}
const rgb2hex = ([r, g, b]) => '#' + [r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0').toUpperCase()).join('')
const darken = (hex) => rgb2hex(hex2rgb(hex).map((c) => c * DARKEN))
const towardWhite = (hex, mix) => rgb2hex(hex2rgb(hex).map((c) => c * (1 - mix) + 255 * mix))

// ---- WCAG 对比度（用于约束② 收敛：与 `check-theme-contrast.mjs` 同一算法） ----
const luminance = (hex) => {
  const ch = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  const [r, g, b] = hex2rgb(hex)
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** 取一个 CSS 块里的 `--name: #hex;`（只认十六进制颜色，和 `check-theme-contrast.mjs` 同一口径）。 */
const colorTokens = (block) => {
  const found = {}
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{3,8})\s*;/g)) found[m[1]] = m[2]
  return found
}
const blockOf = (source, selector) => {
  const at = source.indexOf(selector + ' {')
  return at < 0 ? '' : source.slice(at, source.indexOf('}', at) + 1)
}
/** 删掉上一次生成的块（幂等；按标记**前缀**匹配，兼容历史生成物）。 */
const stripGenerated = (text) => {
  let out = text
  let at = out.indexOf(BEGIN_KEY)
  while (at >= 0) {
    const end = out.indexOf(END_KEY, at)
    if (end < 0) break
    const endLine = out.indexOf('\n', end)
    out = out.slice(0, at) + (endLine < 0 ? '' : out.slice(endLine + 1))
    at = out.indexOf(BEGIN_KEY)
  }
  return out
}
/** alpha ×1.8：只重写 rgba(...) 的最后一个分量。 */
const scaleShadow = (value) =>
  value.replace(/rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/g, (_all, r, g, b, a) => {
    const scaled = Math.min(1, Math.round(parseFloat(a) * SHADOW_SCALE * 1000) / 1000)
    return `rgba(${Number(r)}, ${Number(g)}, ${Number(b)}, ${scaled})`
  })

const tokensPath = join(root, 'src/ui/tokens.css')
const themesPath = join(root, 'src/ui/themes.css')
const tokens = stripGenerated(readFileSync(tokensPath, 'utf8'))
const themes = stripGenerated(readFileSync(themesPath, 'utf8'))

// ---- 收集 20 套的浅色档底族 / 激活档（默认套在 tokens 的 `:root`） ----
const packs = []
{
  const rootBase = colorTokens(blockOf(tokens, ':root'))
  if (!rootBase['--bg'] || !rootBase['--side-bg'] || !rootBase['--accent-hover']) {
    console.error('gen-mobile-fork：tokens.css 的 :root 里读不到 --bg / --side-bg / --accent-hover')
    process.exit(1)
  }
  packs.push({ id: 'default', light: rootBase })
  for (const m of themes.matchAll(/html\[data-theme="([a-z0-9-]+)"\]\s*\{([^}]*)\}/g)) {
    packs.push({ id: m[1], light: colorTokens(m[2]) })
  }
}
if (packs.length !== 20) {
  console.error(`gen-mobile-fork：主题清单应为 20 套（默认 + 19），实得 ${packs.length} —— 先修主题再生成`)
  process.exit(1)
}

// ---- 公式（底族含弱面；激活档提亮受约束② 收敛）----
const forkOf = (light) => {
  // `--accent-hover`：从提亮上限往下收敛，取「`--ink-t` on 它 ≥ 4.5」的最大提亮量（提亮 0 = 原值，而原值本来就过 G-4）。
  let mix = WHITE_MIX_MAX
  let accent = towardWhite(light['--accent-hover'], mix)
  while (mix > 0 && light['--ink-t'] && contrast(light['--ink-t'], accent) < 4.5) {
    mix = Math.round((mix - 0.01) * 100) / 100
    accent = towardWhite(light['--accent-hover'], mix)
  }
  return {
    '--side-bg': darken(light['--side-bg']),
    '--bg': darken(light['--bg']),
    '--panel-2': light['--panel-2'] ? darken(light['--panel-2']) : undefined,
    '--accent-hover': accent,
    accentMix: mix,
  }
}

// ---- tokens.css：默认套 + 影子（影子只在 tokens 定义 ⇒ 一处覆盖全体） ----
const rootLight = packs[0].light
const rootFork = forkOf(rootLight)
const shadowBase = colorTokens(blockOf(tokens, ':root'))
void shadowBase
const shadowLight = {}
for (const m of blockOf(tokens, ':root').matchAll(/(--shadow(?:-lg)?)\s*:\s*([^;]+);/g)) shadowLight[m[1]] = m[2].trim()
const rootLines = [
  '  --side-bg: ' + rootFork['--side-bg'] + ';',
  '  --bg: ' + rootFork['--bg'] + ';',
]
if (rootFork['--panel-2']) rootLines.push('  --panel-2: ' + rootFork['--panel-2'] + ';')
rootLines.push('  --accent-hover: ' + rootFork['--accent-hover'] + ';')
for (const name of ['--shadow', '--shadow-lg']) {
  if (shadowLight[name]) rootLines.push(`  ${name}: ${scaleShadow(shadowLight[name])};`)
}
const tokensBlock = [
  '',
  '/* 移动档分叉（`08` §3；A3 批）。**本块由 `scripts/gen-mobile-fork.mjs` 生成，勿手改**——',
  '   改公式后重跑脚本；值层校验见 `pnpm check:theme`（移动档恒序 + 约束② + 20 套齐全）。 */',
  BEGIN,
  '@media (pointer: coarse) {',
  '  :root {',
  ...rootLines,
  '  }',
  '}',
  END,
  '',
].join('\n')
writeFileSync(tokensPath, tokens.replace(/\n*$/, '\n') + tokensBlock, 'utf8')

// ---- themes.css：其余 19 套（浅色档） ----
const themeLines = packs.slice(1).map((pack) => {
  const f = forkOf(pack.light)
  const parts = [`--side-bg: ${f['--side-bg']}`, `--bg: ${f['--bg']}`]
  if (f['--panel-2']) parts.push(`--panel-2: ${f['--panel-2']}`)
  parts.push(`--accent-hover: ${f['--accent-hover']}`)
  return `  html[data-theme="${pack.id}"] { ${parts.join('; ')}; }`
})
const themesBlock = [
  '',
  '/* 移动档分叉（`08` §3；A3 批）。**本块由 `scripts/gen-mobile-fork.mjs` 生成，勿手改**——',
  '   只重绑底族与激活档，卡与弱面不压暗；深色不参与（`@media` 内的选择器特异性低于 `[data-mode="dark"]`）。 */',
  BEGIN,
  '@media (pointer: coarse) {',
  ...themeLines,
  '}',
  END,
  '',
].join('\n')
writeFileSync(themesPath, themes.replace(/\n*$/, '\n') + themesBlock, 'utf8')

console.log(`gen-mobile-fork：已写入 ${packs.length} 套移动档分叉（默认套 + 19 套主题）`)
console.log(`  · 底族（--side-bg / --bg / --panel-2）每通道 ≈ −6（×${DARKEN}，**卡不压暗**）· --accent-hover 提亮上限 ${WHITE_MIX_MAX}、实际按约束② 收敛 · --shadow alpha ×${SHADOW_SCALE}`)
console.log(`  · 默认套：--side-bg ${rootLight['--side-bg']}→${rootFork['--side-bg']} / --bg ${rootLight['--bg']}→${rootFork['--bg']} / --panel-2 ${rootLight['--panel-2']}→${rootFork['--panel-2']} / --accent-hover ${rootLight['--accent-hover']}→${rootFork['--accent-hover']}（白混合 ${rootFork.accentMix}）`)
