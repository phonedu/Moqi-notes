/**
 * 主题护栏（主题对比护栏的风险条款：**随批交付**）。
 *
 * 干什么：解析 `src/ui/tokens.css`（默认主题的浅 / 深）与 `src/ui/themes.css`（其余 19 套），
 * 对**每个主题 × 浅深**算四条对比度硬指标 + 两条结构检查，任何一项不过就非零退出并指出
 * 「哪套、哪轴、哪个令牌、读数多少、要求多少」。
 *
 * 四条对比度（硬指标，浅深同标）：
 *   G-1 `--text` on `--panel` ≥ 7   · G-2 `--text-2` on `--panel` ≥ 4.5
 *   G-3 `--accent-text` on `--panel` ≥ 4.5 · G-4 `--ink-t` on `--accent-hover` ≥ 4.5
 * 两条结构：
 *   S-1 材质阶梯（方向随浅深反转）：浅 侧 < 弱面 < 底 < 卡；深 侧 < 底 < 卡 < 弱面
 *   S-2 卡浮于底：L*(卡) − L*(底) ∈ [2, 4]（浅）/ [2, 5]（深，按 20 套实测区间放宽）
 * 三条圆角（ 用户规范「圆角体系 v2」，docs/08 §5.2）：
 *   R-1 阶梯值：`--r-*` 十二档必须与规范逐字相等（唯一来源；不许多、不许少、不许改值）
 *   R-2 禁裸值：三份 CSS 的每条 `border-radius` 只能引用 `--r-*` 或写 `0`；有 px / 百分比
 *       字面量时，**所在规则体**必须带「豁免」注释（沿用排版 em 域那条约定），旧名 `--radius-*` 一律算红
 *   R-3 引用完整：引用的每个 `--r-*` 都要在 tokens.css 里有定义（查不到 = 整条声明静默失效）
 *
 * 用法：`pnpm check:theme`（挂在 `pnpm check` 里）。改了 `tokens.css` / `themes.css` / `app.css` 的圆角
 * **必须**跑它；加主题的完整动作 = themes.css 加一个令牌块 + uiPrefs 的 THEMES 加一行 + 跑这个脚本。
 *
 * 自测（照「门禁必须能红」的规矩）：把任意一套的 `--text` 调亮两档 → 必须红；把任一 `--r-*` 改成 7px、
 * 或在 app.css 里写一个不带「豁免」注释的 `border-radius: 5px` → 也必须红。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd() // app/
const tokens = readFileSync(join(root, 'src/ui/tokens.css'), 'utf8')
const themes = readFileSync(join(root, 'src/ui/themes.css'), 'utf8')

/** 取一个 CSS 块里 `--name: #hex;` 的全部赋值（只认十六进制颜色；color-mix 之类的派生值跳过）。 */
function colorTokens(block) {
  const found = {}
  for (const match of block.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{3,8})\s*;/g)) found[match[1]] = match[2]
  return found
}

/**
 * 注释不算代码：等长空格替换，保住每个字符的下标（圆角审计要拿 match.index 回**原文**找「豁免」注释）。
 * 注释里会写历史说明，例如「原先这里写着 `border-radius: var(--radius-control)`」——那不该让门变红。
 */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (comment) => ' '.repeat(comment.length))

/**
 * `@media (pointer: coarse) { … }` —— 移动档分叉层（`08` §3）。
 * 为什么需要它：主题层的两处扫描都是**文本扫描**，不认嵌套——
 * `matchAll(/html\[data-theme="x"\]\s*\{([^}]*)\}/g)` 会把媒体块里的同名选择器**当成又一套主题块**
 * （同一 id 出现两个 pack、浅色取移动档值而深色仍取旧值 ⇒ 假读数），而真正的移动档又**没有被校验**。
 * 所以：探主题块前先把它**整段挖掉**（保长度，保住下标），再**单独解析**这一层。
 */
function mediaCoarseBodies(text) {
  const bodies = []
  let at = text.indexOf('@media')
  while (at >= 0) {
    const braceAt = text.indexOf('{', at)
    if (braceAt > 0 && /pointer\s*:\s*coarse/i.test(text.slice(at, braceAt))) {
      let depth = 0
      let i = braceAt
      for (; i < text.length; i += 1) {
        if (text[i] === '{') depth += 1
        else if (text[i] === '}') { depth -= 1; if (depth === 0) break }
      }
      bodies.push(text.slice(braceAt + 1, i))
    }
    at = text.indexOf('@media', at + 1)
  }
  return bodies
}
/** 把移动档块整段换成空格（保长度）。 */
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
      const seg = out.slice(at, i + 1)
      out = out.slice(0, at) + seg.replace(/[^\n]/g, ' ') + out.slice(i + 1)
    }
    at = out.indexOf('@media', at + 1)
  }
  return out
}

