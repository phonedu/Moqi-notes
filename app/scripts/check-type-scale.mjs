/**
 * UI 字阶引用层门禁（2026-10-24，Cupertino 字阶批）。
 *
 * 为什么：`check-theme-usage.mjs` 看颜色令牌，`check-css-order.mjs` 看覆盖顺序，`check-breakpoints` 看断点；
 * 但字号一直是一层没人看住的裸值——全站曾有 9 / 9.5 / 10 / 10.5 / 11.5 / 12.5 / 13.5 七个半像素档，
 * 同一类文字在不同面板里各写一个值，改了令牌也追不回来。现在 UI 层的唯一词汇是 11 个 `--type-*`。
 *
 * 判据：
 *   ① `tokens.css` 的 11 组 `--type-*-size / -line / -weight` 齐全，值 = 设计稿（Cupertino 11 档）；
 *   ② 组件 CSS 里 `font-size` 不许出现 px 字面量（编辑正文走 `--fs-e`，内容倍率走 `calc()`）；
 *   ③ TS/TSX 里不许用 `fontSize: 15` / `fontSize: '15px'` 这样的 inline 字号（要么走类，要么走 var）；
 *   ④ `var(--type-*)` 引用的档位必须在 11 档之内（防止拼错令牌名后静默回落）。
 *
 * 负例自测（照「门禁必须能红」的规矩）：临时在 `src/ui/app.css` 写 `.x { font-size: 12.5px }` → ② 红；
 *   在 TSX 写 `style={{ fontSize: 15 }}` → ③ 红；把 `--type-footnote-size` 改名 → ① / ④ 红；清理 → 绿。
 *
 * 用法：`pnpm check:type-scale`（挂 `pnpm check`）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const APP = process.cwd()
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)])
const rel = (path) => relative(APP, path).replace(/\\/g, '/')
const stripComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|\s)\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '))

const SCALE = [
  ['large-title', 34, 41, 700],
  ['title1', 28, 34, 700],
  ['title2', 22, 28, 700],
  ['title3', 20, 25, 600],
  ['headline', 17, 22, 600],
  ['body', 17, 22, 400],
  ['callout', 16, 21, 400],
  ['subheadline', 15, 20, 400],
  ['footnote', 13, 18, 400],
  ['caption1', 12, 16, 400],
  ['caption2', 11, 13, 500],
]
const NAMES = new Set(SCALE.map(([name]) => name))
const failures = []

// ---------- ① 11 档令牌齐全 ----------
const tokens = readFileSync(join(APP, 'src/ui/tokens.css'), 'utf8')
for (const [name, size, line, weight] of SCALE) {
  for (const [field, value] of [['size', `${size}px`], ['line', `${line}px`], ['weight', `${weight}`]]) {
    if (!tokens.includes(`--type-${name}-${field}: ${value}`)) {
      failures.push(`① tokens.css 缺少 --type-${name}-${field}: ${value}`)
    }
  }
}

// ---------- ② / ③ / ④ 组件引用层 ----------
const files = walk(join(APP, 'src')).filter((file) => /\.(css|ts|tsx)$/.test(file))
const badCss = []
const badInline = []
const unknownTokens = []
for (const file of files) {
  if (/tokens\.css$|themes\.css$/.test(file)) continue
  const code = stripComments(readFileSync(file, 'utf8'))
  const lines = code.split('\n')
  lines.forEach((line, index) => {
    const at = `${rel(file)}:${index + 1}`
    for (const match of line.matchAll(/font-size\s*:\s*([^;]+);/g)) {
      if (/[0-9.]+px/.test(match[1])) badCss.push(`${at}  ${match[0].trim()}`)
    }
    // 只管对象字面量 / JSX style 里的字号；`fontSize: FontSizeStep` 这类类型声明不会被数字正则命中。
    if (/fontSize\s*:\s*(?:[0-9]+(?:\.[0-9]+)?\b|['"][0-9.]+px['"])/.test(line)) {
      badInline.push(`${at}  ${line.trim()}`)
    }
    for (const match of line.matchAll(/var\(--type-([a-z0-9-]+?)-(?:size|line|weight)/g)) {
      if (!NAMES.has(match[1])) unknownTokens.push(`${at}  --type-${match[1]}-*`)
    }
  })
}

if (badCss.length) failures.push(`② UI 层出现裸 font-size px ${badCss.length} 处：\n    ${badCss.slice(0, 20).join('\n    ')}`)
if (badInline.length) failures.push(`③ 出现 inline 字号 ${badInline.length} 处（改走类或 var）：\n    ${badInline.slice(0, 20).join('\n    ')}`)
if (unknownTokens.length) failures.push(`④ 引用了 11 档之外的 --type-* ${unknownTokens.length} 处：\n    ${unknownTokens.slice(0, 20).join('\n    ')}`)

if (failures.length) {
  console.error(`UI 字阶门禁：${failures.length} 类不过：`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`UI 字阶门禁：Cupertino 11 档齐全；组件 CSS 裸 px 0 处、inline 字号 0 处、越界令牌 0 处（扫描 ${files.length} 个源文件）。`)
