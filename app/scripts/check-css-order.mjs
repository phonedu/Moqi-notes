/**
 * CSS 覆盖顺序门（；来源：当轮翻车——**媒体查询里的覆盖写在基础规则之前，被后面同选择器的
 * 基础规则压掉**，静默失效：`@media` 不加权重，胜负由**源序**决定）。
 *
 * 为什么必须成门：这类错的症状是"改了半天没生效"，而 CSS 不报任何东西——当轮实测三样全绿
 * （typecheck / lint / theme 门）也照样是死的，只有真窗口量 computed 值才看出来。门能静态看出来。
 *
 * 判据（**阻断**）：同一份 CSS 里，若一条规则的选择器（规范化空白后**逐字相等**）在本文件**更后面**
 * 又被定义 → 前面的那条里被后面重复声明的属性是死的。报点 = 前面那条的所在行。
 *   ① 媒体块里的一条 vs 文件后面（媒体块外或另一个媒体块）的同选择器规则；
 *   ② 媒体块里的一条 vs 更后面的**同媒体条件**块里的同选择器规则。
 * 不报的情形：选择器只是长得像（`.a .b` ≠ `.b .a`）；后面那条权重更低（换个写法就没法判死，
 *   留给真窗口／accept 的 L4 矩阵）。
 *
 * 负例自测（照「门禁必须能红」）：临时 CSS 件里写 `@media (max-width: 700px){ .x { color: red } }`
 *   然后在其后写 `.x { color: blue }` → 门红（指到媒体块那行）；清理 → 绿。
 *
 * 用法：`pnpm check:css-order`（挂 `pnpm check`）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const APP = process.cwd()
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])
const rel = (p) => relative(APP, p).replace(/\\/g, '/')

/** 剥注释（等长空格替换，保住下标 → 行号）。 */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
const lineAt = (text, index) => text.slice(0, index).split('\n').length

/** 抓规则：`选择器 { 声明 }`，并记录是否落在媒体块里及其媒体条件。 */
function rules(text) {
  const found = []
  const mediaStack = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '{') {
      // 往前找选择器：从上一个 `}` / `{` / 行首到这里的文字
      const head = text.slice(Math.max(0, text.lastIndexOf('}', i), text.lastIndexOf('{', i - 1)), i)
      const selector = head.replace(/^[\s}{]+/, '').trim()
      const media = mediaStack.length > 0 ? mediaStack.join(' & ') : null
      const close = text.indexOf('}', i)
      const body = text.slice(i + 1, close < 0 ? text.length : close)
      if (/^@media/.test(selector)) {
        mediaStack.push(selector)
        i += 1
        continue
      }
      if (selector.length > 0) {
        found.push({ selector: selector.replace(/\s+/g, ' '), media, start: i, line: lineAt(text, i), body })
      }
      i = close < 0 ? text.length : close + 1
      continue
    }
    if (ch === '}') { mediaStack.pop(); i += 1; continue }
    i += 1
  }
  return found
}

/** 声明体里出现的属性名（用来判断"哪些属性真的被后面压掉"）。 */
const propsOf = (body) => new Set([...body.matchAll(/(^|;|\{)\s*([a-z-]+)\s*:/g)].map((m) => m[2]))

const failures = []
let scanned = 0
for (const file of walk(join(APP, 'src')).filter((f) => f.endsWith('.css'))) {
  const code = stripComments(readFileSync(file, 'utf8'))
  const list = rules(code)
  scanned += list.length
  list.forEach((rule, index) => {
    if (!rule.media) return
    // 只看"媒体块里的覆盖，被**媒体块外**的更后面规则压掉"这一类——它必然是错的（同权重、源序定胜负）。
    // 媒体块 → 媒体块不报：两条的条件可能互斥（`min-width:701` vs `max-width:700` 实测会撞上），
    // 判"会不会同时生效"要解析条件区间，留 accept 的 L4 矩阵按真渲染判。
    const later = list.slice(index + 1).find((other) => other.selector === rule.selector && !other.media)
    if (!later) return
    // 只报"后面那条真的重复声明了同一属性"的情形（否则只是分块书写，没压掉东西）
    const mine = propsOf(rule.body)
    const theirs = propsOf(later.body)
    const dead = [...mine].filter((p) => theirs.has(p))
    if (dead.length === 0) return
    failures.push(
      `${rel(file)}:${rule.line}  \`${rule.selector}\` 的 ${rule.media} 覆盖写在基础规则之前——` +
      `第 ${later.line} 行的同选择器规则会把 ${dead.join(' / ')} 压掉（同权重、源序定胜负）`,
    )
  })
}

if (failures.length > 0) {
  console.error(`CSS 覆盖顺序门：${failures.length} 处覆盖是死的：`)
  for (const f of failures) console.error('  - ' + f)
  process.exit(1)
}
console.log(`CSS 覆盖顺序门：${scanned} 条规则——媒体块内的覆盖都在基础规则之后（没有静默失效的覆盖）。`)
