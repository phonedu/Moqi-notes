/**
 * 文档引用门（docs:check) —— 2026-10-05 随文档管理重构 C1 补。
 *
 * 为什么要有它：三处结构缺口之一是「活文档长在版本库外」——主文档曾用「根目录《X》」引用
 * 仓库外的文件：没有 git 历史（丢了不可恢复）、多会话并发写会静默覆盖、新会话找不到。
 * 这条门把「引用即入库」（`06` §5.6.2）钉成机器判据；执行经过见 `07-验收记录.md` 的「文档管理重构」条目。
 *
 * 判据（逐条见正文注释；模板 / 结构性判据为阻断，标注「提示」「读数」「棘轮」的只打印不阻断）：
 *   ① 库外引用模式（`根目录`/`仓库根目录`/`仓库外` ＋ 书名号）= 0
 *      —— 文档里先剥掉代码块与行内 code 再查（写法说明不算引用）；
 *   ② `` `13-<名>` `` / `` `09-<名>` `` 式引用必须指向 `docs/` 里真实存在的文件（13 族与 09 两半都认；含 `.md` 的写法都认）；
 *   ③ 13 族每份文件（`13-归档.md` 除外）开头十行内必须有头注三行：
 *      状态 / 规范的家 / 关闭时处置；
 *   ④ 体量门（2026-10-05 随 C4 补）：规范类文档 ≤600 行；超线者挂豁免表（基线 = 当时实测），
 *      **棘轮只许变短**——B 包拆完把基线下调到新值；
 *   ⑤ 登记门（随 C2 补）：`03` §1.1 模块索引 ↔ `app/src` 实际文件（双向，按 basename）；
 *   ⑥ 行为登记门（随 C2 补）：代码项名里的行为 ID 必须在 `11` 有行；`11` 的干净
 *      `accept:X` / `test:X` 单元格必须真在对应脚本 / 测试里（基建 ID 有豁免名单）；
 *   ⑦ 规则门（随 C3 补）：`R04`/`R09` 的理由不得悬空（严格）；定义无理由数 ≤ 基线（棘轮）。
 *   ⑧-⑭ 见正文（痕迹读数 / 禁用词 / 头注纪律 / 日期括注 / 通路矩阵 / 台账落点）；
 *   ⑮ § 引用可解析（2026-10-13）· ⑯ 台账编号（`D-*`）唯一 · ⑰ 篇内标题序号唯一 ·
 *   ⑱ 门禁清单一致（`package.json` 的 `check` 链每个子命令必须在 `06` §7 出现；`AGENTS.md` 引用的命令必须真实存在）。
 *
 * 用法：`pnpm docs:check`（挂在 `pnpm check` 最前，与测试登记门同级）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'

const root = process.cwd() // app/
const docsDir = join(root, '..', 'docs')

const files = []
const walk = (dir, exts) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = posix.join(dir.replace(/\\/g, '/'), e.name)
    // 归档区不进任何门（`13-文档体系重规划` 姊妹册 §5：归档区不设体量 / 头注 / 登记门）
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== 'archive') walk(p, exts) }
    else if (exts.some((x) => e.name.endsWith(x))) files.push(p)
  }
}
walk(docsDir, ['.md'])
walk(join(root, 'src'), ['.ts', '.tsx'])
walk(resolve(root, '..', 'packages', 'editor', 'src'), ['.ts', '.tsx'])
walk(join(root, 'tests'), ['.ts', '.tsx'])
walk(join(root, 'scripts'), ['.mjs'])

const failures = []
/** 提示通道（2026-10-08 起）：只给读数、不阻断——`13-文档体系重规划（清单与施工）` §8 / §9。 */
const warnings = []

/** 按编号读整族（`NN-*.md`，按名字排序拼接）——凡「册可能被拆」的编号都走这里：拆完仍是一族。 */
const familyText = (prefix) =>
  readdirSync(docsDir)
    .filter((n) => n.startsWith(prefix) && n.endsWith('.md'))
    .sort()
    .map((n) => readFileSync(join(docsDir, n), 'utf8'))
    .join('\n')

// 自身豁免：本文件为了说明判据，正文里会引用「模式长什么样」——不扫自己
const SELF = 'check-docs-refs.mjs'
const scannable = files.filter((f) => !f.endsWith(SELF))

// ① 库外引用模式
const outOfTree = /(根目录|仓库根目录|仓库外)\s*《/g
for (const file of scannable) {
  const raw = readFileSync(file, 'utf8')
  const isMd = file.endsWith('.md')
  // 文档：剥掉围栏代码块与行内 code；代码文件：原样（注释也算）
  const text = isMd
    ? raw.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
    : raw
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (outOfTree.test(lines[i])) {
      failures.push(`① 库外引用：${file.replace(root + '/', 'app/').replace(/\\/g, '/')}（文档内约第 ${i + 1} 片）—— 修法：把文档搬进 docs/（13 族）或登记进 README「库外文档登记」后按文内引用写`)
    }
    outOfTree.lastIndex = 0
  }
}

