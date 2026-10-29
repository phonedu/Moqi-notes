import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 公开面闸门：保证这个仓库里只出现与软件本身有关的内容。
 *
 * 两类规则：
 * - 硬禁词：仓库协作方式、开发过程称呼、外部站点、生成式配图等——出现即红。
 * - 存量编号：开发期的追溯编号与流程词（规则 ID、文档路径、章节号等）按基线**只许下降**；
 *   新写的注释一律用自包含说明，不再引用仓库外的编号或文档。
 *
 * 词表在本文件里按字符拼出来，避免扫描自身时命中——没有自豁免。
 * 精确的私人词表仍由 `MOQI_PRIVACY_EXTRA` 注入，两侧各管一段。
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const tracked = execSync('git ls-files -z', { cwd: repoRoot }).toString().split('\x00').filter(Boolean)
const SKIP = /(^|\/)(node_modules|dist|coverage|release-assets|\.git)(\/|$)/

const joinChars = (parts) => parts.join('')

const HARD = [
  ['双', '仓'],
  ['私', '有', '仓'],
  ['公', '开', '仓'],
  ['内', '部', '账', '本'],
  ['内', '部', '开', '发', '仓'],
  ['内', '部', '文', '档'],
  ['AI ', '协', '作'],
  ['AI', '协', '作'],
  ['官', '网'],
  ['web', 'site'],
  ['AI ', '绘', '画'],
  ['AI', '绘', '画'],
  ['老', '板'],
  ['飞', '书'],
  ['monkey', 'code'],
  ['OXF', '-AN10'],
  ['PKT', '02205'],
].map(joinChars)

const RATCHET = [
  { id: 'D', re: /D-\d{3,}/g },
  { id: 'R09', re: new RegExp(joinChars(['R', '0', '9', '-']), 'g') },
  { id: 'R04', re: new RegExp(joinChars(['R', '0', '4', '-']), 'g') },
  { id: 'docs_ref', re: /docs\/(?:0\d|1\d)/g },
  { id: 'section_ref', re: /§\s?\d/g },
  { id: 'ledger', re: new RegExp(joinChars(['台', '账']), 'g') },
  { id: 'verdict', re: new RegExp(joinChars(['裁', '决']), 'g') },
  { id: 'acceptance', re: new RegExp(joinChars(['验', '收']), 'g') },
  { id: 'stage', re: new RegExp(joinChars(['阶', '段']), 'g') },
  { id: 'prototype', re: new RegExp(joinChars(['原', '型']), 'g') },
  { id: 'design_draft', re: new RegExp(joinChars(['设', '计', '稿']), 'g') },
]

const baselinePath = join(dirname(fileURLToPath(import.meta.url)), 'public-face-baseline.json')
let baseline = { counts: {} }
if (existsSync(baselinePath)) {
  try {
    baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
  } catch {
    console.error('公开面闸门：public-face-baseline.json 不是合法 JSON，拒绝放行')
    process.exit(1)
  }
}

const errors = []
const counts = Object.fromEntries(RATCHET.map(({ id }) => [id, 0]))
const samples = Object.fromEntries(RATCHET.map(({ id }) => [id, []]))

for (const rel of tracked) {
  if (SKIP.test(rel)) continue
  const full = join(repoRoot, rel)
  if (!existsSync(full)) continue
  let raw
  try { raw = readFileSync(full) } catch { continue }
  if (raw.includes(0)) continue
  let s
  try { s = raw.toString('utf8') } catch { continue }

  for (const term of HARD) {
    if (rel.includes(term) || s.includes(term)) errors.push(`${rel} → 「${term}」`)
  }

  for (const { id, re } of RATCHET) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(s)) !== null) {
      counts[id] += 1
      if (samples[id].length < 3) {
        const line = s.slice(0, m.index).split('\n').length
        samples[id].push(`${rel}:${line}`)
      }
    }
  }
}

if (process.argv.includes('--count')) {
  console.log(JSON.stringify({ generated: new Date().toISOString().slice(0, 10), counts }, null, 2))
  process.exit(0)
}

for (const { id } of RATCHET) {
  const allowed = baseline.counts?.[id]
  if (typeof allowed !== 'number') {
    errors.push(`基线缺少 ${id}（先跑 --count 生成基线）`)
    continue
  }
  if (counts[id] > allowed) {
    errors.push(`${id} 新增 ${counts[id] - allowed} 处（当前 ${counts[id]}，基线 ${allowed}）：${samples[id].join(' / ')}`)
  }
}

if (errors.length) {
  console.error('公开面闸门：命中 ' + errors.length + ' 处，禁止提交——')
  console.error(errors.slice(0, 20).map((x) => '  ' + x).join('\n'))
  console.error('说明：新注释请写自包含的解释（为什么这样做、约束是什么），不要引用仓库外的编号或文档。')
  process.exit(1)
}

const lowered = RATCHET.filter(({ id }) => counts[id] < baseline.counts[id]).map(({ id }) => `${id} ${counts[id]}<${baseline.counts[id]}`)
console.log(`公开面闸门：硬禁词零命中 ✓；存量编号均在基线内 ✓${lowered.length ? `（可下调：${lowered.join(' · ')}）` : ''}`)