/** 抓出选择器对应的块体（不做完整 CSS 解析：这些文件里的选择器形态是固定的）。 */
function blockOf(source, selector) {
  const at = source.indexOf(selector + ' {')
  if (at < 0) return null
  return source.slice(at, source.indexOf('}', at))
}

const tokensTop = stripMediaCoarse(tokens)
const themesTop = stripMediaCoarse(themes)
const baseLight = colorTokens(blockOf(tokensTop, ':root') ?? '')
const baseDark = colorTokens(blockOf(tokensTop, 'html[data-mode="dark"]') ?? '')
if (Object.keys(baseLight).length === 0 || Object.keys(baseDark).length === 0) {
  console.error('主题护栏：tokens.css 里解析不到默认主题的令牌（:root / html[data-mode="dark"]）')
  process.exit(1)
}

/** 主题清单：默认（tokens.css） + themes.css 里每个 `html[data-theme="X"]`。 */
const packs = [{ id: 'default', light: baseLight, dark: baseDark }]
// 重复定义：同一 id 出现两份顶层块 ⇒ 后一份覆盖前一份（盘点陷阱，单独报）。
// 注：`failures` 在后面才声明，这里先收进 `preFailures`、声明后并入。
const preFailures = []
const seenThemeIds = new Set()
for (const match of themesTop.matchAll(/html\[data-theme="([a-z0-9-]+)"\]\s*\{/g)) {
  if (seenThemeIds.has(match[1])) preFailures.push(`主题块重复定义：${match[1]}（同一 id 两份顶层定义 ⇒ 前一份被静默覆盖）`)
  seenThemeIds.add(match[1])
}
for (const match of themesTop.matchAll(/html\[data-theme="([a-z0-9-]+)"\]\s*\{([^}]*)\}/g)) {
  const id = match[1]
  const light = colorTokens(match[2])
  const darkMatch = new RegExp(`html\\[data-theme="${id}"\\]\\[data-mode="dark"\\]\\s*\\{([^}]*)\\}`).exec(themesTop)
  if (!darkMatch) {
    console.error(`主题护栏：${id} 只有浅色块、缺深色成对块（深色必须成对交付，主题护栏的成对交付规则）`)
    process.exit(1)
  }
  // 级联：主题块只写它覆盖的令牌，其余回落到默认主题（与浏览器里的表现一致）。
  packs.push({ id, light: { ...baseLight, ...light }, dark: { ...baseDark, ...colorTokens(darkMatch[1]) } })
}

const hexToRgb = (hex) => {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)]
}
/** WCAG 相对亮度。 */
function luminance(hex) {
  const channel = (c) => {
    const v = c / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  }
  const [r, g, b] = hexToRgb(hex)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((left, right) => right - left)
  return (hi + 0.05) / (lo + 0.05)
}
/** CIE L*（结构检查用；sRGB → 线性 → Y → L*）。 */
function lStar(hex) {
  const y = luminance(hex) / 1
  return 116 * Math.cbrt(y) - 16
}

const checks = [
  { id: 'G-1', label: '--text on --panel', fg: '--text', bg: '--panel', min: 7 },
  { id: 'G-2', label: '--text-2 on --panel', fg: '--text-2', bg: '--panel', min: 4.5 },
  { id: 'G-3', label: '--accent-text on --panel', fg: '--accent-text', bg: '--panel', min: 4.5 },
  { id: 'G-4', label: '--ink-t on --accent-hover', fg: '--ink-t', bg: '--accent-hover', min: 4.5 },
]