// ② `NN-<名>` 引用可解析（2026-10-08 从只查 09/13 扩到**全部编号族**：
//    件搬进归档区后，裸名引用会静默悬空——扩到全族就会当场报红，逼出"改引用或改口径"）
// **解析集 = docs/ 全部非归档子目录的文件名**（2026-10-09：前瞻件搬进 `docs/next/` 后仍按裸名引用——
//    引用写全名、不带路径，是文档体系的既有口径；归档区照旧**不进解析集**，引用它必须写成 prose）。
const docNames = (() => {
  const names = []
  const walkDocs = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (e.name !== 'archive') walkDocs(join(dir, e.name)) }
      else if (e.name.endsWith('.md')) names.push(e.name)
    }
  }
  walkDocs(docsDir)
  return names
})()
const docNameSet = new Set(docNames)
const ref13 = /`((?:0\d|1\d)-[^`\n]+?)`/g
for (const file of scannable) {
  const raw = readFileSync(file, 'utf8')
  let m
  while ((m = ref13.exec(raw)) !== null) {
    const name = m[1].trim()
    if (name.includes('<') || name.includes('*') || name.includes('/')) continue // 占位写法不算
    const base = name
    const target = base.endsWith('.md') ? base : base + '.md'
    // 家族简写容忍：`07-V3` / `07-规则索引` 这类前缀式写法——只要库里有同前缀的件就算解析（占位之外的另一类）
    const isFamilyShorthand = docNames.some((n) => n.startsWith(base))
    if (!docNameSet.has(target) && !isFamilyShorthand) {
      failures.push(`② 悬空引用：${file.replace(root + '/', 'app/').replace(/\\/g, '/')} 引用了 \`${name}\`，但 docs/ 里没有对应文件 —— 修法：改引用名或补文件（件已入归档区的话，改成 prose「已归档」/ 指 \`docs/archive/\`）`)
    }
  }
}

// ②b 活跃集不许引用**已归档**的件（归档区存在后生效）——结论在活跃集、理由在档案；要取回走取回流程
const refArchive = /`((?:docs\/)?archive\/[^`\n]+?)`/g
for (const file of scannable) {
  const raw = readFileSync(file, 'utf8')
  let m
  while ((m = refArchive.exec(raw)) !== null) {
    const name = m[1].trim()
    if (name.includes('<') || name.includes('*')) continue // 占位写法不算
    if (existsSync(join(docsDir, name.replace(/^docs\//, '')))) {
      failures.push(`②b 引用了归档件：${file.replace(root + '/', 'app/').replace(/\\/g, '/')} 指向 \`${name}\` —— 归档件不进必读面（要指结论就指 \`07\` / 历史册；要复活走取回流程）`)
    }
  }
}

// ③ 13 族头注三行 ＋ 册型两行（2026-10-10 补：13 族平铺无型 = "人和 AI 都不知道怎么读"，
//    把"这册是什么 / 怎么读 / 什么时候消失"变成必填——枚举校验，没写即红）
const VOL_TYPES = ['台账', '决策单', '规划', '对账']
const VOL_TYPE_RE = new RegExp('册型\\*\\*：\\**(' + VOL_TYPES.join('|') + ')')
for (const e of readdirSync(docsDir, { withFileTypes: true })) {
  if (!e.isFile() || !e.name.startsWith('13-') || !e.name.endsWith('.md') || e.name === '13-归档.md') continue
  const headLines = readFileSync(join(docsDir, e.name), 'utf8').split('\n').slice(0, 15)
  const head = headLines.slice(0, 10).join('\n')
  const missing = ['状态', '规范的家', '关闭时处置'].filter((k) => !head.includes(k))
  if (missing.length > 0) {
    failures.push(`③ 缺头注：docs/${e.name} 开头十行缺「${missing.join(' / ')}」—— 修法：13 族文件开头补头注三行（状态 / 规范的家 / 关闭时处置），见 06 §5.6.2`)
  }
  const typeLine = headLines.find((l) => l.includes('**册型**'))
  const type = typeLine?.match(VOL_TYPE_RE)?.[1]
  if (!typeLine) failures.push(`③ 缺册型：docs/${e.name} 头注缺「**册型**：<台账 / 决策单 / 规划 / 对账>」—— 修法：补两行「册型」＋「读法 · 寿命」（13 族特殊性管理）`)
  else if (!type) failures.push(`③ 册型非法：docs/${e.name} 的册型「${typeLine.replace(/^>\s*/, '').slice(0, 40)}」不在枚举内（台账 / 决策单 / 规划 / 对账）`)
  if (!headLines.some((l) => l.includes('**读法'))) failures.push(`③ 缺读法：docs/${e.name} 头注缺「**读法 · 寿命**」一行—— 修法：写清"怎么读 / 什么时候归档或升常青"`)
}

// ④ 体量门（v2，2026-10-08 按 `13-文档体系重规划（清单与施工）` §13 的裁决重建）：
//    ① 覆盖**全体活跃集**（不再只管规范类）；② **两档红线**——顺序读类 400 / 查询账本类 600；
//    ③ **取消豁免表**：超线者挂「例外名单」（基线 = 2026-10-08 实测，**只许变短**，拆完划掉）；
//    ④ 例外名单与 `清单与施工` §8 的"超线册数"是同一个数——只维护这一张。
//    （旧方案的"规范类 ≤600 + 豁免表"作废；历史基线记录随之作废，不再保留。）
const SEQ_DOCS = [
  'README.md', '00-项目宪章.md', '01-软件说明.md', '02-功能说明.md',
  '03-技术说明.md', '03-技术说明（数据与存储）.md', '03-技术说明（同步 · 检索 · AI）.md', '04-编辑器稳定规范.md',
  '05-版本状态与计划.md', '06-开发协作规范.md', '06-开发协作规范（文档边界与结构）.md', '08-UI设计令牌与跨端一致性.md',
  '09-桌面端UI规范.md', '09-桌面端UI规范（视图与组件）.md',
  '09-桌面端交互规范.md', '09-桌面端交互规范（响应式 · 快捷键 · 双端 · 验收）.md',
  '10-移动端UI与交互规范.md', '10-移动端UI与交互规范（交互 · 平板 · 对照）.md',
  '12-AI提示词.md', '通用AI协作开发规范.md',
]
const LEDGER_DOCS = [
  '07-规则索引与规则理由.md', '07-规则理由（R09 界面与交互）.md', '07-规则理由（R09 窗口与外壳）.md', '07-验收记录.md',
  '07-数据通路矩阵.md', '07-接缝矩阵.md',
  '11-功能链条与使用场景.md', '11-功能链条与使用场景（行为表 · 结构与编辑）.md',
  '11-功能链条与使用场景（行为表 · 界面与交互）.md', '11-功能链条与使用场景（行为表 · 系统与数据）.md',
]
// 例外名单：按主题拆册后**已清空**（每一册都在红线内）。以后超线先在这里挂一行（只许变短），拆完划掉。
const SIZE_EXCEPTIONS = {}
for (const [tier, names, redLine] of [['顺序读类', SEQ_DOCS, 400], ['查询账本类', LEDGER_DOCS, 600]]) {
  for (const name of names) {
    const p = join(docsDir, name)
    if (!existsSync(p)) { failures.push(`④ 缺活跃集文档：docs/${name}（体量门登记表里列着它）`); continue }
    const n = readFileSync(p, 'utf8').split('\n').length - 1
    const baseline = SIZE_EXCEPTIONS[name]
    if (n > redLine) {
      if (baseline == null) failures.push(`④ 体量超线：docs/${name}（${n} 行 > ${tier}红线 ${redLine}）—— 修法：按主题拆册（\`13-文档体系重规划\` 姊妹册 §6）`)
      else if (n > baseline) failures.push(`④ 体量棘轮：docs/${name} 现 ${n} 行、基线 ${baseline}——超线册只许变短（拆完按新值下调基线）`)
    } else if (baseline != null) {
      warnings.push(`④ 例外名单可划掉：docs/${name} 已 ${n} 行 ≤ 红线 ${redLine}`)
    }
  }
}

