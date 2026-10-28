/**
 * 文案清减读数门（B 批 · `R09-STATE-5` / `09` §七）＋ θ10 形态门（`R09-STATE-1b`）。
 *
 * 口径（2026-10-12 用户走查后裁，2026-10-13 T-12 落完）：
 *   · **成功不弹通知**（界面自证）· **失败就地提示** · 只有「**代价 / 不可用 / 不可逆**」处留**最短一句**（那是契约）。
 *   · **形态**（θ10）：全应用**唯一**提示入口 = 就地提示带 `notify(...)`（`src/ui/InlineNotice.tsx`，
 *     **在文档流里**：编辑器在格式栏下、设置在弹窗顶部）。**浮层 toast 家族恒为 0**——
 *     `showToast` / `onToast` / `toast(...)` 这些调用一出现就红（见 `09` `R09-STATE-1b`）。
 *
 * 判据：扫 `src/**` 的 `notify(` 调用点——**除 `KEEP` / `ALLOW` 外，成功类必须为 0**。
 *
 * 分级方式（机械可判）：
 *   ① **契约类（保留）**：参数里的消息字面量命中「代价 / 不可用 / 不可逆 / 失败」关键词，
 *      **或**该调用带「重试」按钮（重试只属于失败）；
 *   ② **成功类（必须为 0）**：其余（「已缩进」「已星标」「已复制链接」…）；**带「撤销」也不例外**——
 *      撤销统一走 ⌘Z，不再由提示条承担；
 *   ③ **动态承载棘轮**（`> 基线 ⇒ 红`）：参数**不是单个裸消息字面量**的调用点计数化，不得增长——
 *      这条堵住「把字面量重构成变量 / 拼接 / 三元」的绕行道（静态关键词门只看字面量，重构一下就逃了）。
 *
 * 基线口径（必须与门自身计数同源，否则红/绿判据不同源）：
 *   · 本门口径 = **第一参数**（顶层逗号切开）归一化后 ≠ 单个消息字面量 ⇒ 实测 **23**（拼接 8 + 变量 5 + 其他表达式 10）；
 *   · 交叉核对：@6 独立审计器（2026-10-12）同项得 **33 = 拼接 9 + 变量 24**——**不是同一口径**：
 *     它把**含插值的模板 / 多片段 / 整段参数**都计入，本门只判第一参数、把「含插值的模板字面量」当字面量。
 *     **本门基线取本门实测值**（棘轮判据必须与门自身计数同源）；两口径的差异已在 B 批 report 里点明，不隐藏。
 *
 * 负例自测（门必须能红，三根轴各一）：
 *   `MOQI_COPY_SELFTEST=1 node scripts/check-copy.mjs`
 *   ⇒ 内存里注入 ① 一条字面量成功类 ② 一条动态承载成功类（变量承载）③ 一条浮层 toast 调用，
 *     **三根轴都必须红**；不写任何文件。
 *
 * 开关：默认即严格（T-12 已把 74 处转完）。`MOQI_COPY_STRICT=0` 只留给排查用（关 θ10 形态轴，其余两根轴照旧）。
 *
 * 用法：`node scripts/check-copy.mjs`（已接进 `pnpm check`）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd() // app/
const SRC = join(root, 'src')

/** 契约类关键词：命中任一 ⇒ 属「代价 / 不可用 / 不可逆 / 失败」，按口径**保留**（可压到最短，但不清零）。 */
const KEEP = [
  /失败/, /不可用/, /打不开/, /无法/, /不能/, /不可逆/, /没有|没做成|没返回/, /最多/,
  /先选中|先(把|打开|取消|保存|复制)/, /请先|请用|请重试|请走/, /30 天/, /尚未保存/, /剪贴板/,
  /已取消关闭/, /导入包|这个 \.zip/, /不支持/, /恢复前/,
  /已在生成|继续生成/,
  /不进回收站/, /已经留过|今天已/, /不了/,
]
/** 允许清单（点名豁免：即便没命中关键词也按契约类保留）。一行一条理由。 */
const ALLOW_LINES = [
  // 成功类不再有豁免。这里只允许 KEEP 未覆盖的极少数契约句，必须逐条写理由。
]