const failures = []
failures.push(...preFailures)
let measured = 0
for (const pack of packs) {
  for (const mode of ['light', 'dark']) {
    const vars = pack[mode]
    const label = `${pack.id} · ${mode === 'light' ? '浅' : '深'}`
    for (const check of checks) {
      const fg = vars[check.fg]
      const bg = vars[check.bg]
      if (!fg || !bg) {
        failures.push(`${label}：缺令牌 ${check.fg} 或 ${check.bg}（${check.label}）`)
        continue
      }
      const ratio = contrast(fg, bg)
      measured += 1
      if (ratio < check.min) failures.push(`${label} · ${check.id} ${check.label}：${ratio.toFixed(2)} < 要求 ${check.min}（${fg} on ${bg}）`)
    }
    // S-1 材质阶梯。方向随浅深**反转**（指令 §3.4「浅色越白越前、深色越亮越前」）：
    //   浅色：侧 < 卡内弱面 < 底 < 卡   深色：侧 < 底 < 卡 < 卡内弱面
    // 两种模式下都成立的那一段是「侧 < 底 < 卡」，弱面按模式落在卡的另一侧。
    const ladder = mode === 'light'
      ? ['--side-bg', '--panel-2', '--bg', '--panel']
      : ['--side-bg', '--bg', '--panel', '--panel-2']
    const values = ladder.map((name) => vars[name])
    if (values.every(Boolean)) {
      const ls = values.map(lStar)
      for (let i = 1; i < ls.length; i += 1) {
        if (!(ls[i] > ls[i - 1])) {
          failures.push(`${label} · S-1 材质阶梯：${ladder[i]}（L* ${ls[i].toFixed(1)}）没有比 ${ladder[i - 1]}（L* ${ls[i - 1].toFixed(1)}）更前`)
        }
      }
    } else {
      failures.push(`${label}：材质阶梯缺令牌（${ladder.filter((name) => !vars[name]).join(' / ')}）`)
    }
    // S-2 卡浮于底：L* 差。浅色严格 2–4；深色按 20 套实测区间（2.7–4.5）放宽到 2–5。
    if (vars['--panel'] && vars['--bg']) {
      const delta = lStar(vars['--panel']) - lStar(vars['--bg'])
      const [min, max] = mode === 'light' ? [2, 4] : [2, 5]
      if (delta < min || delta > max) failures.push(`${label} · S-2 卡浮于底：L* 差 ${delta.toFixed(2)}，要求 ${min}–${max}（--panel vs --bg）`)
    }
  }
}

// ---------- 移动档分叉层（`pointer:coarse`，docs/08 §3；A3 批）----------
// 只写**浅色档**的少数令牌（深色不压暗 ⇒ 不参与派生）；本层**单独**跑恒序与约束②，并加一条结构断言：
// **20 套主题都在移动档块里有覆盖**（缺位 = 该主题在手机上回落桌面档，最隐蔽的缺项）；
// 另加一条「卡与弱面不得压暗」（08 §3 明文）。
// 棘轮：移动档层尚未落地（0 覆盖）时本层跳过并打印读数；一旦有覆盖就要求齐全。
const mobileOf = {}
{
  const root = blockOf(mediaCoarseBodies(tokens).join('\n'), ':root')
  if (root) mobileOf.default = colorTokens(root)
  for (const body of mediaCoarseBodies(themes)) {
    for (const match of body.matchAll(/html\[data-theme="([a-z0-9-]+)"\]\s*\{([^}]*)\}/g)) {
      mobileOf[match[1]] = { ...(mobileOf[match[1]] ?? {}), ...colorTokens(match[2]) }
    }
  }
}
let mobileMeasured = 0
for (const pack of packs) {
  const mobile = mobileOf[pack.id]
  if (!mobile) continue
  const label = `${pack.id} · 浅 · 移动档`
  const vars = { ...pack.light, ...mobile }
  const mobileLadder = ['--side-bg', '--panel-2', '--bg', '--panel']
  const mobileValues = mobileLadder.map((name) => vars[name])
  if (mobileValues.every(Boolean)) {
    const ls = mobileValues.map(lStar)
    for (let i = 1; i < ls.length; i += 1) {
      if (!(ls[i] > ls[i - 1])) failures.push(`${label} · S-1 材质阶梓：${mobileLadder[i]}（L* ${ls[i].toFixed(1)}）没有比 ${mobileLadder[i - 1]}（L* ${ls[i - 1].toFixed(1)}）更前`)
    }
  } else {
    failures.push(`${label}：材质阶梓缺令牌（${mobileLadder.filter((name) => !vars[name]).join(' / ')}）`)
  }
  if (vars['--ink-t'] && vars['--accent-hover']) {
    const ratio = contrast(vars['--ink-t'], vars['--accent-hover'])
    mobileMeasured += 1
    if (ratio < 4.5) failures.push(`${label} · G-4 --ink-t on 移动档 --accent-hover：${ratio.toFixed(2)} < 要求 4.5（08 §3 约束②）`)
  } else {
    failures.push(`${label}：缺 --ink-t 或 --accent-hover`)
  }
  if (mobile['--panel']) {
    failures.push(`${label}：移动档不得压暗**卡**（08 §3）——发现 --panel 被重绑`)
  }
  // 弱面（`--panel-2`）**必须同向压暗**：不压它时浅色阶梓 `弱面 < 底` 会翻转（S-1 会在上面把这件事报出来）。
}
const mobileThemeIds = Object.keys(mobileOf)
if (mobileThemeIds.length > 0) {
  const missingMobile = packs.map((p) => p.id).filter((id) => !(id in mobileOf))
  if (missingMobile.length > 0) failures.push(`移动档分叉：${missingMobile.length} 套主题缺移动档覆盖（${missingMobile.join('、')}）——20 套必须齐全，缺位=该主题在手机上回落桌面档`)
  const unknownMobile = mobileThemeIds.filter((id) => !packs.some((p) => p.id === id))
  if (unknownMobile.length > 0) failures.push(`移动档分叉：移动档块里的主题 id 不在主题清单里：${unknownMobile.join('、')}`)
} else {
  console.log('  · 移动档分叉（`pointer:coarse`）：0 覆盖（本层尚未落地）⇒ 本层校验跳过；落地后自动启用（需 20 套齐全）')
}