// ⑤ 登记门（v2，2026-10-09 收口）：`03` §1.1 模块索引 ↔ `app/src` 实际文件——**按路径双向** ＋ **目录级**。
//    旧版按 basename：拦不住"登记在错层"（例如 `suggest.ts` 挂在 ui 表、人却在 `domain/`）。
const doc03 = familyText('03-')
// 隔离 §1.1：从它的标题起到**下一个标题**为止（家族读之后必须这么切——否则会把别册的 §13 测试地图一起吞进来）
const idxPart = doc03.split('### 1.1 模块职责索引')[1].split(/\n#{2,3} /)[0]
// 按路径解析：行里自带 `dir/name.ts` 就用它；否则用所在目录头的 `app/src/<dir>/` 前缀拼（顶层目录头 → ''）。
// M4 起 `<dir>` 也可以挂在 `packages/editor/src/` 下（编辑器包）——两棵树合成一张登记表。
const registeredPaths = new Set()
let curDir = ''
for (const line of idxPart.split('\n')) {
  const heading = line.match(/`(?:app|packages\/editor)\/src\/([^`]*)`/)
  if (heading) { curDir = heading[1].replace(/\/$/, ''); continue }
  const row = line.match(/^\| `([^`]+)` \|/)
  if (row) {
    const name = row[1]
    registeredPaths.add(name.includes('/') ? name : (curDir ? `${curDir}/${name}` : name))
  }
}
const srcFiles = []
const walkSrc = (dir, prefix) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = prefix ? prefix + '/' + e.name : e.name
    if (e.isDirectory()) walkSrc(join(dir, e.name), p)
    else if (/\.(ts|tsx)$/.test(e.name)) srcFiles.push(p)
  }
}
walkSrc(join(root, 'src'), '')
walkSrc(resolve(root, '..', 'packages', 'editor', 'src'), '')
const dirOf = (p) => (p.includes('/') ? p.split('/')[0] : '（顶层）')
for (const f of srcFiles) {
  if (!registeredPaths.has(f)) failures.push(`⑤ 未登记代码文件：app/src/${f} 没在 docs/03 族 §1.1 模块索引里（**按路径**比对）—— 修法：补一行（文件 | 职责），见 06 §5.5`)
}
for (const r of registeredPaths) {
  if (/\.(ts|tsx)$/.test(r) && !srcFiles.includes(r)) failures.push(`⑤ 索引悬空：docs/03 族 §1.1 登记了 \`${r}\`、app/src 里没有这个文件（**登记在错层也会在这里现形**）—— 修法：删掉这一行或改路径`)
}
// 目录级（R2）：磁盘上有文件的每个目录，都要在 §1.1 里出现（靠登记行反推目录集合）
const regDirs = new Set([...registeredPaths].filter((p) => /\.(ts|tsx)$/.test(p)).map(dirOf))
const diskDirs = new Set(srcFiles.map(dirOf))
for (const d of diskDirs) if (!regDirs.has(d)) failures.push(`⑤ 未登记目录：app/src/${d}/ 里有文件、但 §1.1 没有这个目录的登记（文件夹级登记，见 06 §5.5 与 R1/R2）`)
for (const d of regDirs) if (!diskDirs.has(d)) failures.push(`⑤ 目录悬空：§1.1 登记了 app/src/${d}/、磁盘上没有这个目录`)

