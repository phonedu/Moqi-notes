/*
 * 版本一致性门禁（docs/06 §7）。
 * 版本号只有一个真相源：app/package.json 的 version。
 * 本脚本校验另外三处必须跟随它，任何一处漂移都让 `pnpm check` 失败：
 *   tauri.conf.json 指向 package.json（不能写死版本号）
 *   Cargo.toml 的 [package] version 与它一致
 *   CHANGELOG.md 有该版本的段落
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseChangelog } from '../src/changelog'

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const STAGE_RE = /^V\d+[a-z]?$/

const read = (relative: string) => readFileSync(resolve(APP_ROOT, relative), 'utf8')
const problems: string[] = []

const pkg = JSON.parse(read('package.json')) as { version?: string; moqi?: { stage?: string } }
const version = pkg.version ?? ''
const stage = pkg.moqi?.stage ?? ''

if (!SEMVER_RE.test(version)) {
  problems.push(`package.json 的 version「${version}」不是语义化版本号`)
}
if (!STAGE_RE.test(stage)) {
  problems.push(`package.json 的 moqi.stage「${stage}」不是阶段号（形如 V2a）`)
}

const tauri = JSON.parse(read('src-tauri/tauri.conf.json')) as { version?: unknown }
if (typeof tauri.version !== 'string' || tauri.version.trim() === '') {
  problems.push('tauri.conf.json 缺少 version')
} else if (tauri.version.startsWith('.')) {
  const target = resolve(APP_ROOT, 'src-tauri', tauri.version)
  if (target !== resolve(APP_ROOT, 'package.json')) {
    problems.push(`tauri.conf.json 的 version 指向了 ${tauri.version}，必须指向 ../package.json`)
  }
} else {
  problems.push(`tauri.conf.json 的 version 是写死的「${tauri.version}」，必须改成 "../package.json"`)
}

const cargoPackage = /\[package\]([\s\S]*?)(?=\n\[|$)/.exec(read('src-tauri/Cargo.toml'))?.[1] ?? ''
const cargoVersion = /^\s*version\s*=\s*"([^"]+)"/m.exec(cargoPackage)?.[1]
if (cargoVersion !== version) {
  problems.push(`Cargo.toml 的 [package] version「${cargoVersion ?? '缺失'}」与 package.json「${version}」不一致`)
}

const releases = parseChangelog(read('CHANGELOG.md'))
if (!releases.some((release) => release.version === version)) {
  problems.push(`CHANGELOG.md 缺少「${version}」段落，最新一条是「${releases[0]?.version ?? '无'}」`)
}

if (problems.length > 0) {
  console.error('✗ 版本一致性检查未通过：')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error('提示：版本号只改 app/package.json，同时补 CHANGELOG.md 段落（docs/06 §10）。')
  process.exitCode = 1
} else {
  console.log(`✓ 版本一致：${version}（阶段 ${stage}），CHANGELOG 有对应段落`)
}