/** **动态承载棘轮基线**（零提示批实测；只许变短，变长必须显式改这行并说明理由）。
 *  **2026-10-24 下调一次**：24 → 13 —— 成功类（含带撤销）全部删除、一次性提示退役；
 *  余下 13 处**全为契约类**（失败 / 不可用 / 不可逆），成功类 = 0：
 *  拼接 8（另存/导入失败 / zip 解不开 / 包内无可导入）· 变量 3（`repairNotice` / `gate.reason` / `propertyNameToast`）·
 *  其他表达式 2（失败原因与守卫的短三元）。 */
const DYNAMIC_BASELINE = { total: 13, concat: 8, variable: 3, other: 2 }

const walk = (dir) => {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(full)) out.push(full)
  }
  return out
}

/** 剥注释（含块注释跨行）：删掉的提示调用会把原字面留在注释里当「撕销凭证」，不能当活调用。 */
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/.*$/gm, '')

/** 从 `(` 起取平衡括号内的参数切片。 */
function argSlice(text, openParenIndex) {
  let depth = 0
  for (let i = openParenIndex; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1
    else if (text[i] === ')') {
      depth -= 1
      if (depth === 0) return text.slice(openParenIndex + 1, i)
    }
  }
  return text.slice(openParenIndex + 1)
}