// ⑥ 行为登记门：代码项名（accept / 测试）里的行为 ID ↔ `11` 行为表（2026-10-05 随 C2 补）
//    基线豁免：非用户行为的基建检查（契约门 / 文档同步）——它们属 06 §7 的门禁家族，不进 11。
const INFRA_IDS = new Set(['PROMPT-DOC-1', 'CONTRACT-PORT-1', 'CONTRACT-SYNC-1', 'CONTRACT-ASSET-1', 'CONTRACT-ASSET-2', 'CONTRACT-ASSET-3', 'CONTRACT-ASSET-4', 'CONTRACT-ASSET-5', 'PROP-MD-1', 'PROP-STORE-1'])
const testTexts = []
const walkTests = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walkTests(p)
    else if (/\.(ts|tsx)$/.test(e.name)) testTexts.push(readFileSync(p, 'utf8'))
  }
}
walkTests(join(root, 'tests'))
const acceptText = readFileSync(join(root, 'scripts', 'accept-editor.mjs'), 'utf8')
const doc11 = familyText('11-')
const idTokens = new Set()
for (const c of [...testTexts, acceptText]) {
  for (const m of c.matchAll(/\b[A-Z][A-Z0-9]{1,}(?:-[A-Z0-9]{2,})+(?:-\d+)\b/g)) {
    const t = m[0]
    if (/^R\d\d-/.test(t) || INFRA_IDS.has(t)) continue
    idTokens.add(t)
  }
}
for (const t of idTokens) {
  if (!doc11.includes(t)) failures.push(`⑥ 行为未登记：代码项名里的 \`${t}\` 在 docs/11 行为表里找不到 —— 修法：补一行行为行（11 §三 对应链）`)
}
// 反向（干净单元格）：`accept:X` / `test:X` 必须真的在对应脚本 / 测试里
const testsAll = testTexts.join('\n')
for (const line of doc11.split('\n')) {
  if (!line.startsWith('|')) continue
  const cells = line.split('|').map((s) => s.trim())
  if (cells.length < 5) continue
  const cell = (cells[cells.length - 2] || '').replace(/`/g, '')
  const m = cell.match(/^(accept|test):([A-Z][A-Z0-9-]*\d)$/)
  if (!m) continue
  const pool = m[1] === 'accept' ? acceptText : testsAll
  if (!pool.includes(m[2])) failures.push(`⑥ 验收悬空：docs/11 的 \`${m[1]}:${m[2]}\` 在${m[1] === 'accept' ? ' accept 脚本' : '测试'}里找不到 —— 修法：补该项或改行`)
}

// ⑦ 规则门：`R04-*` / `R09-*` 的定义 ↔ 理由（2026-10-05 随 C3 补）
//    方向 A（严格）：理由文件里出现的 ID 必须在 04/09/10 有定义（防理由悬空）。
//    方向 B（棘轮）：定义但无理由的数量 ≤ 基线、只许降 —— 新开规则必须同时补理由条目。
const REASON_GAP_BASELINE = 459 // 2026-10-05 实测（存量缺口；只许降）
const ruleText = ['04-', '09-', '10-'].map(familyText).join('\n')
const reasonText = familyText('07-规则')
const idRe = /\bR0[49]-[A-Z]+-\d+[a-z]?\b/g
const defined = new Set([...ruleText.matchAll(idRe)].map((m) => m[0]))
// 「已废弃」条目跳过（`清单与施工` §13 裁决 13：废弃标记住 `07`、规范册只写当前有效）
const reasonLive = reasonText.split('\n').filter((l) => !l.includes('已废弃')).join('\n')
const reasoned = new Set([...reasonLive.matchAll(idRe)].map((m) => m[0]))
for (const d of reasoned) {
  if (!defined.has(d)) failures.push(`⑦ 理由悬空：docs/07-规则索引与规则理由.md 引用的 \`${d}\` 在 04/09/10 里没有定义 —— 修法：改 ID 或删条目`)
}
const gap = [...defined].filter((x) => !reasoned.has(x)).length
if (gap > REASON_GAP_BASELINE) failures.push(`⑦ 规则缺理由（棘轮）：定义无理由 ${gap} > 基线 ${REASON_GAP_BASELINE} —— 新开规则必须同时补理由条目（07-规则索引与规则理由.md）；存量缺口只许降`)

