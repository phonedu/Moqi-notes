/**
 * 代码体量门（ 收口；来源：文档与代码大扫除的 K1 裁决 + `06` §6）。
 *
 * 判据：
 *   ① `app/src/**` 每个文件 ≤ **600 行**。
 *   ② 超线者挂**例外名单**（基线 = 收口时实测，**只许变短**，拆完划掉）——跟文档侧体量门同一套写法。
 *   ②b 缺陷修复走**修复通道**（`REPAIRS` 表：在案放行、只许变短、每次运行打印在案清单；`06` §6）。
 *   ③ 例外名单里的文件掉到红线以内 → 打印"可划掉"（防名单烂在旧状态）。
 *   ④ `app/tests/**` **只出读数、不设门**（最大者 2660 行；拆测试文件另批定阈值）。
 *
 * 为什么：文档侧的病（大文件 = 什么新功能都往这塞）在代码侧同样成立——
 *   `ui/EditorShell.tsx` 4411 行就是活证据；这道门把"只许变短"钉住，配合 `06` §6 的「外壳新代码免入」。
 *
 * 用法：`pnpm check:size`（挂在 `pnpm check` 里）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const APP = process.cwd() // app/（照 check-docs-refs.mjs 的写法：脚本从 app/ 跑）
const RED_LINE = 600
/** 例外名单（只许变短；拆完划掉）。 */
const EXCEPTIONS = {
  'src/ui/BlockTools.tsx': 792,
}
/**
 * 修复通道（`06` §6；条目从 启用）：缺陷修复需要在超线文件里加行、加了会让体量门变红时挂「在案」——
 * 顶线 = 挂案时实测（只许变短）、写明理由与归位时点；门按在案放行并每次打印在案清单；
 * 归位批把行搬回后把条目一并划掉。没挂案的照旧按棘轮红——「红着推进」不算通道：必须有案、有期限、每次门禁可见。
 * 首个在案 = `BlockTools.tsx`（θ17 修复 805 / 顶线 805）—— 归位（`applyAssetVars` 抽到 `assetVars.ts`）后已划掉。
 */
const REPAIRS = {}

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])

const lines = (p) => readFileSync(p, 'utf8').split('\n').length - 1
const rel = (p) => relative(APP, p).replace(/\\/g, '/')

const failures = []
const notes = []

// M4 起双根：app/src（壳层）+ packages/editor/src（编辑器包）——同一道 600 行门看两边。
const src = [
  ...walk(join(APP, 'src')),
  ...walk(join(APP, '..', 'packages', 'editor', 'src')),
].filter((f) => /\.(ts|tsx)$/.test(f))
for (const f of src) {
  const n = lines(f)
  const name = rel(f)
  if (n > RED_LINE) {
    const baseline = EXCEPTIONS[name]
    const repair = REPAIRS[name]
    if (baseline == null) failures.push(`源码超线：${name}（${n} 行 > ${RED_LINE}）—— 修法：按主题拆模块（\`06\` §6 落点四问），或登记进例外名单并写明理由`)
    else if (n > baseline) {
      if (repair && n <= repair.ceiling) notes.push(`修复通道在案：${name} 现 ${n} 行（顶线 ${repair.ceiling} · ${repair.reason} · 归位：${repair.until}）——在案放行，归位批搬回后划掉条目（\`06\` §6）`)
      else if (repair) failures.push(`修复通道超顶线：${name} 现 ${n} 行 > 顶线 ${repair.ceiling}——把超出部分搬走，或更新在案顶线与理由（\`06\` §6）`)
      else failures.push(`体量棘轮：${name} 现 ${n} 行、基线 ${baseline}——例外名单只许变短（\`06\` §6「外壳新代码免入」）；缺陷修复可走「修复通道」（挂 \`REPAIRS\` 在案条目）`)
    } else if (repair) {
      notes.push(`修复通道条目可划掉：${name} 已回到 ${n} 行（≤ 基线 ${baseline}）——把 \`REPAIRS\` 的这条删掉`)
    }
  } else if (EXCEPTIONS[name] != null) {
    notes.push(`例外名单可划掉：${name} 已 ${n} 行 ≤ ${RED_LINE}`)
    if (REPAIRS[name]) notes.push(`修复通道条目可划掉：${name} 已回到 ${n} 行——把 \`REPAIRS\` 的这条一并划掉`)
  }
}

const tests = walk(join(APP, 'tests')).filter((f) => /\.(ts|tsx)$/.test(f))
  .map((f) => ({ name: rel(f), n: lines(f) })).sort((a, b) => b.n - a.n)

if (notes.length > 0) {
  console.log(`提示（不阻断 · ${notes.length} 条）：`)
  for (const x of notes) console.log('  ' + x)
}
console.log(`代码体量读数：src 最大 ${rel(src.map((f) => [f, lines(f)]).sort((a, b) => b[1] - a[1])[0][0])} ${src.map((f) => lines(f)).sort((a, b) => b - a)[0]} 行 · tests 最大 ${tests[0].name} ${tests[0].n} 行（tests 只读数、不设门）`)

if (failures.length > 0) {
  console.error(`代码体量门（check:size）：发现 ${failures.length} 处问题。`)
  for (const f of failures) console.error('  ' + f)
  process.exit(1)
}
console.log(`代码体量门（check:size）：src 全 ≤ ${RED_LINE} 行（例外名单 ${Object.keys(EXCEPTIONS).length} 件）——全过。`)