// ---------- 圆角护栏（圆角体系 v2，docs/08 §5.2； 用户规范） ----------
// 「只允许规范档位，禁止发明阶梯之外的圆角值」需要执行者：档位表在这儿，裸值审计扫三份 CSS。
const LADDER = {
  '--r-pill': '99px',
  '--r-float': '18px',
  '--r-shell': '14px',
  '--r-card': '13px',
  '--r-quote-card': '12px',
  '--r-pop': '10px',
  '--r-btn-ic': '10px',
  '--r-ic-block': '9px',
  '--r-ctrl': '8px',
  '--r-block': '6px',
  '--r-tag': '4px',
  '--r-inline': '2px',
}
const declared = {}
for (const match of stripComments(tokens).matchAll(/(--r-[a-z-]+)\s*:\s*([^;]+);/g)) declared[match[1]] = match[2].trim()
for (const [name, value] of Object.entries(LADDER)) {
  if (!(name in declared)) failures.push(`R-1 圆角阶梯：tokens.css 缺档位 ${name}: ${value}（docs/08 §5.2）`)
  else if (declared[name] !== value) failures.push(`R-1 圆角阶梯：${name} = ${declared[name]}，规范值是 ${value}（禁止自创档位）`)
}
for (const name of Object.keys(declared)) {
  if (!(name in LADDER)) failures.push(`R-1 圆角阶梯：${name} 不在十二档里（新档位要先进 docs/08 §5.2）`)
}

let radiusScanned = 0
for (const file of ['src/ui/app.css', 'src/ui/themes.css', 'src/ui/tokens.css']) {
  const source = readFileSync(join(root, file), 'utf8')
  const code = stripComments(source)
  for (const match of code.matchAll(/border-radius\s*:\s*([^;}]+)/g)) {
    radiusScanned += 1
    const value = match[1].trim()
    // 去掉合法引用后还剩下 px / 百分比 ⇒ 是裸值，必须带「豁免」注释才认账
    if (/[0-9][0-9.]*(px|%)/.test(value.replace(/var\(--r-[a-z-]+\)/g, ''))) {
      const open = source.lastIndexOf('{', match.index)
      const closed = source.lastIndexOf('}', match.index)
      const body = open > closed ? source.slice(open, source.indexOf('}', match.index)) : ''
      if (!/豁免/.test(body)) failures.push(`R-2 圆角裸值：${file} 里 \`border-radius: ${value}\` 不在阶梯上，且规则体没有「豁免」注释`)
    }
    for (const ref of value.matchAll(/var\((--r-[a-z-]+)/g)) {
      if (!(ref[1] in declared)) failures.push(`R-3 圆角引用：${file} 引用 ${ref[1]}，tokens.css 里没有定义（整条声明会静默失效）`)
    }
  }
  for (const ref of code.matchAll(/var\((--radius-[a-z-]+)/g)) {
    failures.push(`R-2 旧圆角令牌：${file} 还在用 ${ref[1]} —— v2 起统一 \`--r-*\``)
  }
}

if (failures.length > 0) {
  console.error(`主题护栏：${packs.length} 套 × 浅深 × 6 项 + 圆角 R-1…R-3 里有 ${failures.length} 项不过：`)
  for (const failure of failures) console.error('  - ' + failure)
  process.exit(1)
}
console.log(`主题护栏：${packs.length} 套 × 浅深 × 6 项（4 对比度 + 2 结构）全过，共 ${measured} 项对比度读数；移动档分叉 ${mobileThemeIds.length} 套覆盖（${mobileMeasured} 项读数）；圆角十二档与 ${radiusScanned} 处声明（R-1…R-3）全过。`)