// ⑧ 提示门（不红，2026-10-08 新增）：`清单与施工` §8 的"病的计数"读数 + 定义唯一性。
//    口径写死：删除线 / 状态注按**行**，日期 / 故事词按**次**；基线 = 脚本实测（不手算）。
//    **只许降**——超基线只提示、不阻断（升红的时机由阶段裁决）。
//    2026-10-09 扩面：日期 / 流转读数把 `03-` 族纳入扫描面（原先只有 04/08/09/10/11——
//    03 里写下的裁决日期从这个缝里漏过门）；基线按新面实测更新，`03-` 的日期存量在册、只许降。
const seqText = SEQ_DOCS.map((n) => (existsSync(join(docsDir, n)) ? readFileSync(join(docsDir, n), 'utf8') : '')).join('\n')
const ledText = LEDGER_DOCS.map((n) => (existsSync(join(docsDir, n)) ? readFileSync(join(docsDir, n), 'utf8') : '')).join('\n')
const everText = seqText + '\n' + ledText
const normText = ['03-', '04-', '08-', '09-', '10-', '11-'].map(familyText).join('\n')
const linesWith = (t, re) => t.split('\n').filter((l) => re.test(l)).length
const occ = (t, re) => (t.match(re) ?? []).length
const readings = [
  ['删除线（行）', 38, () => linesWith(everText, /~~/)],
  ['规范 / 契约类历史性日期（次）', 267, () => occ(normText, /20\d\d-\d\d-\d\d/g)],
  ['故事词（次）', 221, () => occ(everText, /改判|撤销|已废弃|原为|曾经/g)],
  // 「进度流转」注（2026-10-09 改口径）：只数流转词（已交付/已开工/已关闭/未开工/已裁决/进行中，排除领域词与属性示例「状态:进行中」）。
  // 「已实现 / 未实现」**不算病**——README 的三种状态标签（已实现 / 原型基线 / 后续规划）本来就写在主文档里。
  ['规范 / 契约类进度流转注（行）', 0, () => linesWith(normText, /已交付|已开工|已关闭|未开工|已裁决|进行中/)
    - linesWith(normText, /状态[:：]\s*进行中|状态可多选 进行中|已关闭放行|进行中的 Promise/)],
]
for (const [label, baseline, count] of readings) {
  const n = count()
  warnings.push(`⑧ ${label}：${n}（基线 ${baseline}${n > baseline ? ' · **超基线**' : ''}）`)
}
const defLine = /^(?:\| |- )(?:\*\*)?`?(R0[49]-[A-Z]+-\d+[a-z]?)/gm
const defPerId = new Map()
for (const n of ['04-', '08-', '09-', '10-', '11-'].flatMap((p) => readdirSync(docsDir).filter((x) => x.startsWith(p) && x.endsWith('.md')))) {
  for (const m of readFileSync(join(docsDir, n), 'utf8').matchAll(defLine)) {
    if (!defPerId.has(m[1])) defPerId.set(m[1], new Set())
    defPerId.get(m[1]).add(n)
  }
}
const restated = [...defPerId.values()].filter((s) => s.size > 1).length
warnings.push(`⑧ 定义唯一性：${restated} 条规则 ID 在 ≥2 份规范册里有**定义行**（基线 0——门的目的是防新增）`)

// ⑨ 禁用词门（提示级，2026-10-08 新体系 §4）：旧口径的写法不许回流。
//    扫描范围 = 常青 ＋ 代码 ＋ 测试 ＋ 原型（**不含 `13-*` 与归档区**——前者是过程件、后者如实保留）。
//    每条 = [旧写法的关键词, 被哪条裁决取代]；口径变了就往这张表加一条。
const DEPRECATED_WORDING = [
  ['侧栏顶部', '侧栏不放搜索 / 新建；入口 = 页面库头部 🔍 / 编辑器顶栏 🔍'],
  ['搜索行', '同上'],
  ['紧凑档侧栏', '同上'],
  ['右侧属性面板', '属性编辑只有一处形态：摘要条原位展开（理由在 `07-规则索引与规则理由`）'],
  ['生成中按当前快照导出', '未采用的一律整块不导出（`R09-EXPORT-2`；理由见 `07-规则理由（R09 界面与交互）`）'],
  ['生成中照当前内容导出', '同上——旧句被「未采用不导出」的裁决覆盖（`R09-EXPORT-2`）'],
  ['属性行 ★ chip', '星标**不进**属性行／属性面板（`R09-PROP-4`；`13-属性区重规划` §0-8）'],
  ['创建/编辑时间与星标', '默认字段 = 标签 / 时间（`R09-PROP-4`）；星标归 ⋯「更多」菜单（`13-属性区重规划` §0-8）'],
]
const deprecatedTargets = [
  ...SEQ_DOCS.map((n) => join(docsDir, n)),
  ...LEDGER_DOCS.filter((n) => !n.startsWith('07-规则')).map((n) => join(docsDir, n)),
  ...files.filter((f) => /[\\/](src|tests|scripts)[\\/]/.test(f) && !f.endsWith(SELF)),
]
for (const [word, why] of DEPRECATED_WORDING) {
  const hits = deprecatedTargets.filter((f) => existsSync(f) && readFileSync(f, 'utf8').includes(word))
    .map((f) => f.replace(root + '/', 'app/').replace(/\\/g, '/'))
  if (hits.length > 0) warnings.push(`⑨ 禁用词「${word}」残留 ${hits.length} 处：${hits.slice(0, 4).join(' / ')}${hits.length > 4 ? ' …' : ''} —— ${why}`)
}

// ⑩ 结构读数（提示级，2026-10-09）：K3/D6 的"先量后收"面——`ui/` 内部互相引用、`application` ↔ `adapters` 两方向。
const uiSrcFiles = files.filter((f) => /[\\/]src[\\/]ui[\\/]/.test(f) && /\.tsx?$/.test(f))
const uiCrossRef = uiSrcFiles.filter((f) => /from\s+['"]\.\//.test(readFileSync(f, 'utf8'))).length
const appAdapter = files.filter((f) => /[\\/]src[\\/]application[\\/]/.test(f) && /\.tsx?$/.test(f))
  .filter((f) => /from\s+['"][^'"]*\/adapters\//.test(readFileSync(f, 'utf8'))).length
warnings.push(`⑩ 结构读数：\`ui/\` 内部互相引用 ${uiCrossRef}/${uiSrcFiles.length} 个文件（**读数不是病**——只为看内部耦合）· \`application\` 侧引用 \`adapters/\` ${appAdapter} 个文件（**D6 已收口：0 且已立边界门 ⑥**，2026-10-09）`)

// ⑪ 头注纪律门（阻断；2026-10-09 由用户点名补——「头注越写越长、沿革堆在引用块里」这个病靠人记失败过两次，
//    改成机器看住）：标题下的**第一个引用块**只写"现在是什么样"——沿革 / 裁决经过 / 「更新」清单 / 「此前……」链
//    一律搬末尾「并入与修订记录」或 `07`（`06` §5.9 第 3 条）。
//    判据（客观、低误报）：头注块（前 25 行内的第一个连续 `>` 块）里
//      ① 历史性日期 > 2 处 → 红；② 出现「此前」→ 红。
//    允许的两处 = 「状态」里的登记 / 关闭日 + 「最近一次更新」的那一个日期。
const headNoteFiles = files.filter((f) => {
  const p = f.replace(/\\/g, '/')
  return p.endsWith('.md') && (p.includes('/docs/') || p.includes('/next/'))
})
for (const file of headNoteFiles) {
  const lines = readFileSync(file, 'utf8').split('\n').slice(0, 25)
  const start = lines.findIndex((l) => l.startsWith('>'))
  if (start < 0) continue
  let end = start
  while (end + 1 < lines.length && (lines[end + 1].startsWith('>') || lines[end + 1].trim() === '')) end += 1
  const block = lines.slice(start, end + 1).filter((l) => l.startsWith('>')).join('\n')
  const rel = file.replace(root + '/', 'app/').replace(/\\/g, '/')
  const dates = (block.match(/20\d{2}-\d{2}-\d{2}/g) ?? []).length
  if (dates > 2) failures.push(`⑪ 头注堆沿革：${rel} 的头注块里有 ${dates} 处日期（上限 2 = 状态里的登记日 + 「最近一次更新」）—— 修法：沿革 / 裁决经过搬该册末尾「并入与修订记录」或 \`07\`（\`06\` §5.9 第 3 条）`)
  if (block.includes('此前')) failures.push(`⑪ 头注带「此前」链：${rel} —— 头注只留最近一次更新，旧轮次明细在各自条目 / 末尾记录里（\`06\` §5.9 第 3 条）`)
}

