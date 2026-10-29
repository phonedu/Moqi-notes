import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 隐私泄漏闸门（公开仓专用；§7.2「后防」）：扫描全部 git 追踪文件，命中违禁模式即红、退出码 1。
 * 挂在 `pnpm check` 链尾 + 本地 .git/hooks/pre-push —— **混入私人内容时推送被拦**，不靠人记性。
 * 免责（有意保留、不算命中）：`C:\Users\x\`（saf.rs 测试化名）、规则编号引用（R04/R09/D-数字/M-数字，落点 docs/design/EDITOR-RULES.md）。
 * 私人词表不在公开仓：精确内部称呼 / 设备 / 账号由 `MOQI_PRIVACY_EXTRA` 注入（私有 pre-push / CI secret）。
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const tracked = execSync('git ls-files -z', { cwd: repoRoot }).toString().split('\x00').filter(Boolean)
const SKIP = /(^|\/)(node_modules|dist|coverage|release-assets|\.git)(\/|$)/

// 违禁模式 = 命中即红。**公开仓不内置私人词表**：精确内部称呼 / 设备 / 账号
// 走 `MOQI_PRIVACY_EXTRA`（JSON: [{ "re": "...", "why": "..." }]），由私有 pre-push / CI secret 注入。
const FORBIDDEN = [
  { re: /D:[\\/]|E:[\\/]/, why: '本机盘符绝对路径' },
  { re: /C:[\\/]Users[\\/](?!x[\\/])/, why: '本机用户目录（C:\\Users\\x\\ 为化名豁免）' },
  { re: /[A-Za-z]:[\\]{1,2}Project[\\]{1,2}Moqi/i, why: '本机私有仓路径' },
  { re: /@(outlook|gmail|qq)\.com/i, why: '私人邮箱域名' },
  { re: /192\.168\.\d+\.\d+/, why: '局域网地址' },
]
const extraRaw = process.env.MOQI_PRIVACY_EXTRA
if (extraRaw) {
  try {
    for (const item of JSON.parse(extraRaw)) {
      if (item && typeof item.re === 'string') FORBIDDEN.push({ re: new RegExp(item.re, 'i'), why: item.why ?? '私人词表' })
    }
  } catch {
    console.error('隐私闸门：MOQI_PRIVACY_EXTRA 不是合法 JSON，拒绝放行')
    process.exit(1)
  }
}

// 私有仓文档引用 = 提示级（编号引用已在 docs/design/EDITOR-RULES.md 说明为内部开发仓；docs/04 为有意保留）
const DOCREF = /docs\/(0[0135679]|1[0-9])[-（]/

const errors = []
const warns = []
for (const rel of tracked) {
  if (SKIP.test(rel)) continue
  const full = join(repoRoot, rel)
  if (!existsSync(full)) continue
  let raw
  try { raw = readFileSync(full) } catch { continue }
  if (raw.includes(0)) continue
  let s = ''
  try { s = raw.toString('utf8') } catch { continue }
  for (const { re, why } of FORBIDDEN) {
    const m = rel.match(re) ?? s.match(re)
    if (m) errors.push(`${rel} → 「${m[0]}」（${why}）`)
  }
  if (DOCREF.test(s)) warns.push(rel)
}
// 历史扫描：提交过、后来删掉的内容也不许留在公开历史里（tag 另查；HEAD 覆盖 main 主线）。
// 通用盘符（D/E 盘）不扫历史——测试 fixture 用合成落点，不是本机路径；
// 历史只查真正的私人面：私有仓根 / 用户目录 / 邮箱域 / 局域网 / MOQI_PRIVACY_EXTRA。
const HISTORY_FORBIDDEN = FORBIDDEN.filter(({ why }) => why !== '本机盘符绝对路径')
const history = execSync('git log -p HEAD --pretty=format:', { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 }).toString()
for (const { re, why } of HISTORY_FORBIDDEN) {
  const m = history.match(re)
  if (m) errors.push(`历史 → 「${m[0]}」（${why}）`)
}

if (errors.length) {
  console.error('隐私闸门：命中 ' + errors.length + ' 处，禁止推送——')
  console.error(errors.slice(0, 20).map((x) => '  ' + x).join('\n'))
  process.exit(1)
}
console.log(`隐私闸门：${tracked.length} 个追踪文件 + 提交历史扫描零命中 ✓（内部文档引用提示 ${warns.length} 个文件，属有意保留的编号体系，落点 docs/design/EDITOR-RULES.md）`)