/** 取**第一参数**（在顶层逗号处切开；括号 / 字面量内部的逗号不算）。 */
function firstArg(slice) {
  let depth = 0
  let quote = null
  for (let i = 0; i < slice.length; i += 1) {
    const ch = slice[i]
    if (quote !== null) {
      if (ch === quote && slice[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue }
    if ('([{'.includes(ch)) depth += 1
    else if (')]}'.includes(ch)) depth -= 1
    else if (ch === ',' && depth === 0) return slice.slice(0, i)
  }
  return slice
}

const LITERAL = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g
/** 「消息字面量」：含中文或字母（排除 `' · '` 这类**分隔符/格式**字面量——它们不是给人看的那句话）。 */
const isMessageLiteral = (lit) => /[\u4e00-\u9fa5]/.test(lit) || /[A-Za-z]{3,}/.test(lit)

const files = walk(SRC)
const hits = []
/** θ10 形态轴：浮层 toast 家族（真红）。`MOQI_COPY_STRICT=0` 才关（排查用）。 */
const STRICT = process.env.MOQI_COPY_STRICT !== '0'
const floating = []
const allCalls = []
const dynamic = { concat: [], variable: [], other: [] }
/** **就地提示带**：唯一的合法调用形态。 */
const CALL = /\bnotify\s*\(/g
/** **浮层 toast 家族**：θ10 落地后恒为 0（出现即红）。 */
const FLOATING_CALL = /\b(showToast|onToast|toast)\s*\(/g
for (const file of files) {
  const rel = relative(SRC, file).replaceAll('\\', '/')
  const code = stripComments(readFileSync(file, 'utf8'))
  for (const match of code.matchAll(FLOATING_CALL)) {
    const before = code.slice(Math.max(0, match.index - 24), match.index)
    if (/[:=]\s*$|function\s*$|declare\s*$/.test(before)) continue // 声明/签名里的 `toast(`（不是调用）
    const lineNo = code.slice(0, match.index).split('\n').length
    floating.push(`src/${rel}:${lineNo}  ${match[0].replace(/\s*\($/, '')}(…)`)
  }
  for (const match of code.matchAll(CALL)) {
    const before = code.slice(Math.max(0, match.index - 24), match.index)
    if (/[:=]\s*$|function\s*$|declare\s*$/.test(before)) continue // 声明/签名里的 `notify(`（不是调用）
    const openIdx = match.index + match[0].length - 1
    const slice = argSlice(code, openIdx)
    const first = firstArg(slice).trim()
    const lineNo = code.slice(0, match.index).split('\n').length
    const where = `src/${rel}:${lineNo}`
    const lits = first.match(LITERAL) ?? []
    const msgLits = lits.filter((lit) => isMessageLiteral(lit)).map((lit) => lit.slice(1, -1))
    const isBare = msgLits.length === 1 && first === lits[0]
    // ③ 动态承载分类（棘轮）——按**第一参数**判
    if (msgLits.length === 0) dynamic.variable.push(`${where}  ${first.replace(/\s+/g, ' ').slice(0, 80)}`)
    else if (!isBare) (first.includes('+') ? dynamic.concat : dynamic.other).push(`${where}  ${first.replace(/\s+/g, ' ').slice(0, 80)}`)
    // ①② 成功类（必须为 0）：只有「重试」算失败动作；「撤销」不放行（撤销统一走 ⌘Z）
    const hasRetry = /['"]重试['"]/.test(slice)
    const keepByKeyword = msgLits.some((lit) => KEEP.some((re) => re.test(lit)))
    const keepByAllow = msgLits.some((lit) => ALLOW_LINES.some((rule) => rule.file === rel && rule.match.test(lit)))
    if (msgLits.length > 0 && !hasRetry && !keepByKeyword && !keepByAllow) hits.push({ file: where, message: msgLits.join(' | ') })
    allCalls.push({ file: where, message: msgLits.join(' | ') || first.replace(/\s+/g, ' ').slice(0, 40), hasRetry })
  }
}

// 负例自测：内存里各注入一条（不写文件）——三根轴都必须能红
if (process.env.MOQI_COPY_SELFTEST === '1') {
  hits.push({ file: 'src/__selftest__/(in-memory-literal).ts:1', message: '已缩进' })
  dynamic.other.push('src/__selftest__/(in-memory-dynamic).ts:1  moved ? \'已缩进\' : \'已减少缩进\'')
  floating.push('src/__selftest__/(in-memory-floating).ts:1  showToast(…)')
}

const dynTotal = dynamic.concat.length + dynamic.variable.length + dynamic.other.length
const over = dynTotal > DYNAMIC_BASELINE.total
  || dynamic.concat.length > DYNAMIC_BASELINE.concat
  || dynamic.variable.length > DYNAMIC_BASELINE.variable
  || dynamic.other.length > DYNAMIC_BASELINE.other

// θ10 形态轴：浮层 toast 家族恒为 0（T-12 已把 74 处改成就地提示带；再出现即红）
if (STRICT && floating.length > 0) {
  console.error(`文案清减门（check:copy · θ10 形态轴）：**浮层 toast 家族 ${floating.length} 处**——`)
  console.error('  口径（用户 2026-10-12 · `R09-STATE-1b`）：提示只有一种形态 = 就地提示带 `notify(...)`（在文档流里，非浮层）。')
  for (const row of floating) console.error(`  - ${row}`)
  console.error('修法：把那处改成 `notify(...)`（统一 6s 退场，见 `ui/InlineNotice.tsx`）；改不动就登记例外（带理由）。')
  process.exit(1)
}

if (hits.length > 0 || over) {
  if (hits.length > 0) {
    console.error(`文案清减门（check:copy）：**成功类提示 ${hits.length} 处**（口径：成功不弹通知、界面自证）——`)
    for (const hit of hits) console.error(`  - ${hit.file}  ${JSON.stringify(hit.message)}`)
    console.error('修法：删掉该提示（界面自证）；若它其实属「代价 / 不可用 / 不可逆 / 失败」，把消息写清以命中 KEEP，或往 ALLOW_LINES 加一条带理由的豁免。')
  }
  if (over) {
    console.error(`文案清减门（check:copy）：**动态承载提示增长**（棘轮）——`)
    console.error(`  拼接 ${dynamic.concat.length}（基线 ${DYNAMIC_BASELINE.concat}）· 变量/纯动态 ${dynamic.variable.length}（基线 ${DYNAMIC_BASELINE.variable}）· 其他表达式 ${dynamic.other.length}（基线 ${DYNAMIC_BASELINE.other}）· 合计 ${dynTotal}（基线 ${DYNAMIC_BASELINE.total}）`)
    for (const bucket of ['concat', 'variable', 'other']) for (const row of dynamic[bucket]) console.error(`  [${bucket}] ${row}`)
    console.error('修法：新增的动态承载提示必须显式说明并上调 DYNAMIC_BASELINE（走上调 = 记一笔账）；能清减的直接删。')
  }
  process.exit(1)
}
console.log(`文案清减门（check:copy）：成功类提示 **0 处** · 浮层 toast 家族 **0 处**（θ10 形态轴·${STRICT ? '开' : '关'}）· 动态承载 ${dynTotal} 处（拼接 ${dynamic.concat.length} / 变量 ${dynamic.variable.length} / 其他表达式 ${dynamic.other.length}，基线 ${DYNAMIC_BASELINE.total}）——扫描 ${files.length} 个源文件，契约类按 KEEP/ALLOW 保留。`)