// ⑫ 规范正文不夹带日期括注（阻断；2026-10-10 用户点名补——`04` / `09` / `10` 族的规则条文里混了「大量的裁决记录」，
//    清理见同一批提交）。判据：这几族（规范册）里出现「（…20xx-xx-xx…）」形式的括注即红。
//    合法住处 = 末尾「修订记录」（不带括注）· `07` 族 / 台账 / 归档（不在扫描范围）。
//    2026-10-13 收严两处：① 原 `[^（）]` 不吃嵌套括号 ⇒「（…裁决：…（内层）…）」整类漏网——允许一层内嵌；
//    ② 原豁免按「不动」二字，正文「壳布局不动（`#8`，2026-10-12）」被误放——改为按判据例句的特征串「5 - 3」锁定。
const dateParen = /（(?:[^（）]|（[^（）]*）){0,300}20\d{2}-\d{2}-\d{2}(?:[^（）]|（[^（）]*）){0,300}）/
for (const file of files.filter((f) => /[\\/]docs[\\/](04|09|10)-.*\.md$/.test(f.replace(/\\/g, '/')))) {
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((ln, i) => {
    if (ln.includes('5 - 3')) return // 判据例句豁免（「句中 `2026-10-04`、5 - 3 不动」——讲解输入规则的句子，不是裁决记录）
    const m = ln.match(dateParen)
    if (m) failures.push(`⑫ 规范正文夹带日期括注：${file.replace(root + '/', 'app/').replace(/\\/g, '/')}:${i + 1} ${m[0].slice(0, 50)} —— 修法：日期搬末尾「修订记录」或 07 族（06 §5.9 第 3 条）`)
  })
}

// ⑬ 数据通路矩阵：格子不许空（阻断）。空 = 没人想过（红）；`❓` = 想过、记着要查（读数，棘轮只许降）。
//    「功能断裂」不住在主题里、住在实体 × 通路的交叉口——这条门把"没人想过"变成红灯（`07-数据通路矩阵`）。
const matrixPath = join(docsDir, '07-数据通路矩阵.md')
if (existsSync(matrixPath)) {
  const rows = readFileSync(matrixPath, 'utf8').split('\n')
    .filter((ln) => ln.startsWith('|') && !/^\|[\s:|-]+\|$/.test(ln))
  let asked = 0, blanks = 0
  for (const ln of rows) {
    for (const c of ln.split('|').slice(1, -1)) {
      if (c.trim() === '') blanks += 1
      if (c.includes('❓')) asked += 1
    }
  }
  if (blanks > 0) failures.push(`⑬ 通路矩阵有空格子：${blanks} 处 —— 空 = 没人想过；填指针 / 不做（理由）/ G-编号，或先写 ❓（见该册「怎么读」）`)
  warnings.push(`⑬ 通路矩阵读数：待查 ❓ ${asked} 格（棘轮只许降）`)
}

// ⑭ 台账「落点」列（阻断：每条 `D-` 行的表格必须有「| 落点 |」行；`❓ 待补` 计数进读数，棘轮只许降）。
//    为什么：台账只写"发现了什么"不够——「有没有回写进常青册」必须一眼可查（用户 2026-10-10 点名）。
const ledgerPath = join(docsDir, '13-偏差台账.md')
if (existsSync(ledgerPath)) {
  const ledgerLines = readFileSync(ledgerPath, 'utf8').split('\n')
  let cur = null, has = false, rows = 0, asked = 0
  const closeD = () => {
    if (!cur) return
    rows += 1
    if (!has) failures.push(`⑭ 台账缺落点：${cur} 的表格没有「| 落点 |」行 —— 修法：补一行「落点」（提交号 / 条文 ID / accept: / ❓ 待补）`)
  }
  for (const ln of ledgerLines) {
    if (ln.startsWith('### D-')) { closeD(); cur = (ln.match(/D-\d+/) ?? [''])[0]; has = false; continue }
    if (cur && (ln.startsWith('### ') || ln.startsWith('## '))) { closeD(); cur = null; continue }
    if (cur && ln.startsWith('| 落点 |')) { has = true; if (ln.includes('❓') || ln.includes('未落')) asked += 1 }
  }
  closeD()
  warnings.push(`⑭ 台账落点读数：${rows} 条 D 行 · 待落（❓ / 未落待修）${asked} 条（棘轮只许降）`)
}

// ⑮ § 引用可解析（阻断；2026-10-13 加，来源：文档体系核对——「节号指错」曾是没人看得见的一类漂移）：
//    `` `NN` §N `` / `` `NN-名` §N `` / `` `NN（限定词）` §N `` 与反引号包 § 的同册引用——「节号」也要指到真实存在的节。
//    解析：族 = 反引号里的编号前缀（无前缀时 = 当前文件自身族）；号 = 阿拉伯（可多级）或中文数字；
//    族内任一册有以该号开头的标题行（#~####）即算解析（节号跨册连续——族查，不按单册）。
//    不查：通配写法（`§4.x`）· 条目号（`§0-8`，带连字符）· 带「（已归档）」的族引用（归档件不进解析集）·
//    「原 `NN` §N」（历史指涉——描述"曾经在哪"，不指向现状）。
//    已知悬空挂例外（只许减）：当前为空（2026-10-13 收口时两条已随本轮修复：`05` §6.6 → §8、`10` §4.2 → §3）。
const SEC_REF_EXCEPTIONS = new Set([
])
const secRefExceptionUsed = new Set()
const CN2AR = { 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9', 十: '10', 十一: '11', 十二: '12' }
const AR2CN = Object.fromEntries(Object.entries(CN2AR).map(([k, v]) => [v, k]))
const famTextCache = new Map()
const famTextOf = (fam) => {
  if (!famTextCache.has(fam)) {
    famTextCache.set(fam, readdirSync(docsDir)
      .filter((n) => n.startsWith(fam + '-') && n.endsWith('.md'))
      .sort()
      .map((n) => readFileSync(join(docsDir, n), 'utf8'))
      .join('\n'))
  }
  return famTextCache.get(fam)
}
const secHeadingRe = (num) => {
  const cands = [num]
  if (CN2AR[num]) cands.push(CN2AR[num])
  if (AR2CN[num]) cands.push(AR2CN[num])
  const alts = cands.map((c) => c.replace(/\./g, '\\.')).join('|')
  return new RegExp(`^#{1,4}\\s*(?:${alts})(?=[\\s、.．·（(]|$)`, 'm')
}
const secRefQuoted = /`(\d\d)(?:-[^`\n]*)?(?:（[^`\n]*）)?`[^\S\n]*§[^\S\n]*(\d+(?:\.\d+)*|[一二三四五六七八九十]+)/g
const secRefBare = /`§[^\S\n]*(\d+(?:\.\d+)*|[一二三四五六七八九十]+)`/g
const mdScannable = scannable.filter((f) => f.endsWith('.md'))
const relOf = (f) => f.replace(root + '/', 'app/').replace(/\\/g, '/')
for (const file of mdScannable) {
  const raw = readFileSync(file, 'utf8')
  const ownFam = (file.match(/(\d\d)-/) ?? [])[1]
  const refs = []
  for (const m of raw.matchAll(secRefQuoted)) {
    if (m[0].includes('归档')) continue
    if (raw.slice(Math.max(0, m.index - 4), m.index).includes('原')) continue // 「原 `NN` §N」＝历史指涉，不指向现状
    refs.push({ fam: m[1], num: m[2], tail: raw.slice(m.index + m[0].length, m.index + m[0].length + 3), at: m.index })
  }
  if (ownFam) {
    for (const m of raw.matchAll(secRefBare)) {
      const at = m.index
      const lead = raw.slice(Math.max(0, at - 4), at)
      if (lead.includes('原')) continue
      refs.push({ fam: ownFam, num: m[1], tail: raw.slice(at + m[0].length, at + m[0].length + 3), at })
    }
  }
  for (const r of refs) {
    if (r.tail.startsWith('-')) continue // 条目号（§0-8）不是节号
    if (r.tail.startsWith('.') && !/^\d/.test(r.tail.slice(1, 2))) continue // 通配（§4.x）
    const famText = famTextOf(r.fam)
    if (famText === '') continue // 族无活跃件（防御；正常不出现）
    if (!secHeadingRe(r.num).test(famText)) {
      const key = `${file.split(/[\\/]/).pop()}|${r.fam}|${r.num}`
      if (SEC_REF_EXCEPTIONS.has(key)) { secRefExceptionUsed.add(key); continue }
      failures.push(`⑮ § 引用悬空：${relOf(file)} 引用 \`${r.fam}\` §${r.num}，但该族的标题里没有这个节 —— 修法：改号或改引用口径（单源；\`06\` §5.9 第 9 条）`)
    }
  }
}
for (const k of SEC_REF_EXCEPTIONS) {
  if (!secRefExceptionUsed.has(k)) warnings.push(`⑮ 例外可划掉：${k} 已不再悬空——把 \`SEC_REF_EXCEPTIONS\` 的这条删掉`)
}

// ⑯ 台账编号唯一（阻断；2026-10-13 加）：`D-*` 的定义行不许重号——「只增不改、不复用」从纪律变判据
//    （2026-10-11 真出过两条 `D-068`）。`G-*` 现为表格行形态、暂不设唯一性判据（收形态时再并）。
{
  const ledgerLines = readFileSync(join(docsDir, '13-偏差台账.md'), 'utf8').split('\n')
  const seenD = new Map()
  ledgerLines.forEach((ln, i) => {
    const m = ln.match(/^###\s*(D-\d+)/)
    if (!m) return
    if (seenD.has(m[1])) failures.push(`⑯ 台账编号重号：${m[1]} 在 docs/13-偏差台账.md 出现两次（第 ${seenD.get(m[1])} 行 / 第 ${i + 1} 行）—— 「只增不改、不复用」：后写的一条顺延到下一个空号`)
    else seenD.set(m[1], i + 1)
  })
}

// ⑰ 篇内标题序号唯一（阻断；2026-10-13 加）：同一册里 `## N、` / `## N.`（阿拉伯或中文数字）的**序号**不许重复——
//    重号会让 `§N` 引用指向两处（V3 记录里真出过两个 `## 四` / 两个 `## 五`）。
const h2seq = /^##\s+/
for (const file of mdScannable) {
  const seenH = new Map()
  readFileSync(file, 'utf8').split('\n').forEach((ln, i) => {
    if (!h2seq.test(ln)) return
    const first = ln.slice(3).split(/[\s、．·（(：:]/)[0].replace(/[.．]$/, '')
    if (!/^(?:\d+|[一二三四五六七八九十]+)(?:\.\d+)*$/.test(first)) return
    if (seenH.has(first)) failures.push(`⑰ 标题重号：${relOf(file)} 第 ${i + 1} 行的 \`## ${first}\` 序号与第 ${seenH.get(first)} 行重复——改其一（编唯一序号或去掉编号）`)
    else seenH.set(first, i + 1)
  })
}

// ⑱ 门禁清单一致（阻断；2026-10-13 加）：`package.json` 的 `check` 链 ↔ `06` §7——
//    加门 / 删门必须同批改清单；`06` §7 与 `AGENTS.md` 里引用的 `pnpm <命令>` 必须真实存在。
//    为什么：清单是手抄副本就会漂移——`check:copy` / `check:coverage` 加进链路时两处清单都没跟上。
const pkgJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const scriptNames = new Set(Object.keys(pkgJson.scripts ?? {}))
const chainCmds = (pkgJson.scripts?.check ?? '')
  .split('&&').map((s) => s.trim().match(/^pnpm\s+([^\s]+)$/)?.[1]).filter(Boolean)
const gateSection = readFileSync(join(docsDir, '06-开发协作规范.md'), 'utf8').split(/^## 7\./m)[1]?.split(/^## 8\./m)[0] ?? ''
for (const cmd of chainCmds) {
  if (!gateSection.includes(cmd)) failures.push(`⑱ 门禁清单过时：\`pnpm check\` 链里的 \`${cmd}\` 没在 docs/06-开发协作规范.md §7 出现——加门 / 删门必须同批改本节`)
}
const PNPM_BUILTIN = new Set(['ls', 'exec', 'audit', 'install', 'add', 'remove', 'run', 'dlx', 'why', 'outdated'])
for (const [label, text] of [
  ['docs/06-开发协作规范.md §7', gateSection],
  ['AGENTS.md', existsSync(join(root, '..', 'AGENTS.md')) ? readFileSync(join(root, '..', 'AGENTS.md'), 'utf8') : ''],
]) {
  for (const m of text.matchAll(/pnpm\s+([a-z][a-z0-9]*(?::[a-z0-9-]+)*)(?![\w-])/g)) {
    const cmd = m[1]
    if (PNPM_BUILTIN.has(cmd) || scriptNames.has(cmd)) continue
    failures.push(`⑱ 命令不存在：${label} 引用了 \`pnpm ${cmd}\`，但 app/package.json 的 scripts 里没有这个命令—— 修法：改引用或补脚本`)
  }
}

// ④b 13 族体量（2026-10-10 补）：**按册型分档**——台账类 600 / 决策单 · 规划 · 对账类 400；
//    例外名单只许变短（存量超线者挂基线，拆完划掉）。为什么补：13 族此前**不在任何体量档里**（819 行没人管）。
const TIER_13_EXCEPTIONS = { "13-偏差台账.md": 691 } // 2026-10-26 起超线（D-092…D-096 连续登记；按主题拆册随下次台账整备，基线只许变短）
let tier13Max = { name: '', n: 0 }
for (const e of readdirSync(docsDir, { withFileTypes: true })) {
  if (!e.isFile() || !e.name.startsWith('13-') || !e.name.endsWith('.md') || e.name === '13-归档.md') continue
  const raw = readFileSync(join(docsDir, e.name), 'utf8')
  const type = raw.split('\n').slice(0, 15).join('\n').match(VOL_TYPE_RE)?.[1]
  if (!type) continue
  const redLine = type === '台账' ? 600 : 400
  const n = raw.split('\n').length - 1
  if (n > tier13Max.n) tier13Max = { name: e.name, n }
  const base = TIER_13_EXCEPTIONS[e.name]
  if (n > redLine) {
    if (base == null) failures.push(`④b 13 族体量超线：docs/${e.name}（${n} 行 > ${type}类红线 ${redLine}）—— 修法：按主题拆册，或登记进例外名单（只许变短）`)
    else if (n > base) failures.push(`④b 体量棘轮：docs/${e.name} 现 ${n} 行、基线 ${base}——只许变短`)
  } else if (base != null) {
    warnings.push(`④b 例外名单可划掉：docs/${e.name} 已 ${n} 行 ≤ ${redLine}`)
  }
}
if (tier13Max.name) warnings.push(`④b 13 族体量读数：最大 ${tier13Max.name} ${tier13Max.n} 行（台账类红线 600 / 其余 400；例外名单只许变短）`)

// ⑥b 行为表锚覆盖读数（棘轮：无锚行只许降，基线 42——2026-10-10 实测）。
//    为什么：`11` 的锚列（`accept:` / `test:` / `cargo:` / `人工:`）就是"这条行为有没有东西看着它"。
//    无锚行 = 覆盖率缺口；这是「测试用例报告」里唯一有信息量的那半（哪里没测），改成机器算。
const BEHAVIOR_DOCS = readdirSync(docsDir).filter((n) => n.startsWith('11-功能链条与使用场景（行为表'))
let bRows = 0, bAnchored = 0
for (const n of BEHAVIOR_DOCS) {
  for (const ln of readFileSync(join(docsDir, n), 'utf8').split('\n')) {
    if (!/^\| `/.test(ln)) continue
    bRows += 1
    if (/accept:|test:|cargo:|人工:/.test(ln)) bAnchored += 1
  }
}
const bGap = bRows - bAnchored
if (bGap > 42) failures.push(`⑥b 无锚行为行新增：现 ${bGap} 行（基线 42）—— 新行为必须同时给锚（accept:/test:/cargo:/人工:），棘轮只许降`)
else warnings.push(`⑥b 行为表锚覆盖读数：${bRows} 行 · 有锚 ${bAnchored} · 无锚 ${bGap}（棘轮只许降，基线 42）`)

if (warnings.length > 0) {
  console.log(`文档门读数（提示，不阻断 · ${warnings.length} 条）：`)
  for (const w of warnings) console.log('  ' + w)
}

if (failures.length > 0) {
  console.error('文档门（docs:check）：发现 ' + failures.length + ' 处问题。')
  for (const f of failures) console.error('  ' + f)
  console.error('修法：`06` §5.6.2「引用即入库」与 §5.5 登记义务；重构经过见 `13-归档.md`。')
  process.exit(1)
}

console.log(`文档门（docs:check）：引用 / 头注 / 体量 / 登记 / 规则——全过（扫描 ${files.length} 个文件）。`)
